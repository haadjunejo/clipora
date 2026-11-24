import os
import re
import shutil
import subprocess
from pathlib import Path

import requests


def run(cmd, check=True):
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, errors="replace")
    if check and p.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(map(str, cmd))[:300]}\n{p.stderr[-2000:]}")
    return p


def ffprobe_duration(path):
    if shutil.which("ffprobe"):
        p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", path], check=False)
        try:
            return float(p.stdout.strip())
        except ValueError:
            pass
    p = run(["ffmpeg", "-hide_banner", "-i", path], check=False)
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", p.stderr)
    if not m:
        raise RuntimeError(f"Could not read video length of {path}:\n{p.stderr[-800:]}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def fmt_time(t):
    t = max(0, t or 0)
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def download_file(url, dest):
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    r = requests.get(url, timeout=60, allow_redirects=True)
    r.raise_for_status()
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(r.content)
    tmp.replace(dest)
    return dest


_secret_cache = {}


def get_secret(name):
    """Read a key from env vars, else (once per process) from Kaggle/Colab secrets. Returns None if missing.

    Kaggle rate-limits its secret service (HTTP 429), so we never ask it twice for the same name, and never
    at all when the launcher already put the secrets into the environment (CLIPORA_SECRETS_LOADED=1)."""
    if os.environ.get(name):
        return os.environ[name]
    if os.environ.get("CLIPORA_SECRETS_LOADED") == "1":
        return None
    if name in _secret_cache:
        return _secret_cache[name]
    v = None
    try:
        if os.path.exists("/kaggle/working"):
            from kaggle_secrets import UserSecretsClient  # type: ignore
            v = UserSecretsClient().get_secret(name)
        elif os.path.exists("/content"):
            from google.colab import userdata  # type: ignore
            v = userdata.get(name)
    except Exception:
        v = None
    _secret_cache[name] = v or None
    return _secret_cache[name]


def safe_name(text, max_len=50):
    s = re.sub(r"[^\w\- ]", "", text or "", flags=re.UNICODE)
    s = re.sub(r"\s+", "_", s.strip())
    s = re.sub(r"_+", "_", s)[:max_len].strip("_")
    return s or "clip"
