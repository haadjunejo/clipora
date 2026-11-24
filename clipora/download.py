"""Get the source: from a link (yt-dlp) or an uploaded file.

Long streams use "audio first": download only the audio, transcribe + pick moments, then download just the
few-minute sections around each clip (download_section). That's ~95% less data than the whole video."""
import json
import re
import shutil
import subprocess
from pathlib import Path

from . import config

VIDEO_EXT = (".mp4", ".mkv", ".webm", ".mov")
AUDIO_EXT = (".m4a", ".webm", ".opus", ".mp3", ".ogg", ".aac", ".wav", ".mp4")
BEST_VIDEO = "bv*[height<=1080]+ba/b[height<=1080]/b"
LADDER = [  # YouTube often refuses one "player client" but accepts another
    ("default", []),
    ("tv client", ["--extractor-args", "youtube:player_client=tv,web_safari"]),
    ("mweb client", ["--extractor-args", "youtube:player_client=mweb"]),
    ("web_embedded", ["--extractor-args", "youtube:player_client=web_embedded"]),
]


def _run_ytdlp(cmd, progress):
    """Run yt-dlp, streaming its progress lines. Returns (returncode, output, title)."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    out, title = [], None
    for line in p.stdout:
        line = line.rstrip()
        out.append(line)
        if line.startswith("TITLE::"):
            title = line[7:].strip()
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m and progress:
            progress(float(m.group(1)) / 100)
    p.wait()
    return p.returncode, "\n".join(out[-60:]), title


def _cookies(job_dir, log, quiet=False):
    if not config.COOKIES_FILE.exists():
        return None
    c = Path(job_dir) / "cookies.txt"  # yt-dlp rewrites cookie files → use a copy
    shutil.copy(config.COOKIES_FILE, c)
    if not quiet:
        log("🍪 Using your uploaded YouTube cookies")
    return c


def _fail(errors, cookies):
    msg = "\n".join(errors)
    if "confirm your age" in msg or "age-restricted" in msg.lower() or "inappropriate for some users" in msg:
        hint = ("This video is age-restricted, so YouTube only shows it to a logged-in adult account. "
                "Upload a cookies.txt (Settings ⚙️) exported from a spare Google account that is 18+, "
                "or upload the video file instead." if not cookies else
                "This video is age-restricted and YouTube refused your cookies. The account must be 18+ and the "
                "cookies fresh. Export them again, or upload the video file instead.")
    elif "Sign in to confirm" in msg:
        hint = ("YouTube blocked this server. Upload a cookies.txt in Settings, or upload the video file."
                if not cookies else "YouTube refused even with cookies. Upload fresh cookies.txt (they expire).")
    elif "403" in msg:
        hint = "YouTube refused the video stream (403). Try fresh cookies, or upload the video file instead."
    else:
        hint = "Check the link is public and correct, or upload the video file instead."
    return RuntimeError(f"Download failed. {hint}\n{msg}")


def _ladder(url, job_dir, stem, fmt_args, exts, log, progress=None, label="Downloading", extra=(), quiet=False,
            last_resort=None):
    """Try each YouTube client until one works. Returns (file, title)."""
    job_dir = Path(job_dir)
    base = ["yt-dlp", "--no-playlist", "-o", str(job_dir / f"{stem}.%(ext)s"), "--newline", "--progress",
            "--retries", "5", "--fragment-retries", "10", "--print", "after_move:TITLE::%(title)s", *extra]
    cookies = _cookies(job_dir, log, quiet)
    if cookies:
        base += ["--cookies", str(cookies)]
    if not (shutil.which("deno") or shutil.which("node")) and "youtu" in url and not quiet:
        log("⚠️ No JavaScript runtime (Deno) found. YouTube may refuse downloads")
    attempts = [(n, fmt_args + a) for n, a in LADDER] if "youtu" in url else [("default", fmt_args)]
    if last_resort and "youtu" in url:
        attempts.append(last_resort)
    errors = []
    try:
        for name, args in attempts:
            for f in job_dir.glob(f"{stem}.*"):
                f.unlink()
            if not quiet:
                log(f"⬇️ {label} ({name})...")
            code, output, title = _run_ytdlp(base + args + [url], progress)
            files = sorted([f for f in job_dir.glob(f"{stem}.*") if f.suffix in exts and not f.name.endswith(".part")],
                           key=lambda f: f.stat().st_size, reverse=True)
            if code == 0 and files:
                return files[0], title
            err = [l for l in output.splitlines() if "ERROR" in l] or output.splitlines()[-1:]
            errors.append(f"[{name}] " + (err[-1] if err else "unknown error"))
            log("   " + errors[-1][:300])
            if ("Sign in to confirm" in output or "confirm your age" in output) and not cookies:
                break  # every method hits the same wall without cookies
    finally:
        if cookies:
            cookies.unlink(missing_ok=True)
    raise _fail(errors, cookies)


def probe(url, job_dir, log):
    """Length + title without downloading. Returns {} if it can't tell (the caller then downloads normally)."""
    cmd = ["yt-dlp", "--no-playlist", "-J", "--skip-download"]
    cookies = _cookies(job_dir, log, quiet=True)
    if cookies:
        cmd += ["--cookies", str(cookies)]
    try:
        for name, args in (LADDER[:2] if "youtu" in url else LADDER[:1]):
            p = subprocess.run(cmd + args + [url], capture_output=True, text=True, errors="replace", timeout=120)
            if p.returncode == 0 and p.stdout.strip():
                info = json.loads(p.stdout)
                return {"duration": info.get("duration"), "title": info.get("title"),
                        "is_live": info.get("is_live")}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        pass
    finally:
        if cookies:
            cookies.unlink(missing_ok=True)
    return {}


def download_video(url, job_dir, log, progress=None):
    return _ladder(url, job_dir, "source", ["-f", BEST_VIDEO, "--merge-output-format", "mp4"], VIDEO_EXT, log,
                   progress, last_resort=("low quality single file",
                                          ["-f", "18/b", "--extractor-args", "youtube:player_client=tv,mweb"]))


def download_audio(url, job_dir, log, progress=None):
    """Audio only (about 1 GB for 24 hours instead of 20-50 GB of video)."""
    return _ladder(url, job_dir, "audio", ["-f", "bestaudio/ba*/b"], AUDIO_EXT, log, progress,
                   label="Downloading audio only")


def download_section(url, job_dir, start, end, stem, log):
    """Just [start, end] seconds of the video, cut exactly (re-encoded at the cut points)."""
    path, _ = _ladder(url, job_dir, stem, ["-f", BEST_VIDEO, "--merge-output-format", "mp4"], VIDEO_EXT, log,
                      label=f"Downloading {end - start:.0f}s section", quiet=False,
                      extra=["--download-sections", f"*{start:.2f}-{end:.2f}", "--force-keyframes-at-cuts"])
    return path
