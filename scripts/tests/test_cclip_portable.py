import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('cclip_portable', Path(__file__).resolve().parents[1] / 'package_cclip_portable.py')
portable = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portable)


class PortableDistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.resources = self.root / 'resources'
        self.resources.mkdir()
        self.binary = self.root / 'built.exe'
        self.binary.write_bytes(b'frozen-executable')
        for name in ['python/python.exe', 'ffmpeg/ffmpeg.exe', 'webview2/msedgewebview2.exe', 'frontend/cclip.html']:
            path = self.resources / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'component')
        (self.resources / '构建身份.json').write_text(json.dumps({'sourceCommit': 'frozen', 'trackedChanges': False}), encoding='utf-8')
        manifest = {p.relative_to(self.resources).as_posix(): {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                    for p in self.resources.rglob('*') if p.is_file()}
        (self.resources / '资源清单.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.destination = self.root / 'CClip-portable'
        self.archive = self.root / 'CClip.zip'

    def run_package(self, dirty=False):
        with patch.object(portable.subprocess, 'check_output', side_effect=['frozen\n', b'M file' if dirty else b'']), contextlib.redirect_stdout(io.StringIO()):
            portable.package(self.binary, self.resources, self.destination, self.archive)

    def test_only_inventoried_payload_is_distributed_with_bound_identity(self):
        (self.root / 'user-project.sqlite3').write_bytes(b'private-project-not-for-distribution')
        self.run_package()
        with zipfile.ZipFile(self.archive) as archive:
            names = archive.namelist()
            self.assertIn('CClip-portable/CClip.exe', names)
            self.assertIn('CClip-portable/resources/webview2/msedgewebview2.exe', names)
            self.assertFalse(any('user-project' in name for name in names))
            identity = json.loads(archive.read('CClip-portable/版本身份.json'))
            self.assertEqual(identity['sourceCommit'], 'frozen')
            self.assertEqual(identity['executableSha256'], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        receipt = json.loads(self.archive.with_suffix('.identity.json').read_text(encoding='utf-8'))
        self.assertEqual(receipt['zipSha256'], hashlib.sha256(self.archive.read_bytes()).hexdigest())

    def test_private_state_is_rejected_even_when_in_the_resource_manifest(self):
        manifest_path = self.resources / '资源清单.json'
        baseline = json.loads(manifest_path.read_text(encoding='utf-8'))
        for name in ('backend/dump.rdb', 'backend/data/project.sqlite3', 'backend/settings.json', 'backend/.env', 'backend/error.log'):
            with self.subTest(name=name):
                path = self.resources / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'private-state-fixture')
                manifest = {**baseline, name: {'bytes': path.stat().st_size, 'sha256': portable.digest(path)}}
                manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'Private backend data'):
                    self.run_package()
                self.assertFalse(self.destination.exists())
                path.unlink()
        manifest_path.write_text(json.dumps(baseline), encoding='utf-8')

    def test_source_preparation_refuses_tracked_state_files(self):
        source = Path(__file__).resolve().parents[1] / 'prepare_cclip_resources.py'
        spec = importlib.util.spec_from_file_location('private_source_probe', source)
        preparer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(preparer)
        with patch.object(preparer.subprocess, 'check_output', return_value=b'backend/workbench/app.py\0backend/dump.rdb\0'):
            with self.assertRaisesRegex(RuntimeError, 'Private backend data'):
                preparer.copy_backend_source(self.root / 'assembled')

    def test_rejects_uninventoried_project_data(self):
        (self.resources / 'project.sqlite3').write_bytes(b'private')
        with self.assertRaisesRegex(RuntimeError, 'Uninventoried'):
            self.run_package()
        self.assertFalse(self.destination.exists())

    def test_rejects_modified_resource_and_dirty_source(self):
        with self.assertRaisesRegex(RuntimeError, 'Freeze tracked'):
            self.run_package(dirty=True)
        (self.resources / 'frontend/cclip.html').write_bytes(b'modified')
        with self.assertRaisesRegex(RuntimeError, 'inventory mismatch'):
            self.run_package()
        self.assertFalse(self.archive.exists())


if __name__ == '__main__':
    unittest.main()
