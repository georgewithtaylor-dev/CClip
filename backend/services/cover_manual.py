"""Local prompt/reference handoff and user-supplied cover images. No model calls."""
from __future__ import annotations

import io
import json
import math
import os
import re
import time
import uuid
import warnings
from pathlib import Path

from backend.services import cover

MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def _snapshot(project_id: str, clip_id: str, revision: int | None = None):
    if not re.fullmatch(r'draft-[a-f0-9]{32}', clip_id):
        raise FileNotFoundError('无效的封面草稿引用')
    clip = cover.load_cover_clip(project_id, clip_id)
    if revision is not None and clip['draft_revision'] != revision:
        raise cover.CoverError('片段已变化，请重新保存并准备封面', 409)
    return clip


def _atomic(path: Path, content: bytes):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(*, project_id: str, clip_id: str, revision: int, platform: str, title: str = '',
            subtitle: str = '', badge: str = '', content_type: str = 'general', frame_time: float | None = None):
    clip = _snapshot(project_id, clip_id, revision)
    platform = cover.normalize_platform(platform)
    video, at = cover.resolve_clip_frame(project_id, clip_id, snapshot=clip)
    if frame_time is not None:
        if not math.isfinite(frame_time) or not any(s['start'] <= frame_time < s['end'] for s in clip['scenes']):
            raise cover.CoverError('请选择当前片段保留范围内的画面')
        at = frame_time
    frame = cover.extract_frame_jpeg(video, at_sec=at)
    title = title.strip() or clip['title']
    prompt = cover.build_prompt(title_lines=cover.split_title(title, preserve_full=True), subtitle=subtitle,
                                badge=badge, platform=platform, content_type=content_type, has_reference=True)
    spec = cover.PLATFORMS[platform]
    prompt = prompt.replace(f"输出约 {spec['model_w']}×{spec['model_h']}。", f"最终封面尺寸为 {spec['width']}×{spec['height']}，请按这个画幅构图。")
    prompt += '\n表达文明、专业，围绕标题的核心观点设计；不要增加猎奇、低俗的文字。保留参考画面主体，文字避开人物面部。'
    identifier = uuid.uuid4().hex
    folder = cover.cover_dir(project_id, clip_id) / 'manual' / identifier
    folder.mkdir(parents=True)
    _atomic(folder / 'prompt.txt', prompt.encode('utf-8'))
    _atomic(folder / 'reference.jpg', frame)
    base = f'/api/v1/publish/covers/{project_id}/clips/{clip_id}/manual/{identifier}'
    return {'ok': True, 'platform': platform, 'prompt': prompt, 'frame_url': base + '/frame', 'prompt_url': base + '/prompt',
            'frame_time': at, 'revision': revision, 'width': spec['width'], 'height': spec['height']}


def artifact(project_id: str, clip_id: str, kit_id: str, kind: str):
    _snapshot(project_id, clip_id)
    if not re.fullmatch(r'[a-f0-9]{32}', kit_id) or kind not in ('frame', 'prompt'):
        raise FileNotFoundError('没有这份生图素材')
    name = 'reference.jpg' if kind == 'frame' else 'prompt.txt'
    path = cover.cover_dir(project_id, clip_id) / 'manual' / kit_id / name
    if not path.is_file():
        raise FileNotFoundError('没有这份生图素材')
    return path


def import_image(*, project_id: str, clip_id: str, revision: int, platform: str, image: bytes,
                 title: str = '', subtitle: str = '', badge: str = ''):
    from PIL import Image, ImageOps, UnidentifiedImageError
    from backend.services.studio import store

    clip = _snapshot(project_id, clip_id, revision)
    if not image or len(image) > MAX_UPLOAD_BYTES:
        raise cover.CoverError('请上传不超过20MB的PNG、JPEG或WebP图片', 413 if image else 400)
    platform = cover.normalize_platform(platform)
    spec = cover.PLATFORMS[platform]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image)) as original:
                if original.format not in ('PNG', 'JPEG', 'WEBP') or original.width * original.height > 40_000_000 or max(original.size) > 12000:
                    raise cover.CoverError('请使用尺寸不超过12000像素的PNG、JPEG或WebP图片')
                original_size = original.size
                source = ImageOps.exif_transpose(original).convert('RGBA')
                background = Image.new('RGBA', source.size, (18, 23, 30, 255))
                source = Image.alpha_composite(background, source).convert('RGB')
                fitted = ImageOps.pad(source, (spec['width'], spec['height']), method=Image.Resampling.LANCZOS, color=(18, 23, 30))
                output = io.BytesIO()
                fitted.save(output, format='JPEG', quality=95, optimize=True)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise cover.CoverError('无法读取图片，请使用有效的PNG、JPEG或WebP图片') from exc
    meta = {'method': 'uploaded', 'title': title.strip() or clip['title'], 'subtitle': subtitle, 'badge': badge,
            'platform': platform, 'width': spec['width'], 'height': spec['height'], 'image_layout': 'fit',
            'reference_sent': False, 'original_width': original_size[0], 'original_height': original_size[1],
            'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    path = cover.cover_path(project_id, clip_id, platform)
    metadata = cover.meta_path(project_id, clip_id, platform)
    url = f'/api/v1/publish/covers/{project_id}/clips/{clip_id}/file?platform={platform}&t={time.time_ns()}'

    def commit(data):
        current = next((d for d in data['drafts'] if d['id'] == clip['draft_id']), None)
        if not current or current['revision'] != revision:
            raise cover.CoverError('片段已变化，请重新保存后上传封面', 409)
        if any(j.get('clip_id') == clip_id and j.get('platform') == platform and j.get('status') in ('queued', 'running')
               for j in (data.get('cclip_cover_jobs') or {}).values()):
            raise cover.CoverError('封面正在生成，请完成后再上传', 409)
        # Invalid input and revision conflicts are rejected before replacing files.
        before = [(p, p.read_bytes() if p.exists() else None) for p in (path, metadata)]
        try:
            _atomic(path, output.getvalue())
            _atomic(metadata, json.dumps(meta, ensure_ascii=False, indent=2).encode('utf-8'))
        except OSError:
            for target, content in before:
                if content is not None:
                    _atomic(target, content)
                else:
                    target.unlink(missing_ok=True)
            raise
        data.setdefault('cclip_draft_covers', {})[clip['draft_id']] = {'url': url, 'platform': platform, 'draft_revision': revision}
    store.change(project_id, commit)
    return {**(cover.get_cover(project_id, clip_id, platform) or {}), 'url': url}
