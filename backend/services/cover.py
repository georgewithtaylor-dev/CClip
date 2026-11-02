"""
切片封面：生图写标题为主，失败则本地排版，再失败就截帧。

发布路径绝不因封面失败而中断：B 站投稿拿不到设计封面时，退回成片截帧；
截帧也失败就空封面继续投稿。
"""
from __future__ import annotations

import io
import json
import logging
import math
import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.core.image_providers import (
    ImageError,
    ImageRequest,
    default_ocr_model,
    generate_image,
    read_image_text,
)
from backend.services.publish_export import find_source_video, load_clip_meta, resolve_cjk_font, to_seconds

logger = logging.getLogger(__name__)

CONFIG_FILENAME = "cover.json"
PLATFORMS = {
    "bilibili": {"width": 1146, "height": 717, "model_w": 1280, "model_h": 720, "label": "B站横屏"},
    "douyin": {"width": 1080, "height": 1920, "model_w": 720, "model_h": 1280, "label": "竖屏"},
    "xiaohongshu": {"width": 1080, "height": 1440, "model_w": 1080, "model_h": 1440, "label": "小红书 3:4"},
    "youtube_long": {"width": 1280, "height": 720, "model_w": 1280, "model_h": 720, "label": "YouTube 16:9"},
}
CONTENT_TYPES = ("knowledge", "interview", "game", "vlog", "general")
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()
_cancel: dict[str, threading.Event] = {}


class CoverError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class CoverConfig:
    enabled: bool = False
    provider: str = "openai"
    model: str = ""
    api_key: str = ""
    base_url: str = ""
    ocr_model: str = ""
    allow_send_frame: bool = False
    source: str = "none"
    # own / env / text_model：密钥是封面自己填的、环境变量，还是复用了「AI 模型」里同一家的 key
    key_source: str = "none"
    # text_model：生图跟着「AI 分析 → 模型」的服务商走；custom：旧版单独配置的生图服务
    mode: str = "custom"

    @property
    def configured(self) -> bool:
        return bool(self.api_key) or bool(self.base_url)

    def public(self) -> dict[str, Any]:
        key = self.api_key
        masked = ""
        if key:
            masked = key[:4] + "…" + key[-4:] if len(key) > 8 else "••••"
        verification = None
        if self.enabled and self.configured:
            try:
                # Pure local config selection; never call vision_settings.test,
                # read_image_text, generate_image or any HTTP client here.
                # The socket-denied regression covers this lookup.
                endpoint = verify_endpoint(self)
                verification = {name: endpoint.get(name, '') for name in ('provider', 'base_url', 'model')}
            except ImageError:
                pass
        return {
            "enabled": self.enabled,
            "provider": self.provider or "openai",
            "model": self.model,
            "api_key_masked": masked,
            "base_url": self.base_url,
            "ocr_model": self.ocr_model,
            "allow_send_frame": self.allow_send_frame,
            "configured": self.configured,
            "source": self.source,
            "key_source": self.key_source,
            "mode": self.mode,
            'verification': verification,
        }


def config_path() -> Path:
    from backend.core.path_utils import get_data_directory
    return get_data_directory() / CONFIG_FILENAME


def _text_model_key(provider: str, base_url: str) -> str:
    """生图提供商和文本模型是同一家时复用那边的 key，用户不用再填一遍。

    通义万相 ↔ 通义千问（dashscope），Seedream ↔ Seed（火山方舟），
    OpenAI 兼容 ↔ OpenAI 官方 / Infistar（按接口地址判断）。
    """
    try:
        from backend.core.llm_manager import get_llm_manager
        settings = get_llm_manager().settings
    except Exception:  # noqa: BLE001 - 读不到文本设置就当没有可复用的 key
        return ""
    kind = (provider or "openai").strip().lower()
    host = (base_url or "").lower()
    if kind == "dashscope":
        return str(settings.get("dashscope_api_key") or "")
    if kind == "seedream":
        return str(settings.get("seed_api_key") or "")
    from urllib.parse import urlparse
    from backend.core.cloud_presets import is_api88_host
    if is_api88_host(urlparse(base_url or "").hostname):
        return str(settings.get("api88_api_key") or "")
    if "infistar" in host:
        return str(settings.get("infistar_api_key") or "")
    if not host or "api.openai.com" in host:
        return str(settings.get("openai_api_key") or "")
    return ""


def text_model_image_service() -> dict[str, str] | None:
    """「AI 分析 → 模型」当前服务商对应的生图接口：provider / base_url / api_key / 服务商名。

    通义千问 → 通义万相，Seed（火山方舟）→ Seedream，OpenAI / Infistar → OpenAI 兼容 images。
    DeepSeek、Kimi、GLM、Grok、本地模型没有生图，返回 None（封面用视频截帧）。
    """
    try:
        from backend.core.llm_manager import get_llm_manager
        s = get_llm_manager().settings
    except Exception:  # noqa: BLE001
        return None
    provider = s.get("llm_provider", "dashscope")
    preset = s.get("cloud_preset")
    if provider == "dashscope":
        intl = "dashscope-intl" in str(s.get("dashscope_base_url") or "")
        return {"provider": "dashscope", "text_provider": "dashscope", "api_key": str(s.get("dashscope_api_key") or ""),
                "base_url": "https://dashscope-intl.aliyuncs.com/api/v1" if intl else ""}
    if provider != "openai" or s.get("llm_provider_preset"):
        return None
    if preset == "seed":
        return {"provider": "seedream", "text_provider": "seed", "api_key": str(s.get("seed_api_key") or ""), "base_url": ""}
    if preset in {"infistar", "api88"}:
        return {"provider": "openai", "text_provider": preset, "api_key": str(s.get(f"{preset}_api_key") or ""),
                "base_url": str(s.get("openai_base_url") or "")}
    if preset:
        return None
    return {"provider": "openai", "text_provider": "openai", "api_key": str(s.get("openai_api_key") or ""),
            "base_url": str(s.get("openai_base_url") or "")}


def verify_endpoint(cfg: "CoverConfig") -> dict[str, str]:
    """校对标题用哪个多模态模型读图。

    手动填过校对模型的沿用旧行为；否则用「视觉理解」那一套（默认就是文本模型），
    不再要求用户单独配一个校对模型。都没有时退回生图提供商的默认读图模型。
    """
    if cfg.ocr_model:
        return {"provider": cfg.provider, "api_key": cfg.api_key, "base_url": cfg.base_url, "model": cfg.ocr_model}
    try:
        from backend.services.studio.vision_settings import effective
        vision = effective()
    except Exception:  # noqa: BLE001
        vision = {}
    if vision.get("base_url") and vision.get("model"):
        return {"provider": "openai", "api_key": vision.get("api_key", ""), "base_url": vision["base_url"], "model": vision["model"]}
    if cfg.source == 'connections':
        raise ImageError('未选择可用于封面校对的多模态模型，跳过校对')
    return {"provider": cfg.provider, "api_key": cfg.api_key, "base_url": cfg.base_url,
            "model": default_ocr_model(cfg.provider, cfg.model, cfg.base_url)}


def load_config() -> CoverConfig:
    from backend.services import ai_model_settings as ai
    settings = ai.load()
    if settings:
        binding = settings.cover
        endpoint = ai.image_endpoint(ai.connection_for(settings, binding)) if binding else {}
        return CoverConfig(enabled=settings.cover_enabled, model=binding.model if binding else '',
                           provider=endpoint.get('provider', 'openai'), base_url=endpoint.get('base_url', ''),
                           api_key=endpoint.get('api_key', ''), allow_send_frame=settings.allow_send_frame,
                           ocr_model=settings.cover_ocr_model,
                           source='connections', key_source='connection', mode='custom')
    env_key = (os.getenv("IMAGE_API_KEY") or "").strip()
    env_provider = (os.getenv("IMAGE_PROVIDER") or "").strip().lower()
    env_base = (os.getenv("IMAGE_BASE_URL") or "").strip()
    env_model = (os.getenv("IMAGE_MODEL") or "").strip()
    path = config_path()
    data: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError) as exc:
            logger.warning("读取 %s 失败: %s", path, exc)
    file_key = str(data.get("api_key") or "").strip()
    source = "file" if (file_key or data) else "none"
    api_key = env_key or file_key
    key_source = "env" if env_key else "own" if file_key else "none"
    if env_key:
        source = "env"
    elif not api_key and not data and not env_base and not env_provider:
        source = "none"
    provider = (env_provider or str(data.get("provider") or "openai")).strip().lower() or "openai"
    base_url = env_base or str(data.get("base_url") or "").strip()
    mode = "custom" if (env_key or env_provider or env_base) else str(data.get("mode") or ("custom" if data else "text_model"))
    if mode == "text_model":
        service = text_model_image_service()
        return CoverConfig(
            enabled=bool(data.get("enabled", False)) and service is not None,
            provider=service["provider"] if service else provider,
            model=env_model or str(data.get("model") or "").strip(),
            api_key=service["api_key"] if service else "",
            base_url=service["base_url"] if service else "",
            ocr_model="",
            allow_send_frame=bool(data.get("allow_send_frame", False)),
            source="file" if data else "none",
            key_source="text_model" if service and service["api_key"] else "none",
            mode="text_model",
        )
    if not api_key:
        api_key = _text_model_key(provider, base_url)
        if api_key:
            key_source = "text_model"
    return CoverConfig(
        enabled=bool(data.get("enabled", False)),
        provider=provider,
        model=env_model or str(data.get("model") or "").strip(),
        api_key=api_key,
        base_url=base_url,
        ocr_model=str(data.get("ocr_model") or "").strip(),
        allow_send_frame=bool(data.get("allow_send_frame", False)),
        source=source if (api_key or data or env_base or env_provider) else "none",
        key_source=key_source,
        mode="custom",
    )


def save_config(
    *,
    enabled: bool | None = None,
    provider: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    ocr_model: str | None = None,
    allow_send_frame: bool | None = None,
    mode: str | None = None,
) -> CoverConfig:
    current = load_config()
    path = config_path()
    existing: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, ValueError):
            existing = {}
    payload = {
        "enabled": current.enabled if enabled is None else bool(enabled),
        "provider": (provider if provider is not None else current.provider or "openai").strip().lower() or "openai",
        "model": (model if model is not None else current.model).strip(),
        # 复用来的文本模型 key 不写进封面配置：文本那边换了 key，这里跟着变
        "api_key": (current.api_key if current.key_source == "own" else "") if api_key is None else api_key.strip(),
        "base_url": (base_url if base_url is not None else current.base_url).strip().rstrip("/"),
        "ocr_model": (ocr_model if ocr_model is not None else current.ocr_model).strip(),
        "allow_send_frame": current.allow_send_frame if allow_send_frame is None else bool(allow_send_frame),
        # 没指明 mode 但传了服务商 / key / 地址（旧客户端、脚本）：就是单独配置
        "mode": mode or ("custom" if (provider or api_key or base_url) else current.mode) or "custom",
    }
    if payload["mode"] == "text_model":
        # 跟随模型：服务商、地址、key 都从「AI 分析 → 模型」推出来，不在这里保存
        payload.update(provider="", api_key="", base_url="", ocr_model="")
        if enabled is None and not existing:
            payload["enabled"] = False
    elif api_key is None and existing.get("api_key"):
        payload["api_key"] = str(existing["api_key"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return load_config()


def clear_config() -> CoverConfig:
    path = config_path()
    if path.exists():
        path.unlink()
    return load_config()


def cover_dir(project_id: str, clip_id: str) -> Path:
    from backend.core.path_utils import get_project_directory
    path = get_project_directory(project_id) / "output" / "covers" / str(clip_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def cover_path(project_id: str, clip_id: str, platform: str) -> Path:
    return cover_dir(project_id, clip_id) / f"{platform}.jpg"


def meta_path(project_id: str, clip_id: str, platform: str) -> Path:
    return cover_dir(project_id, clip_id) / f"{platform}.json"


def normalize_platform(platform: str | None) -> str:
    key = (platform or "bilibili").strip().lower()
    if key in ("vertical", "shorts", "tiktok", "instagram", "youtube"):
        return "douyin"
    if key not in PLATFORMS:
        return "bilibili"
    return key


def split_title(title: str, *, max_lines: int = 2, max_chars: int = 18, preserve_full: bool = False) -> list[str]:
    text = re.sub(r"\s+", " ", (title or "").strip())
    if not text:
        return ["切片"]
    if preserve_full:
        if len(text) <= max_chars or max_lines == 1:
            return [text]
        mid = len(text) // 2
        spaces = [match.start() for match in re.finditer(' ', text)]
        if spaces:
            near = min(spaces, key=lambda index: abs(index - mid))
            if abs(near - mid) < len(text) * .25:
                mid = near
        return [text[:mid].rstrip(), text[mid:].lstrip()]
    for sep in (" / ", "/", "｜", "|", "：", ":", "——", "—", "，", ","):
        if sep in text:
            parts = [p.strip() for p in text.split(sep) if p.strip()]
            if 1 < len(parts) <= max_lines:
                return [p[:max_chars] for p in parts[:max_lines]]
    if len(text) <= max_chars:
        return [text]
    mid = len(text) // 2
    left = text[:mid].rstrip("的了呢吗吧与和，。！？ ")
    right = text[mid:].lstrip("的了呢吗吧与和，。！？ ")
    if not left or not right:
        return [text[:max_chars]]
    return [left[:max_chars], right[:max_chars]]


def infer_content_type(title: str, description: str = "") -> str:
    blob = f"{title} {description}".lower()
    rules = (
        ("game", ("翻盘", "高光", "1v", "游戏", "通关", "boss", "对局")),
        ("interview", ("对谈", "访谈", "对话", "第", "期", "ep.")),
        ("vlog", ("vlog", "日记", "住了", "第1天", "旅行", "日常")),
        ("knowledge", ("为什么", "解释", "科普", "陷阱", "案例", "普通人", "心理学")),
    )
    for kind, words in rules:
        if any(word.lower() in blob for word in words):
            return kind
    return "general"


def build_prompt(
    *,
    title_lines: list[str],
    subtitle: str,
    badge: str,
    platform: str,
    content_type: str,
    has_reference: bool,
) -> str:
    spec = PLATFORMS[normalize_platform(platform)]
    orientation = f"{spec['label']}（{spec['width']}×{spec['height']}）"
    joined = " / ".join(title_lines)
    style = {
        "knowledge": "冷静知识科普封面，深色或浅灰背景，克制专业，不要玩具色",
        "interview": "访谈对谈封面，留白多，衬线感标题，安静高级",
        "game": "游戏高光封面，对比强但不要霓虹，标题厚重有描边",
        "vlog": "生活纪实封面，自然光感，手写感弱一些，干净",
        "general": "克制专业封面，近乎单色，只用一抹克制蓝强调",
    }.get(content_type, "克制专业封面")
    lines = [
        f"为视频平台设计一张{orientation}封面。{style}。",
        f"输出约 {spec['model_w']}×{spec['model_h']}。",
        "标题文字必须完整准确，一个字都不能错，不要改写，不要增减标点：",
        f"「{joined}」",
    ]
    if subtitle.strip():
        lines.append(f"副标题写：「{subtitle.strip()}」")
    if badge.strip():
        lines.append(f"角标写：「{badge.strip()}」")
    lines.append("字号层级清楚：主标题最大，副标题次之，角标最小。")
    lines.append("主标题放在安全区内，不要贴边；颜色对比足够，必要时加细描边。")
    lines.append("不要出现画面里没要求的多余文字、水印、logo、二维码、UI 边框。")
    lines.append("不要紫色渐变、霓虹、死黑、彩色贴纸。")
    if has_reference:
        lines.append("以参考图为背景，保留人物、服装、场景，只在合适位置叠加标题。")
    else:
        lines.append("背景简洁有氛围，服务标题，不要喧宾夺主。")
    return "\n".join(lines)


def extract_frame_jpeg(video_path: Path, at_sec: float = 0.5, *, max_width: int = 1280) -> bytes:
    """从视频截一帧 JPEG。发布兜底和参考帧都用它。"""
    from backend.utils.ffmpeg_utils import get_ffmpeg_path

    path = Path(video_path)
    if not path.exists() or path.stat().st_size <= 0:
        raise CoverError("视频是空的")
    ffmpeg_bin = get_ffmpeg_path() or "ffmpeg"
    import tempfile

    with tempfile.TemporaryDirectory(prefix="autoclip-cover-frame-") as tmp:
        out = Path(tmp) / "frame.jpg"
        cmd = [
            ffmpeg_bin, "-y",
            "-ss", f"{max(0.0, float(at_sec)):.3f}",
            "-i", str(path),
            "-frames:v", "1",
            "-vf", f"scale='min({int(max_width)},iw)':-2",
            "-q:v", "3",
            str(out),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not out.exists() or out.stat().st_size <= 0:
            cmd[cmd.index("-ss") + 1] = "0"
            proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not out.exists() or out.stat().st_size <= 0:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            raise CoverError("截帧失败" + (f"：{detail[-1]}" if detail else ""))
        return out.read_bytes()


def _pil_font(size: int):
    from PIL import ImageFont

    font_path = resolve_cjk_font()
    if font_path is None:
        return ImageFont.load_default()
    try:
        return ImageFont.truetype(str(font_path), size=size)
    except OSError:
        return ImageFont.load_default()


def overlay_title(
    background: bytes,
    *,
    title_lines: list[str],
    subtitle: str = "",
    badge: str = "",
    width: int,
    height: int,
    image_layout: str = 'crop',
    title_position: str = 'bottom',
) -> bytes:
    from PIL import Image, ImageDraw, ImageFilter, ImageOps

    img = Image.open(io.BytesIO(background)).convert("RGB")
    if image_layout == 'fit':
        background_img = ImageOps.fit(img, (width, height), method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(max(8, width * .025)))
        foreground = ImageOps.contain(img, (width, height), method=Image.Resampling.LANCZOS)
        background_img.paste(foreground, ((width - foreground.width) // 2, (height - foreground.height) // 2))
        img = background_img
    else:
        img = ImageOps.fit(img, (width, height), method=Image.Resampling.LANCZOS)
    # 所选文字区域渐隐，保证白字可读；完整画面模式保留人物边缘。
    shade = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    for y in range(height // 2, height):
        alpha = int(180 * ((y - height / 2) / (height / 2)))
        row = height - 1 - y if title_position == 'top' else y
        shade_draw.line([(0, row), (width, row)], fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img.convert("RGBA"), shade).convert("RGB")
    draw = ImageDraw.Draw(img)
    title_size = max(36, int(width * 0.055))
    sub_size = max(22, int(width * 0.028))
    badge_size = max(18, int(width * 0.022))
    margin_x = int(width * 0.06)
    def fitting_font(texts: list[str], size: int):
        font = _pil_font(size)
        while size > 8 and any(draw.textlength(text, font=font) > width - margin_x * 2 - 3 for text in texts):
            size -= 1
            font = _pil_font(size)
        return font
    title_font = fitting_font(title_lines[:3], title_size)
    sub_font = fitting_font([subtitle.strip()], sub_size)
    badge_font = fitting_font([badge.strip()], badge_size)
    y = int(height * (.12 if title_position == 'top' else .58))
    for line in title_lines[:3]:
        draw.text((margin_x + 2, y + 2), line, font=title_font, fill=(0, 0, 0), anchor='lt')
        draw.text((margin_x, y), line, font=title_font, fill=(255, 255, 255), anchor='lt')
        bbox = draw.textbbox((margin_x, y), line, font=title_font, anchor='lt')
        y = bbox[3] + int(title_size * 0.18)
    if subtitle.strip():
        draw.text((margin_x + 1, y + 8), subtitle.strip(), font=sub_font, fill=(0, 0, 0), anchor='lt')
        draw.text((margin_x, y + 7), subtitle.strip(), font=sub_font, fill=(230, 230, 228), anchor='lt')
    if badge.strip():
        draw.text((margin_x, int(height * 0.06)), badge.strip(), font=badge_font, fill=(210, 210, 208), anchor='lt')
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue()


def fit_jpeg(image: bytes, width: int, height: int) -> bytes:
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(image)).convert("RGB")
    img = ImageOps.fit(img, (width, height), method=Image.Resampling.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue()


def _normalize_ocr(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", text or "", flags=re.UNICODE).lower()


def title_matches(ocr_text: str, title_lines: list[str]) -> bool:
    hay = _normalize_ocr(ocr_text)
    if not hay:
        return False
    needed = [_normalize_ocr(line) for line in title_lines if _normalize_ocr(line)]
    if not needed:
        return True
    return all(part in hay for part in needed)


def load_cover_clip(project_id: str, clip_id: str) -> dict[str, Any]:
    # A draft is a cover-only source, never a publishable/exported video.
    if not clip_id.startswith('draft-'):
        return load_clip_meta(project_id, clip_id)
    from backend.services.studio import store
    identifier = clip_id.removeprefix('draft-')
    if not re.fullmatch(r'[a-f0-9]{32}', identifier):
        raise FileNotFoundError('无效的封面草稿引用')
    draft = next((item for item in store.read(project_id)['drafts'] if item['id'] == identifier), None)
    if not draft or not draft['scenes']:
        raise FileNotFoundError('封面草稿不存在')
    from backend.pipeline.quality import to_srt_time
    scene = draft['scenes'][0]
    packaging = draft.get('packaging') or {}
    return {'id': clip_id, 'title': draft['title'], 'start_time': to_srt_time(scene['start']), 'end_time': to_srt_time(scene['end']),
            'draft_id': identifier, 'draft_revision': draft['revision'], 'scenes': draft['scenes'],
            'cover_title_lines': packaging.get('title_lines'), 'cover_title_accent_line': packaging.get('title_accent_line', 1)}


def resolve_clip_frame(project_id: str, clip_id: str, *, snapshot: dict[str, Any] | None = None) -> tuple[Path, float]:
    clip = snapshot if snapshot is not None else load_cover_clip(project_id, clip_id)
    video = Path(clip['video_path']) if clip.get('source_type') == 'studio' else find_source_video(project_id)
    start = to_seconds(clip.get("start_time") or "0")
    end = to_seconds(clip.get("end_time") or clip.get("start_time") or "0")
    at = start + min(max(0, end - start - .01), max(0.3, min(2.0, (end - start) * 0.2 if end > start else 0.5)))
    return video, at


def write_cover_meta(project_id: str, clip_id: str, platform: str, meta: dict[str, Any]) -> None:
    meta_path(project_id, clip_id, platform).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def read_cover_meta(project_id: str, clip_id: str, platform: str) -> dict[str, Any] | None:
    path = meta_path(project_id, clip_id, platform)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def draft_cover_for_export(project_id: str, clip_id: str, platform: str) -> str | None:
    if not clip_id.startswith('studio-'):
        return None
    from backend.services.studio import store
    data = store.read(project_id)
    job = next((item for item in data['jobs'] if item['job_id'] == clip_id.removeprefix('studio-') and item['status'] == 'completed'), None)
    custom = (data.get('cclip_draft_covers') or {}).get(job.get('draft_id')) if job else None
    if custom and custom['platform'] == platform and custom['draft_revision'] == job.get('revision'):
        target = 'draft-' + job['draft_id']
        path = cover_path(project_id, target, platform)
        if path.is_file() and path.stat().st_size:
            return target
    return None


def get_cover(project_id: str, clip_id: str, platform: str = "bilibili") -> dict[str, Any] | None:
    platform = normalize_platform(platform)
    custom = draft_cover_for_export(project_id, clip_id, platform)
    if custom:
        return get_cover(project_id, custom, platform)
    path = cover_path(project_id, clip_id, platform)
    if not path.exists() or path.stat().st_size <= 0:
        return None
    meta = read_cover_meta(project_id, clip_id, platform) or {}
    return {
        "ok": True,
        "platform": platform,
        "path": str(path),
        "url": f"/api/v1/publish/covers/{project_id}/clips/{clip_id}/file?platform={platform}&t={path.stat().st_mtime_ns}",
        "method": meta.get("method") or "unknown",
        "title": meta.get("title") or "",
        "subtitle": meta.get("subtitle") or "",
        "badge": meta.get("badge") or "",
        "content_type": meta.get("content_type") or "general",
        "warning": meta.get("warning"),
        **{key: meta[key] for key in ('frame_time', 'image_layout', 'title_position', 'reference_sent', 'local_template', 'palette') if key in meta},
    }


def ensure_publish_cover_jpeg(
    project_id: str,
    clip_id: str,
    *,
    platform: str = "bilibili",
    video_path: Path | None = None,
) -> bytes | None:
    """投稿用封面字节。优先已生成的设计封面；没有就截帧。失败返回 None，不抛。"""
    platform = normalize_platform(platform)
    custom = draft_cover_for_export(project_id, clip_id, platform)
    existing = cover_path(project_id, custom or clip_id, platform)
    if existing.exists() and existing.stat().st_size > 0:
        try:
            return existing.read_bytes()
        except OSError as exc:
            logger.warning("读取设计封面失败: %s", exc)
    path = Path(video_path) if video_path else None
    try:
        if path is None or not path.exists():
            path, at = resolve_clip_frame(project_id, clip_id)
        else:
            at = 0.5
        return extract_frame_jpeg(path, at_sec=at)
    except Exception as exc:  # noqa: BLE001
        logger.warning("投稿封面截帧失败，将空封面继续: %s", exc)
        return None


def generate_cover(
    *,
    project_id: str,
    clip_id: str,
    platform: str = "bilibili",
    title: str | None = None,
    subtitle: str | None = None,
    badge: str | None = None,
    content_type: str | None = None,
    force_local: bool = False,
    require_ai: bool = False,
    frame_time: float | None = None,
    image_layout: str = 'crop',
    title_position: str = 'bottom',
    send_reference: bool | None = None,
    local_template: str = 'overlay',
    palette: str = 'azure',
    session: Any = None,
    cancel: threading.Event | None = None,
    poll_interval: float = 1.5,
) -> dict[str, Any]:
    """生成并落盘封面。任何一步失败都尽量截帧兜底，仍失败才抛 CoverError。"""
    platform = normalize_platform(platform)
    spec = PLATFORMS[platform]
    clip = load_cover_clip(project_id, clip_id)
    title_text = (title if title is not None else (
        clip.get("generated_title") or clip.get("title") or clip.get("outline") or f"切片 {clip_id}"
    )).strip() or f"切片 {clip_id}"
    sub_text = (subtitle if subtitle is not None else "").strip()
    badge_text = (badge if badge is not None else "").strip()
    kind = (content_type or infer_content_type(title_text, sub_text)).strip().lower()
    if kind not in CONTENT_TYPES:
        kind = "general"
    lines = split_title(title_text, preserve_full=clip_id.startswith('draft-') or image_layout == 'fit')
    cfg = load_config()
    if require_ai and (force_local or not cfg.enabled or not cfg.configured):
        raise CoverError('请先在封面设置中启用并配置图像模型；上一张封面已保留')
    if send_reference and not force_local and not cfg.allow_send_frame:
        raise CoverError('请先在封面设置中允许发送参考画面')
    if image_layout not in ('crop', 'fit') or title_position not in ('top', 'bottom'):
        raise CoverError('无效的封面构图或文字位置')
    warning = None
    method = "frame"
    jpeg: bytes | None = None
    video, at = resolve_clip_frame(project_id, clip_id, snapshot=clip)
    if frame_time is not None:
        ranges = clip.get('scenes') or [{'start': to_seconds(clip.get('start_time') or '0'), 'end': to_seconds(clip.get('end_time') or '0')}]
        if not math.isfinite(frame_time) or not any(scene['start'] <= frame_time < scene['end'] for scene in ranges):
            raise CoverError('请选择当前片段保留范围内的画面')
        at = frame_time
    frame: bytes | None = None
    try:
        frame = extract_frame_jpeg(video, at_sec=at)
    except CoverError as exc:
        logger.warning("参考帧截取失败: %s", exc)

    # 未同意上传参考帧时仍可文生图；同意后才把截帧送给第三方。
    use_model = not force_local and cfg.enabled and cfg.configured
    send_frame = bool(use_model and cfg.allow_send_frame and send_reference is not False and frame is not None)
    if send_reference and use_model and frame is None:
        raise CoverError('无法取得所选参考画面；请换一帧后重试')
    overlay_options = {'image_layout': image_layout, 'title_position': title_position}
    if force_local and local_template == 'autoclip':
        if frame is None:
            raise CoverError('无法取得所选画面；上一张封面已保留')
        from backend.services.cover_local import render
        jpeg = render(frame, width=spec['width'], height=spec['height'], title=title_text, subtitle=sub_text,
                      badge=badge_text, local_template=local_template, palette=palette,
                      preferred_lines=clip.get('cover_title_lines'), accent_line=clip.get('cover_title_accent_line', 1))
        method = 'design'

    if use_model:
        prompt = build_prompt(
            title_lines=lines,
            subtitle=sub_text,
            badge=badge_text,
            platform=platform,
            content_type=kind,
            has_reference=send_frame,
        )
        request = ImageRequest(
            prompt=prompt,
            width=spec["model_w"],
            height=spec["model_h"],
            reference=frame if send_frame else None,
            model=cfg.model,
            ocr_model=cfg.ocr_model,
        )
        try:
            if cancel is not None and cancel.is_set():
                raise CoverError("已取消")
            generated = generate_image(
                provider=cfg.provider,
                api_key=cfg.api_key,
                base_url=cfg.base_url,
                request=request,
                session=session,
                cancel=cancel,
                poll_interval=poll_interval,
            )
            fitted = fit_jpeg(generated, spec["width"], spec["height"])
            ok_text = True
            if cfg.ocr_model or cfg.provider:
                try:
                    ocr = read_image_text(**verify_endpoint(cfg), image=fitted, session=session)
                    ok_text = title_matches(ocr, lines)
                except ImageError as exc:
                    logger.info("封面 OCR 跳过: %s", exc)
                    ok_text = True
            if not ok_text:
                # 重试一次：无参考帧纯文生图，或换本地排版
                retry_req = ImageRequest(
                    prompt=prompt + "\n再次核对：标题每个字都必须正确。",
                    width=spec["model_w"],
                    height=spec["model_h"],
                    reference=None,
                    model=cfg.model,
                )
                try:
                    generated = generate_image(
                        provider=cfg.provider,
                        api_key=cfg.api_key,
                        base_url=cfg.base_url,
                        request=retry_req,
                        session=session,
                        cancel=cancel,
                        poll_interval=poll_interval,
                    )
                    fitted = fit_jpeg(generated, spec["width"], spec["height"])
                    try:
                        ocr = read_image_text(**verify_endpoint(cfg), image=fitted, session=session)
                        ok_text = title_matches(ocr, lines)
                    except ImageError:
                        ok_text = False
                    send_frame = False
                except ImageError:
                    ok_text = False
            if ok_text:
                jpeg = fitted
                method = "model" if send_frame else "model_bg"
            else:
                if require_ai:
                    raise CoverError('AI 封面标题校对未通过；上一张封面已保留，请修改文字后重试')
                warning = "生图标题校对未通过，已改成本地排版"
                if frame is not None:
                    jpeg = overlay_title(
                        frame, title_lines=lines, subtitle=sub_text, badge=badge_text,
                        width=spec["width"], height=spec["height"],
                        **overlay_options,
                    )
                    method = "local_overlay"
        except ImageError as exc:
            if require_ai:
                raise CoverError('AI 封面生成失败；上一张封面已保留，请检查图像模型后重试') from exc
            warning = f"生图失败，已改成本地排版或截帧：{exc}"
            logger.warning("封面生图失败: %s", exc)
            if getattr(exc, "unsupported_edit", False) and frame is not None:
                # 不能图生图：背景用截帧，本地写字
                pass
            if frame is not None:
                try:
                    jpeg = overlay_title(
                        frame, title_lines=lines, subtitle=sub_text, badge=badge_text,
                        width=spec["width"], height=spec["height"],
                        **overlay_options,
                    )
                    method = "local_overlay"
                except Exception as overlay_exc:  # noqa: BLE001
                    logger.warning("本地排版失败: %s", overlay_exc)

    if jpeg is None and frame is not None:
        # 未开生图或模型不可用：本地排版叠在截帧上
        try:
            jpeg = overlay_title(
                frame, title_lines=lines, subtitle=sub_text, badge=badge_text,
                width=spec["width"], height=spec["height"],
                **overlay_options,
            )
            method = "local_overlay"
            if warning is None and not (cfg.enabled and cfg.configured):
                warning = None
        except Exception as exc:  # noqa: BLE001
            logger.warning("本地排版失败，退回截帧: %s", exc)

    if jpeg is None:
        if frame is not None:
            jpeg = fit_jpeg(frame, spec["width"], spec["height"])
            method = "frame"
            warning = warning or "已用视频截帧作为封面"
        else:
            raise CoverError("封面生成失败，也截不到帧")

    if cancel is not None and cancel.is_set():
        raise CoverError("已取消")

    out = cover_path(project_id, clip_id, platform)
    out.write_bytes(jpeg)
    meta = {
        "method": method,
        "title": title_text,
        "subtitle": sub_text,
        "badge": badge_text,
        "content_type": kind,
        "platform": platform,
        "width": spec["width"],
        "height": spec["height"],
        "warning": warning,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        'title_lines': lines,
        'frame_time': at, 'image_layout': image_layout, 'title_position': title_position,
        'local_template': local_template, 'palette': palette,
        'reference_sent': bool(send_frame and method == 'model'),
    }
    write_cover_meta(project_id, clip_id, platform, meta)
    result = {
        "ok": True,
        "platform": platform,
        "path": str(out),
        "url": f"/api/v1/publish/covers/{project_id}/clips/{clip_id}/file?platform={platform}&t={time.time_ns()}",
        "method": method,
        "title": title_text,
        "subtitle": sub_text,
        "badge": badge_text,
        "content_type": kind,
        "warning": warning,
        **{key: meta[key] for key in ('frame_time', 'image_layout', 'title_position', 'reference_sent', 'local_template', 'palette')},
    }
    if clip.get('draft_id'):
        from backend.services.studio import store
        store.change(project_id, lambda data: data.setdefault('cclip_draft_covers', {}).update({clip['draft_id']: {
            'url': result['url'], 'platform': platform, 'draft_revision': clip['draft_revision']}}))
    return result


def _jobs_dir() -> Path:
    from backend.core.path_utils import get_data_directory
    directory = get_data_directory() / "cover_jobs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _remember_job(job: dict[str, Any]) -> None:
    stored = dict(job)
    draft_cover = str(stored.get('clip_id', '')).startswith('draft-')
    if draft_cover:
        from backend.services.studio import store
        stored['instance'] = store.INSTANCE
    with _jobs_lock:
        _jobs[stored["job_id"]] = stored
        path = _jobs_dir() / f"{stored['job_id']}.json"
        path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
    if draft_cover:
        def remember(data):
            jobs = data.setdefault('cclip_cover_jobs', {})
            jobs[stored['job_id']] = {key: stored[key] for key in ('job_id', 'clip_id', 'platform', 'status', 'instance', 'error') if key in stored}
            finished = [key for key, value in jobs.items() if value['status'] not in {'queued', 'running'}]
            for key in finished[:-50]:
                jobs.pop(key)
        store.change(stored['project_id'], remember)


def _read_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        cached = _jobs.get(job_id)
        if cached is not None:
            return dict(cached)
    path = _jobs_dir() / f"{job_id}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def get_job(job_id: str) -> dict[str, Any] | None:
    job = _read_job(job_id)
    if job and str(job.get('clip_id', '')).startswith('draft-') and job['status'] in {'queued', 'running'}:
        from backend.services.studio import store
        if job.get('instance') != store.INSTANCE:
            job.update(status='failed', error='服务已重启，请重新生成封面')
            _remember_job(job)
    return job


def cancel_job(job_id: str) -> dict[str, Any]:
    event = _cancel.get(job_id)
    if event is not None:
        event.set()
    job = _read_job(job_id) or {"job_id": job_id}
    if job.get("status") in ("queued", "running"):
        job.update(status="cancelled", error="已取消")
        _remember_job(job)
    return job


def start_generate(
    *,
    project_id: str,
    clip_id: str,
    platform: str = "bilibili",
    title: str | None = None,
    subtitle: str | None = None,
    badge: str | None = None,
    content_type: str | None = None,
    force_local: bool = False,
    require_ai: bool = False,
    frame_time: float | None = None,
    image_layout: str = 'crop',
    title_position: str = 'bottom',
    send_reference: bool | None = None,
    local_template: str = 'overlay',
    palette: str = 'azure',
) -> dict[str, Any]:
    job_id = str(uuid.uuid4())
    event = threading.Event()
    _cancel[job_id] = event
    _remember_job({
        "job_id": job_id,
        "status": "queued",
        "project_id": project_id,
        "clip_id": clip_id,
        "platform": normalize_platform(platform),
    })
    threading.Thread(
        target=_run_job,
        args=(job_id, {
            "project_id": project_id,
            "clip_id": clip_id,
            "platform": platform,
            "title": title,
            "subtitle": subtitle,
            "badge": badge,
            "content_type": content_type,
            "force_local": force_local,
            'require_ai': require_ai, 'frame_time': frame_time, 'image_layout': image_layout,
            'title_position': title_position, 'send_reference': send_reference,
            'local_template': local_template, 'palette': palette,
        }),
        daemon=True,
        name=f"cover-{job_id[:8]}",
    ).start()
    return {"ok": True, "job_id": job_id, "status": "queued"}


def _run_job(job_id: str, params: dict[str, Any]) -> None:
    job = _read_job(job_id) or {"job_id": job_id}
    job.update(status="running")
    _remember_job(job)
    try:
        result = generate_cover(cancel=_cancel.get(job_id), **params)
        job.update(status="completed", result=result)
        _remember_job(job)
    except CoverError as exc:
        if str(exc) == "已取消":
            job.update(status="cancelled", error=str(exc))
        elif params.get('require_ai'):
            job.update(status='failed', error=str(exc))
        else:
            # 最后再试一次纯截帧，尽量给发布页一张图
            try:
                fallback = generate_cover(
                    project_id=params["project_id"],
                    clip_id=params["clip_id"],
                    platform=params.get("platform") or "bilibili",
                    title=params.get("title"),
                    subtitle=params.get("subtitle"),
                    badge=params.get("badge"),
                    content_type=params.get("content_type"),
                    force_local=True,
                    cancel=_cancel.get(job_id),
                )
                fallback["warning"] = str(exc)
                job.update(status="completed", result=fallback)
            except Exception as fallback_exc:  # noqa: BLE001
                job.update(status="failed", error=str(exc) or str(fallback_exc))
        _remember_job(job)
    except Exception as exc:  # noqa: BLE001
        logger.exception("封面任务失败")
        job.update(status="failed", error=str(exc))
        _remember_job(job)
    finally:
        _cancel.pop(job_id, None)
