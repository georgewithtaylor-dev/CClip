"""Share the real local HTML template and its renderer fill with the editor."""
from fastapi import HTTPException
from fastapi.responses import FileResponse

from backend.services.studio.models import Draft
from backend.services.studio.overlay_fill import build_fill, output_packaging


def preview_fill(draft: Draft):
    from backend.services.studio.audio import scene_duration
    return build_fill(output_packaging(draft), sum(scene_duration(scene) for scene in draft.scenes),
                      safe_area=draft.platform_preset or 'xiaohongshu')


def template_asset(template: str, filename: str):
    from backend.services.studio.templates.registry import ASSET_ROOT
    if template not in {'editorial', 'street'} or filename not in {'index.html', 'style.css', 'template.js'}:
        raise HTTPException(404, 'template_not_found')
    return FileResponse(ASSET_ROOT / template / filename)
