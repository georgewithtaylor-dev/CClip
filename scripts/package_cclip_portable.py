#!/usr/bin/env python3
"""Package only the frozen CClip binary and inventoried resources, never user data."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def package(binary, resources, destination, archive):
    if destination.exists() or archive.exists():
        raise FileExistsError('Use new package and ZIP destinations; never overwrite trial data')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT):
        raise RuntimeError('Freeze tracked source before packaging')
    identity = json.loads((resources / '构建身份.json').read_text(encoding='utf-8'))
    if identity.get('sourceCommit') != commit or identity.get('trackedChanges'):
        raise RuntimeError('Resources do not match the frozen source')
    manifest = json.loads((resources / '资源清单.json').read_text(encoding='utf-8'))
    for name, entry in manifest.items():
        relative = Path(name)
        if (relative.parts[:1] == ('backend',) and
                ('data' in relative.parts or relative.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.rdb', '.log'}
                 or relative.name.startswith('.env') or relative.name in {'settings.json', 'credentials.json', 'cookies.json'})):
            raise RuntimeError('Private backend data must not enter the distribution')
        source = resources / name
        if not source.resolve().is_relative_to(resources.resolve()) or not source.is_file():
            raise RuntimeError('Invalid resource path')
        if source.stat().st_size != entry['bytes'] or digest(source) != entry['sha256']:
            raise RuntimeError('Resource inventory mismatch: ' + name)
    actual = {p.relative_to(resources).as_posix() for p in resources.rglob('*') if p.is_file()}
    if actual != set(manifest) | {'资源清单.json'}:
        raise RuntimeError('Uninventoried resources must not enter the distribution')
    for required in ['python/python.exe', 'ffmpeg/ffmpeg.exe', 'webview2/msedgewebview2.exe', 'frontend/cclip.html']:
        if required not in manifest:
            raise RuntimeError('Missing portable component: ' + required)
    destination.mkdir(parents=True)
    shutil.copy2(binary, destination / 'CClip.exe')
    shutil.copytree(resources, destination / 'resources')
    shutil.copy2(ROOT / 'LICENSE', destination / 'LICENSE.txt')
    (destination / '使用说明.txt').write_text(
        'CClip Windows 免安装版\n\n'
        '完整解压后，双击 CClip.exe 即可运行。不要在 ZIP 内直接打开。\n'
        'resources 是随包组件，请与 CClip.exe 一起保留。\n'
        '本地转写模型已附带；AI选片等原功能需在设置中填写自己的接口。\n'
        '项目与设置保存在当前用户的 %APPDATA%/com.cclip.workbench，替换程序不会删除项目。\n'
        '分发包不附带私人测试视频、识别稿、项目或密钥。\n', encoding='utf-8-sig')
    package_identity = {'sourceCommit': commit, 'trackedChanges': False, 'product': 'CClip',
                        'kind': 'windows-x64-portable', 'executableSha256': digest(binary),
                        'resourceManifestSha256': digest(resources / '资源清单.json'), 'resourceFiles': len(manifest)}
    (destination / '版本身份.json').write_text(json.dumps(package_identity, ensure_ascii=False, indent=2), encoding='utf-8')
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for source in sorted(destination.rglob('*')):
            if source.is_file():
                output.write(source, (Path(destination.name) / source.relative_to(destination)).as_posix())
    receipt = {**package_identity, 'zipSha256': digest(archive), 'zipBytes': archive.stat().st_size}
    archive.with_suffix('.identity.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--resources', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    parser.add_argument('--zip', required=True, type=Path, dest='archive')
    args = parser.parse_args()
    package(args.binary, args.resources, args.destination, args.archive)


if __name__ == '__main__':
    main()
