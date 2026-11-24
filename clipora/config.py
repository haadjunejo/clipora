"""Paths and default settings. Everything can be overridden with environment variables."""
import os
from pathlib import Path


def _default_data_dir():
    if os.path.exists("/kaggle/working"):
        return "/kaggle/working/clipora-data"
    if os.path.exists("/content"):
        return "/content/clipora-data"
    return str(Path.cwd() / "data")


DATA = Path(os.environ.get("CLIPORA_DATA") or os.environ.get("CLIPPER_DATA") or _default_data_dir()).resolve()
JOBS = DATA / "jobs"
CACHE = DATA / "cache"
FONTS = CACHE / "fonts"
COOKIES_FILE = DATA / "cookies.txt"
SETTINGS_FILE = DATA / "settings.json"
BRAND = DATA / "brand"
LOGO_FILE = BRAND / "logo.png"
for _d in (JOBS, CACHE, FONTS, BRAND):
    _d.mkdir(parents=True, exist_ok=True)

OUTPUT_W, OUTPUT_H = 1080, 1920
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
WHISPER_LONG_MODEL = os.environ.get("WHISPER_LONG_MODEL", "large-v3-turbo")  # ~3-5x faster, for long videos
LONG_VIDEO_SEC = float(os.environ.get("LONG_VIDEO_SEC", 90 * 60))  # long stream mode from this length
USE_LOCAL_LLM = os.environ.get("USE_LOCAL_LLM", "1") == "1"
LOCAL_LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "Qwen/Qwen2.5-3B-Instruct")

# Per-job options the website can change. Anything missing falls back to these.
DEFAULT_OPTIONS = {
    "num_clips": 5,            # 0 = Auto (based on video length), max 100
    "min_sec": 20,
    "max_sec": 75,
    "language": None,          # None = auto-detect
    "reframe": "face",         # face | split | blur | center
    "crop_x": 0.5,             # horizontal crop position for center/split (0 = left, 1 = right)
    "caption_style": "bold_yellow",  # bold_yellow | boxed | minimal | none
    "uppercase": True,
    "words_per_line": 3,
    "show_hook": True,
    "hook_seconds": 3.0,
    "hook_position": "top",    # top | center
    "caption_size": 100,       # percent of the style's normal size
    "caption_position": "bottom",  # bottom | middle | top
    "text_color": "",          # "" = style default, else #RRGGBB
    "highlight_color": "",     # "" = style default, else #RRGGBB
    "aspect": "9:16",          # 9:16 | 1:1 | 16:9
    "remove_fillers": False,   # cut "um", "uh"...
    "remove_silences": False,  # cut long pauses
    "progress_bar": False,
    "watermark": False,        # brand logo on the video
    "watermark_position": "top_right",
    "ai_prompt": "",           # extra direction for the AI picker
    "long_mode": "auto",       # auto | on | off: audio-first download + fast chunked transcription
}

CAPTION_STYLES = ["bold_yellow", "karaoke", "boxed", "neon", "minimal", "none"]
REFRAME_MODES = ["face", "split", "blur", "center"]
MAX_CLIPS = 100
ASPECTS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}
CAPTION_POSITIONS = ["bottom", "middle", "top"]
HOOK_POSITIONS = ["top", "center"]
WATERMARK_POSITIONS = ["top_left", "top_right", "bottom_left", "bottom_right"]
# options a single clip may override from the editor
CLIP_OVERRIDE_KEYS = ["caption_style", "reframe", "crop_x", "show_hook", "hook_seconds", "hook_position", "caption_size",
                      "caption_position", "text_color", "highlight_color", "uppercase", "words_per_line",
                      "remove_fillers", "remove_silences", "progress_bar", "watermark", "watermark_position"]


def _color(v):
    import re
    return v.upper() if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v) else ""


def clean_options(raw, base=None, only=None):
    """Validate options coming from the website. `only` limits which keys are returned (clip overrides)."""
    o = dict(base or DEFAULT_OPTIONS)
    raw = raw or {}

    def num(key, lo, hi, cast=float):
        try:
            o[key] = cast(min(hi, max(lo, cast(raw[key]))))
        except (KeyError, TypeError, ValueError):
            pass

    num("num_clips", 0, MAX_CLIPS, int)
    num("crop_x", 0.0, 1.0)
    num("min_sec", 5, 180)
    num("max_sec", 10, 300)
    num("words_per_line", 1, 8, int)
    num("hook_seconds", 0.5, 10)
    num("caption_size", 50, 160, int)
    if o["max_sec"] < o["min_sec"] + 5:
        o["max_sec"] = o["min_sec"] + 5
    lang = raw.get("language")
    o["language"] = lang.strip().lower()[:8] if isinstance(lang, str) and lang.strip() else None
    if raw.get("reframe") in REFRAME_MODES:
        o["reframe"] = raw["reframe"]
    if raw.get("caption_style") in CAPTION_STYLES:
        o["caption_style"] = raw["caption_style"]
    if raw.get("long_mode") in ("auto", "on", "off"):
        o["long_mode"] = raw["long_mode"]
    for key, allowed in (("caption_position", CAPTION_POSITIONS), ("hook_position", HOOK_POSITIONS),
                         ("watermark_position", WATERMARK_POSITIONS), ("aspect", list(ASPECTS))):
        if raw.get(key) in allowed:
            o[key] = raw[key]
    for key in ("text_color", "highlight_color"):
        if key in raw:
            o[key] = _color(raw[key])
    if isinstance(raw.get("ai_prompt"), str):
        o["ai_prompt"] = raw["ai_prompt"].strip()[:500]
    for b in ("uppercase", "show_hook", "remove_fillers", "remove_silences", "progress_bar", "watermark"):
        if b in raw:
            o[b] = bool(raw[b])
    if only is not None:
        return {k: o[k] for k in only if k in raw and k in o}
    return o


def load_settings():
    import json
    try:
        s = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        s = {}
    s["defaults"] = clean_options(s.get("defaults") or {})
    return s


def save_settings(s):
    import json
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=1), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)


_HAS_GPU = None


def has_gpu():
    global _HAS_GPU
    if _HAS_GPU is None:
        try:
            import torch
            _HAS_GPU = bool(torch.cuda.is_available())
        except Exception:
            _HAS_GPU = False
    return _HAS_GPU
