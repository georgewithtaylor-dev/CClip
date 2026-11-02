"""Render CClip's own end card locally; no network or user media is used."""
import argparse
import math
from pathlib import Path
import subprocess
import tempfile
import wave

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SECONDS = 1.8
FPS = 30


def render(ffmpeg: str, destination: Path):
    logo = Image.open(ROOT / 'src-tauri/icons/cclip/icon.png').convert('RGBA')
    font_path = ROOT / 'backend/assets/fonts/BarlowCondensed-Black.ttf'
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cclip-end-card-') as folder:
        sound = Path(folder) / 'chime.wav'
        samples = bytearray()
        for index in range(round(48000 * SECONDS)):
            time = index / 48000
            age = time - .2
            value = (math.sin(2 * math.pi * 660 * age) + .35 * math.sin(2 * math.pi * 990 * age)) if age > 0 else 0
            amplitude = .12 * math.exp(-age * 9) * min(1, max(0, age * 80)) if age > 0 else 0
            samples.extend(round(32767 * amplitude * value).to_bytes(2, 'little', signed=True))
        with wave.open(str(sound), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(48000); audio.writeframes(samples)
        for width, height, name in [(1080, 1920, 'vertical'), (1920, 1080, 'horizontal')]:
            target = destination / f'outro-{name}.mp4'
            command = [ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', str(FPS),
                       '-i', '-', '-i', str(sound), '-t', str(SECONDS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                       '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', str(target)]
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            unit = min(width, height) / 1080
            size = round(264 * unit)
            mark = logo.resize((size, size), Image.Resampling.LANCZOS)
            font = ImageFont.truetype(str(font_path), round(112 * unit))
            try:
                for index in range(round(SECONDS * FPS)):
                    time = index / FPS
                    p = min(1, max(0, (time - .1) / .35)); p = p * p * (3 - 2 * p)
                    frame = Image.new('RGB', (width, height), '#10241f')
                    layer = Image.new('RGBA', (width, height))
                    cy = height / 2 - 80 * unit
                    layer.alpha_composite(mark, (round((width - size) / 2), round(cy - size / 2 + 22 * unit * (1 - p))))
                    draw = ImageDraw.Draw(layer)
                    draw.text((width / 2, cy + 168 * unit), 'CClip', font=font, anchor='mt', fill='#f3f6ed')
                    length = round(124 * unit * p)
                    draw.rounded_rectangle((width / 2 - length, cy + 316 * unit, width / 2 + length, cy + 321 * unit), radius=2, fill='#b8d98b')
                    layer.putalpha(layer.getchannel('A').point(lambda value: round(value * p)))
                    frame.paste(layer, mask=layer.getchannel('A'))
                    process.stdin.write(frame.tobytes())
                process.stdin.close()
                error = process.stderr.read()
                if process.wait(timeout=60):
                    raise RuntimeError(error.decode('utf-8', errors='replace')[-1000:])
            finally:
                if process.poll() is None:
                    process.kill(); process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--destination', type=Path, default=ROOT / 'backend/assets/cclip-outro')
    arguments = parser.parse_args()
    render(arguments.ffmpeg, arguments.destination)
