"""Start the independent local workbench with no externally reachable listener."""
import argparse
import os
from pathlib import Path
import sys
import threading


def main():
    parser = argparse.ArgumentParser(description='直播切片本机工作台')
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--frontend', type=Path)
    parser.add_argument('--port', type=int, default=3102)
    parser.add_argument('--full-app', action='store_true', help='启动含原 AutoClip 功能的完整 CClip')
    args = parser.parse_args()
    if args.frontend is None:
        args.frontend = Path(__file__).resolve().parents[2] / 'frontend' / ('dist-cclip' if args.full_app else 'dist-workbench')
    if args.data_dir:
        root = args.data_dir.resolve()
    elif sys.platform == 'win32':
        root = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'AutoClipWorkbench'
    elif sys.platform == 'darwin':
        root = Path.home() / 'Library' / 'Application Support' / 'AutoClipWorkbench'
    else:
        root = Path.home() / '.local' / 'share' / 'AutoClipWorkbench'
    os.environ.update(AUTOCLIP_DATA_DIR=str(root), AUTOCLIP_LLM_CONCURRENCY='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    if args.full_app:
        # Match the original desktop entry: installed resources may be read-only.
        (root / 'logs').mkdir(parents=True, exist_ok=True)
        os.environ.update(AUTOCLIP_CCLIP_FULL_APP='1', AUTOCLIP_DESKTOP_MODE='true', AUTOCLIP_MODE='desktop',
                          AUTOCLIP_APP_DIR=str(root), DATABASE_URL=f'sqlite:///{(root / "classic.sqlite3").as_posix()}',
                          LOG_FILE=str(root / 'logs' / 'backend.log'))
        for name in ('SENTRY_DSN', 'VITE_PUBLIC_SENTRY_DSN', 'AUTOCLIP_POSTHOG_KEY', 'VITE_PUBLIC_POSTHOG_KEY'):
            os.environ.pop(name, None)
    from .runtime import AlreadyRunning, data_lease
    try:
        with data_lease(root):
            serve(root, args)
    except AlreadyRunning:
        print('WORKBENCH_ALREADY_RUNNING', flush=True)


def serve(root, args):
    bundled = os.environ.get('CCLIP_BUNDLED_RESOURCES')
    if bundled:
        from .runtime import prepare_bundled_runtime
        prepare_bundled_runtime(Path(bundled), root)
    if args.full_app:
        from backend.cclip.app import create_app
    else:
        from .app import create_app
    import uvicorn
    config = uvicorn.Config(create_app(root, args.frontend), host='127.0.0.1', port=args.port, access_log=False)
    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                print(f'WORKBENCH_PORT={listener.getsockname()[1]}', flush=True)
    server = ReadyServer(config)
    listener = config.bind_socket()
    parent = os.environ.get('AUTOCLIP_PARENT_PID')
    if parent:
        def watch_parent():
            import psutil
            try:
                process = psutil.Process(int(parent))
                while process.is_running():
                    threading.Event().wait(.5)
            except (psutil.Error, ValueError):
                pass
            server.should_exit = True
        threading.Thread(target=watch_parent, daemon=True).start()
    server.run(sockets=[listener])


if __name__ == '__main__':
    main()
