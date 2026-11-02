"""Exercise the real full-app entry without writing inside an installation directory."""
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import urllib.request


def test_full_entry_places_log_and_databases_in_isolated_application_data(tmp_path):
    installation = tmp_path / 'installation'
    installation.mkdir()
    sentinel = installation / 'backend.log'
    sentinel.write_bytes(b'installed resource must stay unchanged\n')
    data = tmp_path / 'application-data'
    root = Path(__file__).resolve().parents[2]
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONUTF8='1',
                       HF_HUB_OFFLINE='1', AUTOCLIP_QA_DISABLED='1',
                       AUTOCLIP_PARENT_PID=str(os.getpid()))
    environment.pop('LOG_FILE', None)  # A real desktop launch supplies no inherited test log.
    code = "import sys,runpy;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('backend.workbench',run_name='__main__')"
    process = subprocess.Popen([sys.executable, '-c', code, str(root), '--full-app', '--port', '0', '--data-dir', str(data)],
                               cwd=installation, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
    lines = queue.Queue()
    def read():
        for line in process.stdout:
            lines.put(line)
    threading.Thread(target=read, daemon=True).start()
    port = None
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            line = lines.get(timeout=max(.1, deadline - time.monotonic()))
            if line.startswith('WORKBENCH_PORT='):
                port = int(line.split('=')[1])
                break
        assert port, 'full entry did not start'
        # Bypass inherited system proxies for this strictly loopback assertion.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}/api/workbench/session', timeout=10) as response:
            assert response.status == 200
        assert (data / 'logs' / 'backend.log').is_file()
        assert (data / 'classic.sqlite3').is_file()
        assert (data / 'workbench.sqlite3').is_file()
        assert sentinel.read_bytes() == b'installed resource must stay unchanged\n'
        assert sorted(path.name for path in installation.iterdir()) == ['backend.log']
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
