from pathlib import Path
import re
import unittest


class WorkflowIsolationTests(unittest.TestCase):
    def test_upstream_write_and_release_jobs_cannot_run_for_cclip(self):
        root = Path(__file__).resolve().parents[2]
        for path in (root / '.github/workflows').glob('*.yml'):
            if path.name in {'ci.yml', 'i18n-sync.yml', 'windows-asyncio.yml'}:
                continue
            jobs = path.read_text(encoding='utf-8').split('\njobs:\n', 1)[1]
            blocks = re.findall(r'^  [a-zA-Z0-9_-]+:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)', jobs, re.M | re.S)
            self.assertTrue(blocks, path.name)
            for block in blocks:
                self.assertRegex(block, r"(?m)^    if: github.repository == 'zhouxiaoka/autoclip'", path.name)
