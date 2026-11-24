"""Clipora web server (FastAPI). Serves the website and the API.

Run:  python run_server.py            (see README for Kaggle/Colab)
"""
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import time
import zipfile
from contextlib import asynccontextmanager

import requests
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from clipora import config, jobs
from clipora.pipeline import clip_download_name

WEB = Path(__file__).resolve().parent.parent / "web"
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "40000"))
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


def _load_secret():
    """Keep the login-cookie key on disk so a server restart doesn't log you out."""
    f = config.DATA / ".session_key"
    try:
        if f.exists() and len(f.read_bytes()) == 32:
            return f.read_bytes()
        key = secrets.token_bytes(32)
        f.write_bytes(key)
        return key
    except OSError:
        return secrets.token_bytes(32)


_SECRET = _load_secret()
COOKIE = "clipora_session"

@asynccontextmanager
async def _lifespan(_app):
    """On start: put unfinished work back in the queues."""
    from clipora import publish
    publish.recover()
    jobs.start_worker()
    yield


app = FastAPI(title="Clipora", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=_lifespan)


# ---------------- auth (simple shared password) ----------------
def _token():
    return hmac.new(_SECRET, APP_PASSWORD.encode(), hashlib.sha256).hexdigest()


def require_auth(request: Request):
    if not APP_PASSWORD:
        return
    tok = request.cookies.get(COOKIE, "")
    if not hmac.compare_digest(tok, _token()):
        raise HTTPException(401, "Please log in")


@app.get("/api/me")
def me(request: Request):
    ok = not APP_PASSWORD or hmac.compare_digest(request.cookies.get(COOKIE, ""), _token())
    return {"auth_required": bool(APP_PASSWORD), "logged_in": ok}


_fails = {}


@app.post("/api/login")
async def login(request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    n, t = _fails.get(ip, (0, 0))
    if n >= 5 and time.time() - t < 60:
        raise HTTPException(429, "Too many attempts, wait a minute")
    body = await request.json()
    if not APP_PASSWORD or hmac.compare_digest(str(body.get("password", "")), APP_PASSWORD):
        _fails.pop(ip, None)
        response.set_cookie(COOKIE, _token(), httponly=True, samesite="lax", max_age=30 * 86400,
                            secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https")
        return {"ok": True}
    _fails[ip] = (n + 1, time.time())
    raise HTTPException(401, "Wrong password")


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


# ---------------- info / settings ----------------
@app.get("/api/status", dependencies=[Depends(require_auth)])
def status():
    from clipora.llm import provider_status
    return {
        "gpu": config.has_gpu(),
        "providers": provider_status(),
        "cookies": config.COOKIES_FILE.exists(),
        "queue": jobs._queue.qsize(),
        "defaults": config.DEFAULT_OPTIONS,
        "caption_styles": config.CAPTION_STYLES,
        "reframe_modes": config.REFRAME_MODES,
        "aspects": list(config.ASPECTS),
        "disk_free_gb": round(shutil.disk_usage(config.DATA).free / 1e9, 1),
        "logo": config.LOGO_FILE.exists(),
        "settings": config.load_settings(),
        "running": next((j["id"] for j in jobs.list_jobs() if j["status"] == "running"), None),
    }


@app.get("/api/settings", dependencies=[Depends(require_auth)])
def get_settings():
    return config.load_settings()


@app.put("/api/settings", dependencies=[Depends(require_auth)])
async def put_settings(request: Request):
    body = await request.json()
    s = config.load_settings()
    if isinstance(body.get("defaults"), dict):
        s["defaults"] = config.clean_options(body["defaults"], base=s["defaults"])
    if isinstance(body.get("brand"), dict):
        b = s.get("brand") or {}
        for k in ("name", "color"):
            if isinstance(body["brand"].get(k), str):
                b[k] = body["brand"][k].strip()[:60]
        s["brand"] = b
    config.save_settings(s)
    return s


@app.post("/api/brand/logo", dependencies=[Depends(require_auth)])
async def upload_logo(file: UploadFile = File(...)):
    import cv2
    import numpy as np
    data = await file.read(8_000_000)
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise HTTPException(400, "Please upload a PNG, JPG or WEBP image.")
    if max(img.shape[:2]) > 1200:
        f = 1200 / max(img.shape[:2])
        img = cv2.resize(img, (int(img.shape[1] * f), int(img.shape[0] * f)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(config.LOGO_FILE), img)
    return {"ok": True}


@app.delete("/api/brand/logo", dependencies=[Depends(require_auth)])
def delete_logo():
    config.LOGO_FILE.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/brand/logo.png", dependencies=[Depends(require_auth)])
def get_logo():
    if not config.LOGO_FILE.exists():
        raise HTTPException(404)
    return FileResponse(config.LOGO_FILE, media_type="image/png", headers={"Cache-Control": "no-cache"})


def _dir_size(p):
    return sum(f.stat().st_size for f in Path(p).rglob("*") if f.is_file())


@app.get("/api/storage", dependencies=[Depends(require_auth)])
def storage():
    items = []
    for j in jobs.list_jobs():
        items.append({"id": j["id"], "title": j["title"], "status": j["status"], "created": j["created"],
                      "bytes": _dir_size(jobs.job_dir(j["id"]))})
    du = shutil.disk_usage(config.DATA)
    return {"projects": items, "projects_bytes": sum(i["bytes"] for i in items),
            "cache_bytes": _dir_size(config.CACHE), "disk_total": du.total, "disk_free": du.free}


@app.post("/api/storage/clean", dependencies=[Depends(require_auth)])
async def storage_clean(request: Request):
    """Delete finished/failed projects older than N days (running/queued ones are never touched)."""
    body = await request.json()
    try:
        days = max(0.0, float(body.get("older_than_days", 7)))
    except (TypeError, ValueError):
        raise HTTPException(400, "Bad number of days")
    cutoff = time.time() - days * 86400
    removed, freed = [], 0
    for j in jobs.list_jobs():
        if j["status"] in ("done", "error") and (j.get("updated") or j["created"]) < cutoff:
            freed += _dir_size(jobs.job_dir(j["id"]))
            jobs.delete(j["id"])
            removed.append(j["id"])
    up = config.CACHE / "uploads"
    if up.exists():  # half-finished uploads older than a day
        for f in up.iterdir():
            if f.is_file() and f.stat().st_mtime < time.time() - 86400:
                freed += f.stat().st_size
                f.unlink(missing_ok=True)
    return {"removed": removed, "freed_bytes": freed}


@app.post("/api/ai/rewrite", dependencies=[Depends(require_auth)])
async def ai_rewrite(request: Request):
    """Ask the free LLMs for a fresh title / description / hashtags / hook."""
    from clipora import llm
    body = await request.json()
    field = body.get("field")
    if field not in ("title", "description", "hashtags", "hook"):
        raise HTTPException(400, "Unknown field")
    if not any(p["has_key"] for p in llm.provider_status()):
        raise HTTPException(400, "Add a free AI key (Groq or Gemini) in your Kaggle/Colab secrets to use AI rewrite.")
    text = str(body.get("transcript", ""))[:4000]
    current = str(body.get("current", ""))[:600]
    asks = {
        "title": "a short, catchy, curiosity-driven title (max 70 characters)",
        "hook": "a punchy on-screen hook of 3-7 words",
        "description": "a 1-2 sentence post caption that makes people want to watch, with 1 emoji max",
        "hashtags": "5-8 relevant hashtags",
    }
    system = ("You write viral short-form video copy. Reply with ONLY JSON: {\"result\": ...} where result is a "
              "string, or a list of strings for hashtags. Use the same language as the transcript.")
    user = (f"Write {asks[field]} for this clip. Make it different from the current one.\n"
            f"Current: {current}\n\nClip transcript:\n{text}")

    def valid(t):
        try:
            m = re.search(r"\{.*\}", t or "", flags=re.S)
            return json.loads(m.group(0)).get("result") if m else None
        except Exception:
            return None
    import asyncio
    router = llm._router or llm.get_router()
    out = valid(await asyncio.to_thread(router.chat, system, user, 800, valid))
    if not out:
        raise HTTPException(503, "The AI providers are busy right now — try again in a minute.")
    if field == "hashtags":
        tags = out if isinstance(out, list) else str(out).split()
        tags = [str(x).strip().replace(" ", "") for x in tags]
        out = [t if t.startswith("#") else f"#{t}" for t in tags if t][:10]
    else:
        out = str(out).strip().strip('"')[:500]
    return {"result": out}


@app.post("/api/cookies", dependencies=[Depends(require_auth)])
async def upload_cookies(file: UploadFile = File(...)):
    data = await file.read(5_000_000)
    text = data.decode("utf-8", errors="ignore")
    if "youtube.com" not in text and "# Netscape" not in text:
        raise HTTPException(400, "That doesn't look like a cookies.txt file (Netscape format).")
    config.COOKIES_FILE.write_text(text, encoding="utf-8")
    return {"ok": True}


@app.delete("/api/cookies", dependencies=[Depends(require_auth)])
def delete_cookies():
    config.COOKIES_FILE.unlink(missing_ok=True)
    return {"ok": True}


# ---------------- jobs ----------------
def _public(job, log_tail=150):
    j = dict(job)
    j["log"] = job.get("log", [])[-log_tail:]
    j["queue_position"] = jobs.queue_position(job["id"]) if job["status"] == "queued" else 0
    from clipora.render import clip_options
    j["thumb_url"] = f"/media/{job['id']}/thumb.jpg" if job.get("duration") else None
    from clipora.pipeline import _video_path
    j["source_url"] = f"/media/{job['id']}/source" if job.get("duration") and _video_path(job["id"]) else None
    for c in j.get("clips", []):
        c["url"] = f"/media/{job['id']}/{c['file']}?v={c.get('version', 0)}" if c.get("file") else None
        poster = Path(c["file"]).with_suffix(".jpg").name if c.get("file") else None
        c["poster"] = f"/media/{job['id']}/{poster}?v={c.get('version', 0)}" if poster else None
        c["download_name"] = clip_download_name(c)
        c["effective"] = {k: v for k, v in clip_options(job["options"], c).items() if k in config.CLIP_OVERRIDE_KEYS}
    return j


@app.get("/api/jobs", dependencies=[Depends(require_auth)])
def list_jobs():
    return jobs.list_jobs()


VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi")
UPLOADS = config.CACHE / "uploads"


def _upload_paths(upload_id):
    if not re.fullmatch(r"[a-f0-9]{16,32}", upload_id or ""):
        raise HTTPException(400, "Bad upload id")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    return UPLOADS / f"{upload_id}.part", UPLOADS / f"{upload_id}.json"


@app.post("/api/uploads/{upload_id}", dependencies=[Depends(require_auth)])
async def upload_chunk(upload_id: str, index: int = Form(...), chunk: UploadFile = File(...), size: int = Form(0)):
    """Receive a big file in pieces (the free public link only allows ~100 MB per request)."""
    part, meta = _upload_paths(upload_id)
    expected = json.loads(meta.read_text())["next"] if meta.exists() else 0
    if index == 0:
        part.unlink(missing_ok=True)
        expected = 0
        if size:  # refuse up front instead of failing hours into the upload
            free = shutil.disk_usage(config.DATA).free
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                raise HTTPException(413, f"File too big (max {MAX_UPLOAD_MB // 1024} GB). Split it into parts, "
                                         f"or paste the link instead (long streams download audio only).")
            if size > free - 3 * 1024 ** 3:
                raise HTTPException(507, f"Not enough disk space on the server: the file is {size / 1024 ** 3:.1f} GB "
                                         f"but only {free / 1024 ** 3:.1f} GB is free. Shrink it to 720p or split it, "
                                         f"delete old projects in Settings → Storage, or paste the link instead.")
    if index != expected:
        raise HTTPException(409, f"Expected piece {expected}, got {index}")
    size = part.stat().st_size if part.exists() else 0
    with open(part, "ab") as fh:
        while data := await chunk.read(1024 * 1024):
            size += len(data)
            if size > MAX_UPLOAD_MB * 1024 * 1024:
                fh.close()
                part.unlink(missing_ok=True)
                meta.unlink(missing_ok=True)
                raise HTTPException(413, f"File too big (max {MAX_UPLOAD_MB} MB)")
            fh.write(data)
    meta.write_text(json.dumps({"next": index + 1, "size": size}))
    return {"ok": True, "received": index + 1, "size": size}


@app.post("/api/jobs", dependencies=[Depends(require_auth)])
async def create_job(url: str = Form(""), options: str = Form("{}"), file: UploadFile | None = File(None),
                     upload_id: str = Form(""), upload_name: str = Form("")):
    try:
        opts = config.clean_options(json.loads(options or "{}"))
    except json.JSONDecodeError:
        raise HTTPException(400, "Bad options")
    url = (url or "").strip()
    if upload_id:  # file sent earlier in pieces via /api/uploads
        part, meta = _upload_paths(upload_id)
        ext = Path(upload_name).suffix.lower()
        if ext not in VIDEO_EXTS:
            raise HTTPException(400, "Please upload a video file (mp4, mov, mkv, webm).")
        if not part.exists() or part.stat().st_size == 0:
            raise HTTPException(400, "Upload not found — please try again.")
        dest = part.with_name("source" + (ext if ext in (".mp4", ".mov", ".mkv", ".webm") else ".mp4"))
        tmp_dir = UPLOADS / upload_id
        tmp_dir.mkdir(exist_ok=True)
        dest = tmp_dir / dest.name
        part.replace(dest)
        meta.unlink(missing_ok=True)
        job = jobs.create({"kind": "upload", "name": Path(upload_name).name[:200]}, opts, file_path=dest)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return _public(job)
    if file is not None and file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in VIDEO_EXTS:
            raise HTTPException(400, "Please upload a video file (mp4, mov, mkv, webm).")
        tmp_id = "upload-" + secrets.token_hex(6)
        tmp_dir = config.CACHE / tmp_id
        tmp_dir.mkdir(parents=True)
        dest = tmp_dir / ("source" + (ext if ext in (".mp4", ".mov", ".mkv", ".webm") else ".mp4"))
        size = 0
        with open(dest, "wb") as fh:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_MB * 1024 * 1024:
                    fh.close()
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    raise HTTPException(413, f"File too big (max {MAX_UPLOAD_MB} MB)")
                fh.write(chunk)
        job = jobs.create({"kind": "upload", "name": Path(file.filename).name}, opts, file_path=dest)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return _public(job)
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Paste a video link (starting with https://) or choose a file.")
    return _public(jobs.create({"kind": "url", "url": url}, opts))


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def get_job(job_id: str):
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return _public(job)


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def delete_job(job_id: str):
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] == "running":
        raise HTTPException(409, "This job is running — wait until it finishes.")
    jobs.delete(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry", dependencies=[Depends(require_auth)])
def retry_job(job_id: str):
    job = jobs.update(job_id, lambda j: j.update(status="queued", error=None, message="Waiting in queue...",
                                                 progress=0.0) if j["status"] == "error" else None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] == "queued":
        jobs.enqueue(("job", job_id))
    return _public(job)


@app.post("/api/jobs/{job_id}/clips/{index}", dependencies=[Depends(require_auth)])
async def edit_clip(job_id: str, index: int, request: Request):
    """Change a clip (start/end/hook/title/style/layout) and queue a re-render."""
    body = await request.json()
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    k = next((i for i, c in enumerate(job["clips"]) if c["index"] == index), None)
    if k is None:
        raise HTTPException(404, "Clip not found")
    if job["clips"][k].get("status") in ("rendering", "queued") and job["status"] != "done":
        raise HTTPException(409, "This clip is still being made")
    dur = job.get("duration") or 1e9
    err = None

    def f(j):
        nonlocal err
        c = j["clips"][k]
        s = float(body.get("start", c["start"]))
        e = float(body.get("end", c["end"]))
        s, e = max(0.0, s), min(dur, e)
        if e - s < 3:
            err = "A clip must be at least 3 seconds long"
            return
        if e - s > 300:
            err = "A clip can be at most 5 minutes long"
            return
        c["start"], c["end"] = round(s, 2), round(e, 2)
        for key in ("title", "hook", "description"):
            if key in body and isinstance(body[key], str):
                c[key] = body[key][:500]
        if isinstance(body.get("hashtags"), list):
            c["hashtags"] = [str(t)[:40] for t in body["hashtags"]][:10]
        c.update(config.clean_options(body, base=j["options"], only=config.CLIP_OVERRIDE_KEYS))
        if isinstance(body.get("cuts"), list):
            cuts = []
            for x in body["cuts"][:300]:
                try:
                    a, b = float(x[0]), float(x[1])
                except (TypeError, ValueError, IndexError):
                    continue
                if b > a:
                    cuts.append([round(a, 3), round(b, 3)])
            c["cuts"] = cuts
        if body.get("render", True):
            c["status"] = "queued"
    job = jobs.update(job_id, f)
    if err:
        raise HTTPException(400, err)
    if body.get("render", True):
        jobs.enqueue(("rerender", job_id, index))
    return _public(job)


@app.get("/api/jobs/{job_id}/transcript", dependencies=[Depends(require_auth)])
def transcript(job_id: str, start: float = 0, end: float = 1e9, pad: float = 45):
    """Transcript lines around a clip, so the editor can set start/end by clicking a sentence."""
    if not jobs.load(job_id):
        raise HTTPException(404, "Job not found")
    p = jobs.job_dir(job_id) / "transcript.json"
    if not p.exists():
        return {"segments": []}
    data = json.loads(p.read_text(encoding="utf-8"))
    segs = [{"s": s["s"], "e": s["e"], "text": s["text"]} for s in data["segments"]
            if s["e"] >= start - pad and s["s"] <= end + pad]
    return {"segments": segs[:400]}


@app.delete("/api/jobs/{job_id}/clips/{index}", dependencies=[Depends(require_auth)])
def delete_clip(job_id: str, index: int):
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    clip = next((c for c in job["clips"] if c["index"] == index), None)
    if clip is None:
        raise HTTPException(404, "Clip not found")
    if clip.get("status") in ("rendering", "queued"):
        raise HTTPException(409, "This clip is being made right now — wait until it finishes.")
    d = jobs.job_dir(job_id)
    if clip.get("file"):
        (d / clip["file"]).unlink(missing_ok=True)
        (d / clip["file"]).with_suffix(".jpg").unlink(missing_ok=True)
    job = jobs.update(job_id, lambda j: j.update(clips=[c for c in j["clips"] if c["index"] != index]))
    return _public(job)


@app.get("/api/jobs/{job_id}/words", dependencies=[Depends(require_auth)])
def words(job_id: str, start: float = 0, end: float = 1e9, pad: float = 60):
    """Word-level transcript around a clip (for the editor's transcript and live caption preview)."""
    if not jobs.load(job_id):
        raise HTTPException(404, "Job not found")
    p = jobs.job_dir(job_id) / "transcript.json"
    if not p.exists():
        return {"segments": []}
    data = json.loads(p.read_text(encoding="utf-8"))
    out = [{"s": s["s"], "e": s["e"], "words": s.get("words", [])} for s in data["segments"]
           if s["e"] >= start - pad and s["s"] <= end + pad]
    return {"segments": out[:600], "language": data.get("language")}


@app.get("/api/jobs/{job_id}/framing", dependencies=[Depends(require_auth)])
def framing(job_id: str, start: float = 0, end: float = 30):
    """Where the main face is in this part of the video (so the editor preview matches the render)."""
    import cv2
    import numpy as np
    from clipora.pipeline import _video_path
    from clipora.render import get_faces
    if not jobs.load(job_id):
        raise HTTPException(404, "Job not found")
    video, offset = _video_path(job_id), 0.0
    if video is None:  # long stream: use a downloaded clip section that covers this range
        job = jobs.load(job_id)
        for c in job.get("clips", []):
            sec = c.get("section")
            if sec and sec[0] <= start <= sec[1] and (jobs.job_dir(job_id) / sec[2]).exists():
                video, offset = jobs.job_dir(job_id) / sec[2], sec[0]
                break
    if video is None:
        return {"found": False}
    if offset:
        end = min(end, float(sec[1]))
    start, end = start - offset, end - offset
    cap = cv2.VideoCapture(str(video))
    fw, fh = cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    faces, found = get_faces(), []
    for t in np.linspace(start, max(start, end - 0.5), 8):
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000)
        ok, fr = cap.read()
        if ok:
            f = faces.find(fr)
            if f:
                found.append(f)
    cap.release()
    if not found or not fw:
        return {"found": False}
    med = [float(np.median([f[k] for f in found])) for k in range(4)]
    return {"found": True, "cx": med[0] / fw, "w": med[1] / fw, "cy": med[2] / fh, "h": med[3] / fh,
            "small": med[1] < fw * 0.085, "hits": len(found)}


@app.get("/api/jobs/{job_id}/waveform", dependencies=[Depends(require_auth)])
def waveform(job_id: str, start: float = 0, end: float = 60, n: int = 800):
    """Loudness peaks of the source audio between start and end (for the editor timeline)."""
    import subprocess
    import numpy as np
    from clipora.pipeline import _media_path
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    video = _media_path(job_id)  # the audio file is enough for long streams
    if video is None:
        raise HTTPException(404, "Video not found")
    start, end = max(0.0, start), min(end, (job.get("duration") or end))
    if end - start < 0.5 or end - start > 900:
        raise HTTPException(400, "Bad range")
    n = max(50, min(n, 3000))
    p = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(video),
                        "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", "-"], capture_output=True)
    a = np.frombuffer(p.stdout[:len(p.stdout) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768
    if a.size < n:
        return {"start": start, "end": end, "peaks": []}
    edges = np.linspace(0, a.size, n + 1).astype(int)
    peaks = [float(np.abs(a[edges[i]:max(edges[i] + 1, edges[i + 1])]).max()) for i in range(n)]
    top = max(peaks) or 1
    return {"start": start, "end": end, "peaks": [round(x / top, 3) for x in peaks]}


# ---------------- connections & publishing ----------------
def _yt_call(fn, *a):
    from clipora.meta import MetaError
    from clipora.youtube import YouTubeError
    try:
        return fn(*a)
    except (YouTubeError, MetaError) as e:
        raise HTTPException(400, str(e))
    except requests.RequestException:
        raise HTTPException(502, "Couldn't reach Google. Check the internet connection and try again.")


@app.get("/api/connections", dependencies=[Depends(require_auth)])
def connections():
    from clipora import youtube
    yt = youtube.status()
    if yt["connected"] and not yt["channel"]:
        try:
            yt["channel"] = youtube.channel()
        except Exception as e:
            yt["error"] = yt["error"] or str(e)[:300]
    from clipora import meta
    mt = meta.status()
    if mt["connected"] and not mt["pages"]:
        try:
            meta.refresh_accounts()
            mt = meta.status()
        except Exception as e:
            mt["error"] = mt["error"] or str(e)[:300]
    return {"yt": yt, "meta": mt}


@app.post("/api/connect/meta/start", dependencies=[Depends(require_auth)])
def meta_start():
    from clipora import meta
    return {"url": _yt_call(meta.auth_url), "redirect_uri": meta.redirect_uri()}


@app.get("/api/connect/meta/callback")
def meta_callback(code: str = "", state: str = "", error: str = "", error_description: str = ""):
    """Facebook sends the browser here after sign-in (when the site runs on the registered address)."""
    from urllib.parse import quote
    from clipora import meta
    if error:
        return RedirectResponse(f"/#/connections?meta_error={quote(error_description or error)}")
    try:
        meta.finish(code, state)
    except Exception as e:
        return RedirectResponse(f"/#/connections?meta_error={quote(str(e)[:300])}")
    return RedirectResponse("/#/connections?meta=ok")


@app.post("/api/connect/meta/finish", dependencies=[Depends(require_auth)])
def meta_finish(body: dict):
    from clipora import meta
    code, state = _yt_call(meta.parse_pasted, str(body.get("pasted", "")))
    return _yt_call(meta.finish, code, state)


@app.post("/api/connect/meta/page", dependencies=[Depends(require_auth)])
def meta_page(body: dict):
    from clipora import meta
    return _yt_call(meta.select_page, str(body.get("page_id", "")))


@app.post("/api/connect/meta/refresh", dependencies=[Depends(require_auth)])
def meta_refresh():
    from clipora import meta
    _yt_call(meta.refresh_accounts)
    return meta.status()


@app.post("/api/connect/meta/disconnect", dependencies=[Depends(require_auth)])
def meta_disconnect():
    from clipora import meta
    meta.disconnect()
    return {"ok": True}


@app.get("/api/connect/meta/token", dependencies=[Depends(require_auth)])
def meta_token():
    """The long-lived token (about 60 days), so it can be saved as META_TOKEN and survive a new session."""
    from clipora import meta
    t = meta.token_for_backup()
    if not t:
        raise HTTPException(404, "Not connected through the website (or already using the secret).")
    return {"token": t}


@app.post("/api/connect/youtube/start", dependencies=[Depends(require_auth)])
def yt_start():
    from clipora import youtube
    return {"url": _yt_call(youtube.auth_url), "redirect_uri": youtube.redirect_uri()}


@app.get("/api/connect/youtube/callback")
def yt_callback(code: str = "", state: str = "", error: str = ""):
    """Google sends the browser here after sign-in (works when the site runs on the registered address)."""
    from urllib.parse import quote
    from clipora import youtube
    if error:
        return RedirectResponse(f"/#/connections?yt_error={quote(error)}")
    try:
        youtube.finish(code, state)
    except Exception as e:
        return RedirectResponse(f"/#/connections?yt_error={quote(str(e)[:300])}")
    return RedirectResponse("/#/connections?yt=ok")


@app.post("/api/connect/youtube/finish", dependencies=[Depends(require_auth)])
def yt_finish(body: dict):
    """For Kaggle/Colab: the user pastes the address Google redirected to."""
    from clipora import youtube
    code, state = _yt_call(youtube.parse_pasted, str(body.get("pasted", "")))
    return _yt_call(youtube.finish, code, state)


@app.post("/api/connect/youtube/disconnect", dependencies=[Depends(require_auth)])
def yt_disconnect():
    from clipora import youtube
    youtube.disconnect()
    return {"ok": True}


@app.get("/api/connect/youtube/token", dependencies=[Depends(require_auth)])
def yt_token():
    """The long-term token, so it can be saved as the YOUTUBE_REFRESH_TOKEN secret (stays connected next session)."""
    from clipora import youtube
    t = youtube.refresh_token_for_backup()
    if not t:
        raise HTTPException(404, "Not connected through the website (or already using the secret).")
    return {"refresh_token": t}


@app.post("/api/jobs/{job_id}/clips/{index}/publish", dependencies=[Depends(require_auth)])
def publish_clip(job_id: str, index: int, body: dict):
    from datetime import datetime, timezone
    from clipora import meta, publish, youtube
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    clip = next((c for c in job["clips"] if c["index"] == index), None)
    if clip is None:
        raise HTTPException(404, "Clip not found")
    if clip.get("status") != "done" or not clip.get("file"):
        raise HTTPException(409, "This clip isn't rendered yet.")
    platforms = [p for p in body.get("platforms", []) if p in publish.PLATFORMS]
    if not platforms:
        raise HTTPException(400, "Pick at least one platform.")
    if "yt" in platforms and not youtube.status()["connected"]:
        raise HTTPException(400, "YouTube isn't connected. Open Connections first.")
    mt = meta.status() if {"ig", "fb"} & set(platforms) else None
    if "ig" in platforms and not (mt["connected"] and mt["ig"]):
        raise HTTPException(400, "Instagram isn't connected (or no Instagram account is linked to your Page).")
    if "fb" in platforms and not (mt["connected"] and mt["page"]):
        raise HTTPException(400, "Facebook isn't connected. Open Connections first.")
    length = clip["end"] - clip["start"]
    for plat in platforms:
        lo, hi = publish.LIMITS.get(plat, (0, 1e9))
        if not lo <= length <= hi:
            raise HTTPException(400, f"{publish.PLATFORMS[plat]} only accepts clips of {lo}-{hi} seconds via the API "
                                     f"(this one is {length:.0f}s). Trim it in the editor first.")
    title = str(body.get("title") or clip.get("title") or "Clip").strip()[:100]
    tags = body.get("hashtags") if isinstance(body.get("hashtags"), list) else clip.get("hashtags", [])
    req = {"title": title, "description": str(body.get("description") or clip.get("description") or "")[:4800],
           "hashtags": [("#" + str(t).lstrip("#"))[:40] for t in tags if str(t).strip()][:15],
           "privacy": body.get("privacy") if body.get("privacy") in ("private", "unlisted", "public") else "private",
           "made_for_kids": bool(body.get("made_for_kids")), "publish_at": None}
    if body.get("publish_at"):
        try:
            when = datetime.fromisoformat(str(body["publish_at"]).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(400, "Bad schedule time")
        if when.timestamp() < time.time() + 120:
            raise HTTPException(400, "Pick a time at least a few minutes in the future.")
        req["publish_at"] = when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def keep_text(j):  # remember the text on the clip too
        c = next(c for c in j["clips"] if c["index"] == index)
        c.update(title=req["title"], description=req["description"], hashtags=req["hashtags"])
    jobs.update(job_id, keep_text)
    for p in platforms:
        publish.create(job_id, index, p, req)
    return _public(jobs.load(job_id))


@app.get("/api/analytics/meta", dependencies=[Depends(require_auth)])
def meta_analytics():
    from clipora import meta
    if not meta.status()["connected"]:
        return {"connected": False, "videos": [], "totals": {"views": 0, "likes": 0, "comments": 0}}
    posts = [(j, p) for j in jobs.list_jobs() for p in j["posts"]
             if p["platform"] in ("ig", "fb") and p.get("video_id") and p.get("status") == "done"]
    stats = _yt_call(meta.media_stats, [p["video_id"] for _, p in posts if p["platform"] == "ig"],
                     [p["video_id"] for _, p in posts if p["platform"] == "fb"])
    vids = []
    for j, p in posts:
        st = stats.get(p["video_id"])
        if st is None:
            continue
        vids.append({**st, "platform": p["platform"], "video_id": p["video_id"], "url": st.get("url") or p["url"],
                     "job_id": j["id"], "index": p["index"], "title": p["clip_title"], "published": p.get("done_at")})
    return {"connected": True, "videos": vids,
            "totals": {k: sum(v[k] for v in vids) for k in ("views", "likes", "comments")}}


@app.get("/api/analytics/youtube", dependencies=[Depends(require_auth)])
def yt_analytics():
    from clipora import youtube
    if not youtube.status()["connected"]:
        return {"connected": False, "videos": [], "totals": {"views": 0, "likes": 0, "comments": 0}}
    posts = [(j, p) for j in jobs.list_jobs() for p in j["posts"] if p["platform"] == "yt" and p.get("video_id")]
    stats = _yt_call(youtube.video_stats, [p["video_id"] for _, p in posts])
    vids = []
    for j, p in posts:
        st = stats.get(p["video_id"])
        if st is None:  # deleted on YouTube
            continue
        vids.append({**st, "video_id": p["video_id"], "url": p["url"], "job_id": j["id"], "index": p["index"],
                     "clip_title": p["clip_title"], "published": p.get("done_at")})
    return {"connected": True, "videos": vids,
            "totals": {k: sum(v[k] for v in vids) for k in ("views", "likes", "comments")}}


@app.get("/api/jobs/{job_id}/zip", dependencies=[Depends(require_auth)])
def download_zip(job_id: str):
    job = jobs.load(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    d = jobs.job_dir(job_id)
    buf = io.BytesIO()
    meta = {"title": job.get("title"), "source": job.get("source"), "clips": []}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        lines = []
        for c in job["clips"]:
            if c.get("file") and (d / c["file"]).exists():
                name = clip_download_name(c)
                z.write(d / c["file"], name)
                meta["clips"].append({k: c.get(k) for k in ("index", "title", "hook", "description", "hashtags",
                                                             "score", "start", "end")} | {"file": name})
                lines.append(f"=== {name} ===\n{c.get('title', '')}\n\n{c.get('description', '')}\n"
                             f"{' '.join(c.get('hashtags', []))}\n")
        z.writestr("clips.json", json.dumps(meta, indent=2, ensure_ascii=False))
        z.writestr("captions.txt", "\n".join(lines))
    buf.seek(0)
    from clipora.utils import safe_name
    fname = f"{safe_name(job.get('title'), 40)}_clips.zip"
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@app.get("/media/{job_id}/{name}", dependencies=[Depends(require_auth)])
def media(job_id: str, name: str, download: str = ""):
    job = jobs.load(job_id)
    if not job or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(404)
    if name == "source":
        from clipora.pipeline import _video_path
        p = _video_path(job_id)
        if p is None:
            raise HTTPException(404)
        mime = {".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime"}.get(p.suffix, "video/mp4")
        return FileResponse(p, media_type=mime)
    if name.endswith(".jpg"):
        p = jobs.job_dir(job_id) / name
        if not p.exists():  # made lazily for projects created before thumbnails existed
            from clipora.pipeline import _video_path
            from clipora.render import make_poster
            if name == "thumb.jpg":
                srcv = _video_path(job_id)
                if srcv is None or not make_poster(srcv, p, at=min((job.get("duration") or 30) * 0.1, 30), width=640):
                    raise HTTPException(404)
            else:
                mp4 = p.with_suffix(".mp4")
                if not mp4.exists() or not make_poster(mp4, p, at=1.0):
                    raise HTTPException(404)
        return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
    if not name.endswith(".mp4"):
        raise HTTPException(404)
    p = jobs.job_dir(job_id) / name
    if not p.exists():
        raise HTTPException(404)
    headers = {"Cache-Control": "private, max-age=86400"}
    if download:
        clip = next((c for c in job["clips"] if c.get("file") == name), None)
        dl = clip_download_name(clip) if clip else name
        headers["Content-Disposition"] = f'attachment; filename="{dl}"'
    return FileResponse(p, media_type="video/mp4", headers=headers)


@app.middleware("http")
async def no_stale_site_files(request: Request, call_next):
    """Browsers must re-check the website files (cheap 304s) so an update is never hidden by an old cached copy."""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith(("/media/", "/api/")) and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)



app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
