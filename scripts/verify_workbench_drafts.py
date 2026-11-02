#!/usr/bin/env python3
"""Synthetic browser regression against an isolated, already-running local workbench."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
from uuid import uuid4

from playwright.sync_api import sync_playwright


def verify(url, output, ffmpeg):
    parsed = urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'} or parsed.username or parsed.password:
        raise ValueError('Only an isolated loopback test service is supported')
    origin = f'{parsed.scheme}://{parsed.netloc}'
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    results, errors, external = [], [], []
    with tempfile.TemporaryDirectory(prefix='draft-regression-', dir=output.parent) as folder, sync_playwright() as runtime:
        root = Path(folder)
        video = root / 'synthetic-draft.mp4'
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=teal:s=144x256:r=25:d=3',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-shortest', str(video)], check=True, capture_output=True, timeout=30)
        candidates = [shutil.which(name) for name in ('google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser')]
        edge = Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
        browser = runtime.chromium.launch(executable_path=str(edge) if edge.is_file() else next((p for p in candidates if p), None), headless=True)
        context = browser.new_context(viewport={'width': 1334, 'height': 871})
        def route(request):
            address = request.request.url
            if address.startswith(origin + '/') or address.startswith(('blob:', 'data:')):
                request.continue_()
            else:
                external.append('blocked_external_request')
                request.abort()
        context.route('**/*', route)
        page = context.new_page()
        page.on('dialog', lambda dialog: dialog.accept())
        page.on('pageerror', lambda error: errors.append(type(error).__name__))
        page.set_default_timeout(12000)
        def save():
            page.get_by_role('button', name='保存草稿', exact=True).click()
            page.wait_for_function("() => !document.querySelector('.wb-header-status .is-dirty')")
            return json.loads(page.evaluate("() => localStorage.getItem('autoclip.workbench.draft.v1')"))
        def load(document):
            page.locator('input[type=file][accept=".json"]').set_input_files({'name': 'synthetic.json', 'mimeType': 'application/json', 'buffer': json.dumps(document).encode()})
        try:
            page.goto(url if parsed.path and parsed.path != '/' else origin + '/workbench.html')
            page.get_by_text('● 本机服务已连接', exact=True).wait_for()
            page.locator('input[type=file][accept^="video/"]').set_input_files(video)
            page.wait_for_function("() => document.querySelector('video')?.readyState >= 2")
            page.locator('.wb-timecode').click()
            page.keyboard.press('i')
            page.locator('video').evaluate("v => {v.currentTime=v.duration;v.dispatchEvent(new Event('timeupdate'))}")
            page.locator('.wb-timecode').click()
            page.keyboard.press('o')
            page.locator('.wb-selection-bar .wb-button-accent').click()
            page.locator('input[type=file][accept=".srt"]').set_input_files({'name': 'synthetic.srt', 'mimeType': 'text/plain', 'buffer': b'1\n00:00:00,000 --> 00:00:01,000\nSynthetic caption\n\n2\n00:00:01,000 --> 00:00:03,000\nPreserve this edit\n'})
            page.locator('video').evaluate("v => {v.currentTime=1.3;v.dispatchEvent(new Event('timeupdate'))}")
            page.locator('.wb-timecode').click()
            page.keyboard.press('s')
            page.keyboard.press('m')
            page.get_by_text('2 个片段', exact=True).wait_for()
            original = save()
            load(original)
            page.wait_for_function("() => document.querySelector('video')?.readyState >= 2")
            assert page.locator('video').evaluate('video => video.currentTime') < .05
            assert float(page.get_by_role('slider', name='播放头位置', exact=True).get_attribute('aria-valuenow')) == 0
            restored = save()
            assert restored['clips'] == original['clips'] and restored['cues'] == original['cues'] and restored['bookmarks'] == original['bookmarks']
            results.append({'case': 'same_asset_draft_keeps_preview_and_edits', 'status': 'passed'})
            foreign = {**original, 'source': {**original['source'], 'assetId': str(uuid4())}, 'localId': str(uuid4()), 'localRevision': 1}
            load(foreign)
            page.wait_for_selector('video', state='detached')
            page.locator('input[type=file][accept^="video/"]').set_input_files(video)
            page.wait_for_function("() => document.querySelector('video')?.readyState >= 2")
            linked = save()
            assert linked['source']['assetId'] != original['source']['assetId'] and linked['localId'] != original['localId']
            assert linked['clips'] == original['clips'] and linked['cues'] == original['cues'] and linked['bookmarks'] == original['bookmarks']
            results.append({'case': 'missing_asset_relink_preserves_edits_and_bookmarks', 'status': 'passed'})
            assert not errors and not external
            report = {'status': 'passed', 'syntheticOnly': True, 'results': results, 'pageErrors': errors, 'externalRequests': external}
        except Exception:
            report = {'status': 'failed', 'syntheticOnly': True, 'results': results, 'pageErrors': errors, 'externalRequests': external}
            output.write_text(json.dumps(report, indent=2), encoding='utf-8')
            raise
        finally:
            context.close()
            browser.close()
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='URL of an isolated local test service; never a user data directory')
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    arguments = parser.parse_args()
    verify(arguments.url, arguments.report, arguments.ffmpeg)
