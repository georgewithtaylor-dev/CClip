"""Bounded, local-only audio envelopes for immutable source assets."""
from __future__ import annotations

from array import array
import json
import math
from pathlib import Path
import subprocess
import sys
import threading

from backend.utils.ffmpeg_utils import get_ffmpeg_path
from .media import MediaError

_lock = threading.Lock()


def waveform(source: Path, folder: Path, duration: float, has_audio: bool):
    stat = source.stat()
    stamp = [stat.st_size, stat.st_mtime_ns]
    target = folder / 'peaks-v1.json'
    with _lock:
        try:
            cached = json.loads(target.read_text(encoding='utf-8'))
            if cached['stamp'] == stamp and cached['waveform']['duration'] == duration:
                return cached['waveform']
        except (OSError, ValueError, KeyError, TypeError):
            pass
        bins = min(60000, max(1, math.ceil(duration * 20)))
        peaks = [0] * bins if has_audio else []
        if has_audio:
            # 800 Hz mono PCM retains a useful speech envelope. Read chunks rather
            # than an entire recording; never write extracted speech to disk.
            process = subprocess.Popen(
                [get_ffmpeg_path(), '-nostdin', '-hide_banner', '-loglevel', 'error',
                 '-i', str(source), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '800', '-f', 's16le', 'pipe:1'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            deadline = threading.Timer(90, process.kill)
            deadline.daemon = True
            deadline.start()
            samples = 0
            try:
                while chunk := process.stdout.read(32768):
                    values = array('h')
                    values.frombytes(chunk)
                    if sys.byteorder != 'little':
                        values.byteswap()
                    for value in values:
                        index = min(bins - 1, int(samples * bins / (800 * duration)))
                        peaks[index] = max(peaks[index], abs(value))
                        samples += 1
                    if samples > 800 * (duration + 10):
                        raise MediaError('invalid_media')
                if process.wait() != 0:
                    raise MediaError('media_command_failed')
            finally:
                deadline.cancel()
                if process.poll() is None:
                    process.kill()
                process.wait()
                process.stdout.close()
            ceiling = max(1, max(peaks, default=1))
            peaks = [round(255 * math.sqrt(value / ceiling)) for value in peaks]
        result = {'version': 1, 'duration': duration, 'step': duration / bins, 'hasAudio': has_audio, 'peaks': peaks}
        folder.mkdir(parents=True, exist_ok=True)
        pending = target.with_suffix('.pending')
        try:
            pending.write_text(json.dumps({'stamp': stamp, 'waveform': result}), encoding='utf-8')
            pending.replace(target)
        finally:
            pending.unlink(missing_ok=True)
        return result
