#!/usr/bin/env bash
# Native Intel / Apple Silicon builds of the full CClip application.
# Inputs must be prepared on a Mac of the requested architecture. No publishing.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then echo 'Run this script on macOS.' >&2; exit 1; fi
if [[ $# -ne 4 ]]; then
  echo 'Usage: build_cclip_macos.sh PORTABLE_PYTHON_ROOT PACKAGES FFMPEG_DIR WHISPER_RUNTIME_DATA' >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
case "$(uname -m)" in
  x86_64) architecture=x86_64; target=x86_64-apple-darwin ;;
  arm64) architecture=arm64; target=aarch64-apple-darwin ;;
  *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac
python_root="$(cd "$1" && pwd)"
packages="$(cd "$2" && pwd)"
ffmpeg="$(cd "$3" && pwd)"
runtime="$(cd "$4" && pwd)"
python="$python_root/bin/python3"
actual="$("$python" -B -c 'import platform;print(platform.machine())')"
[[ "$actual" == "$architecture" ]] || { echo 'Python architecture does not match this native build.' >&2; exit 1; }
for name in ffmpeg ffprobe; do
  lipo -verify_arch "$architecture" "$ffmpeg/$name"
  if otool -L "$ffmpeg/$name" | tail -n +2 | grep -Ev '^\s*(/usr/lib/|/System/Library/|$)'; then
    echo 'FFmpeg must not depend on Homebrew or other machine-local libraries.' >&2; exit 1
  fi
done
npm --prefix frontend ci
npm --prefix frontend run build:cclip
candidate="build/cclip-resources-${architecture}-$(date +%Y%m%d%H%M%S)"
"$python" -B scripts/prepare_cclip_resources.py --full-app --destination "$candidate" --python-root "$python_root" \
  --packages "$packages" --ffmpeg "$ffmpeg" --runtime-data "$runtime"
"$python" -B - "$root" "$candidate" <<'PY'
from pathlib import Path
import shutil, sys, time
root=Path(sys.argv[1]).resolve()
source=(root/sys.argv[2]).resolve()
destination=(root/'src-tauri/resources').resolve()
assert source.is_relative_to(root/'build') and destination.parent == root/'src-tauri'
if destination.exists():
    destination.rename(root/'build'/('previous-cclip-resources-'+str(time.time_ns())))
shutil.copytree(source,destination)
PY
(cd src-tauri && node ../frontend/node_modules/@tauri-apps/cli/tauri.js build --config tauri.workbench.conf.json --features workbench --target "$target" --bundles app,dmg --ci -- --locked)
echo 'Build created locally. Native installed-package acceptance is still required; nothing was published.'
