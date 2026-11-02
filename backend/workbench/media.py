"""Local-only media commands. Original inputs are never output targets."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import threading

from backend.utils.ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path


class MediaError(Exception):
    pass


class Cancelled(Exception):
    pass


_thumbnail_lock = threading.Semaphore(1)


def thumbnail(source: Path, folder: Path, at: float):
    """Small local frame, bounded concurrency and immutable asset cache."""
    if not math.isfinite(at):
        raise MediaError('invalid_range')
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f'{round(at * 1000)}.jpg'
    with _thumbnail_lock:
        if not target.is_file():
            temporary = folder / f'{round(at * 1000)}.pending.jpg'
            try:
                run_ffmpeg(['-ss', str(at), '-i', str(source), '-frames:v', '1', '-threads', '1',
                            '-vf', 'scale=176:100:force_original_aspect_ratio=decrease,pad=176:100:(ow-iw)/2:(oh-ih)/2',
                            '-q:v', '4', str(temporary)], folder, threading.Event())
                if not temporary.is_file() or not temporary.stat().st_size:
                    raise MediaError('invalid_media')
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    return target


def available():
    return all(shutil.which(tool) for tool in (get_ffmpeg_path(), get_ffprobe_path()))


def probe(path: Path):
    result = subprocess.run([get_ffprobe_path(), '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)],
                            capture_output=True, timeout=40, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise MediaError('invalid_media')
    info = json.loads(result.stdout)
    video = next((item for item in info.get('streams', []) if item.get('codec_type') == 'video'), None)
    duration = float(info.get('format', {}).get('duration', 0))
    if not video or not math.isfinite(duration) or not 0 < duration <= 86400:
        raise MediaError('invalid_media')
    return {'duration': duration, 'width': int(video['width']), 'height': int(video['height']),
            'hasAudio': any(item.get('codec_type') == 'audio' for item in info['streams']), 'codec': video.get('codec_name', '')}


def run_ffmpeg(arguments, folder: Path, cancelled: threading.Event, progress=None, expected=0):
    command = [get_ffmpeg_path(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', *arguments]
    # Logs remain in the private job folder and never enter HTTP errors or remote telemetry.
    with (folder / 'ffmpeg.log').open('ab') as log:
        process = subprocess.Popen(command, cwd=folder, stdout=subprocess.PIPE, stderr=log, text=True,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def terminate():
            while process.poll() is None:
                if cancelled.wait(.15):
                    process.terminate()
                    return
        watcher = threading.Thread(target=terminate, daemon=True)
        watcher.start()
        try:
            for line in process.stdout:
                if progress and expected and line.startswith('out_time_us='):
                    try:
                        progress(min(.99, int(line.split('=', 1)[1]) / 1_000_000 / expected))
                    except ValueError:
                        pass
            code = process.wait()
            if cancelled.is_set():
                raise Cancelled()
            if code:
                raise MediaError('media_command_failed')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            watcher.join(timeout=.3)


def timestamp(seconds):
    millis = round(seconds * 1000)
    return f'{millis // 3600000:02d}:{millis // 60000 % 60:02d}:{millis // 1000 % 60:02d},{millis % 1000:03d}'


def output_cues(project):
    output, offset = [], 0.0
    for clip in project['clips']:
        for cue in sorted(project['cues'], key=lambda item: (item['start'], item['end'])):
            start, end = max(clip['start'], cue['start']), min(clip['end'], cue['end'])
            if end > start:
                output.append({'start': offset + start - clip['start'], 'end': offset + end - clip['start'], 'text': cue['text']})
        offset += clip['end'] - clip['start']
    return output


def write_srt(path, cues):
    path.write_text('\n\n'.join(f"{i}\n{timestamp(cue['start'])} --> {timestamp(cue['end'])}\n{cue['text']}" for i, cue in enumerate(cues, 1)) + '\n', encoding='utf-8', newline='\n')


def render(source: Path, project, folder: Path, target: Path, cancelled, progress, burn=True):
    if not project['clips']:
        raise MediaError('empty_sequence')
    info = probe(source)
    total = sum(item['end'] - item['start'] for item in project['clips'])
    names = []
    processed = 0.0
    subtitles = output_cues(project)
    write_srt(folder / 'subtitles.srt', subtitles)
    for index, clip in enumerate(project['clips']):
        if cancelled.is_set():
            raise Cancelled()
        name = f'part-{index:05d}.mp4'
        names.append(name)
        length = clip['end'] - clip['start']
        filters = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,setpts=PTS-STARTPTS'
        local_cues = output_cues({**project, 'clips': [clip]})
        if burn and local_cues:
            caption_name = f'part-{index:05d}.srt'
            write_srt(folder / caption_name, local_cues)
            filters += f',subtitles=filename={caption_name}'
        args = ['-ss', str(clip['start']), '-i', str(source), '-t', str(length), '-map', '0:v:0', '-map', '0:a:0?',
                '-vf', filters,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '2']
        if info['hasAudio']:
            args += ['-af', 'asetpts=PTS-STARTPTS,apad', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2']
        run_ffmpeg([*args, name], folder, cancelled, lambda part: progress(.94 * (processed + part * length) / total), length)
        processed += length
    (folder / 'concat.txt').write_text('\n'.join(f"file '{name}'" for name in names), encoding='utf-8')
    pending = folder / 'final.mp4'
    run_ffmpeg(['-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-t', str(total), '-c', 'copy', '-movflags', '+faststart', str(pending)], folder, cancelled)
    progress(.96)
    result = probe(pending)
    if abs(result['duration'] - total) > max(.15, len(names) * .04):
        raise MediaError('export_duration_mismatch')
    # Every byte is decoded locally before publishing the file as completed.
    run_ffmpeg(['-i', str(pending), '-f', 'null', '-'], folder, cancelled)
    progress(.99)
    if cancelled.is_set():
        raise Cancelled()
    pending.replace(target)
    shutil.copyfile(folder / 'subtitles.srt', target.with_suffix('.srt'))
    return {'duration': result['duration'], 'expectedDuration': total, 'bytes': target.stat().st_size}


def silence_ranges(source, folder, cancelled):
    # Detection is advisory; the user applies selected suggestions to a reversible edit.
    run_ffmpeg(['-i', str(source), '-vn', '-af', 'silencedetect=noise=-35dB:d=0.7', '-loglevel', 'info', '-f', 'null', '-'], folder, cancelled)
    text = (folder / 'ffmpeg.log').read_text(encoding='utf-8', errors='replace')
    events = re.findall(r'silence_(start|end):\s*([\d.]+)', text)
    ranges, start = [], None
    for kind, value in events:
        if kind == 'start':
            start = float(value)
        elif start is not None:
            end = float(value)
            if end - start > .7:
                ranges.append({'start': start + .18, 'end': end - .18, 'kind': 'silence'})
            start = None
    return ranges
