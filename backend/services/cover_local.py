"""Local-only template rendering shared by preview and final cover generation."""
from __future__ import annotations

import math

from backend.pipeline.quality import to_seconds
from backend.services import cover

TEMPLATES = ('autoclip', 'overlay')
PALETTES = ('azure', 'amber', 'coral', 'mint', 'lemon', 'rose', 'lilac')


def render(frame: bytes, *, width: int, height: int, title: str, subtitle: str = '', badge: str = '',
           local_template: str = 'autoclip', palette: str = 'azure', image_layout: str = 'fit',
           title_position: str = 'top', preferred_lines: list[str] | None = None, accent_line: int = 1) -> bytes:
    if local_template not in TEMPLATES or palette not in PALETTES:
        raise cover.CoverError('无效的封面模板或配色')
    if local_template == 'autoclip':
        from backend.services.studio.cover_design import design, headline_lines
        return design(frame, width=width, height=height, title_lines=headline_lines(title, preferred_lines),
                      accent_line=accent_line, palette=palette,
                      subtitle=subtitle, badge=badge)
    lines = cover.split_title(title, preserve_full=True)
    return cover.overlay_title(frame, width=width, height=height, title_lines=lines, subtitle=subtitle,
                               badge=badge, image_layout=image_layout, title_position=title_position)


def preview(*, project_id: str, clip_id: str, platform: str, title: str | None = None, subtitle: str = '',
            badge: str = '', frame_time: float | None = None, local_template: str = 'autoclip',
            palette: str = 'azure', image_layout: str = 'fit', title_position: str = 'top') -> bytes:
    clip = cover.load_cover_clip(project_id, clip_id)
    video, at = cover.resolve_clip_frame(project_id, clip_id, snapshot=clip)
    if frame_time is not None:
        ranges = clip.get('scenes') or [{'start': to_seconds(clip.get('start_time') or '0'), 'end': to_seconds(clip.get('end_time') or '0')}]
        if not math.isfinite(frame_time) or not any(scene['start'] <= frame_time < scene['end'] for scene in ranges):
            raise cover.CoverError('请选择当前片段保留范围内的画面')
        at = frame_time
    spec = cover.PLATFORMS[cover.normalize_platform(platform)]
    text = (title if title is not None else clip.get('generated_title') or clip.get('title') or clip.get('outline') or f'切片 {clip_id}').strip() or f'切片 {clip_id}'
    return render(cover.extract_frame_jpeg(video, at_sec=at), width=spec['width'], height=spec['height'], title=text,
                  subtitle=subtitle.strip(), badge=badge.strip(), local_template=local_template, palette=palette,
                  image_layout=image_layout, title_position=title_position,
                  preferred_lines=clip.get('cover_title_lines'), accent_line=clip.get('cover_title_accent_line', 1))
