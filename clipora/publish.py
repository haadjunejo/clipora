"""Publishing queue: uploads run on their own worker so they never block rendering.
Each clip keeps a list of posts: clip["posts"] = [{id, platform, status, progress, url, ...}].

Status: scheduled → queued → uploading → done | error.
YouTube schedules natively (publishAt); Instagram/Facebook posts wait here until their time
(the server must be running then)."""
import queue
import threading
import time
import traceback
import uuid
from datetime import datetime

from . import jobs

_q = queue.Queue()
_worker = None
_scheduler = None
_start_lock = threading.Lock()
PLATFORMS = {"yt": "YouTube", "ig": "Instagram", "fb": "Facebook"}
META_GAP = 120  # seconds between Instagram/Facebook posts, so bulk publishing doesn't look like spam
_last_meta = [0.0]
LIMITS = {"ig": (3, 900), "fb": (3, 90)}  # clip length allowed by the platform API, seconds


def _find(job, index, pid):
    c = next((c for c in job["clips"] if c["index"] == index), None)
    if c is None:
        return None, None
    return c, next((p for p in c.get("posts", []) if p["id"] == pid), None)


def _set(job_id, index, pid, **kw):
    def f(j):
        _, p = _find(j, index, pid)
        if p is not None:
            p.update(kw)
    jobs.update(job_id, f)


def _ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def create(job_id, index, platform, req):
    """Add a post to the clip and queue (or schedule) the upload. Returns the post."""
    later = bool(req.get("publish_at")) and platform != "yt" and _ts(req["publish_at"]) > time.time() + 30
    post = {"id": uuid.uuid4().hex[:10], "platform": platform, "status": "scheduled" if later else "queued",
            "progress": 0.0, "created": time.time(), "title": req["title"], "description": req["description"],
            "hashtags": req["hashtags"], "privacy": req["privacy"], "made_for_kids": req["made_for_kids"],
            "publish_at": req.get("publish_at"), "video_id": None, "url": None, "error": None, "done_at": None}

    def f(j):
        c = next(c for c in j["clips"] if c["index"] == index)
        c.setdefault("posts", []).append(post)
    jobs.update(job_id, f)
    _ensure_workers()
    if not later:
        _q.put((job_id, index, post["id"]))
    return post


def is_short(job, clip):
    aspect = clip.get("aspect") or job["options"].get("aspect", "9:16")
    return aspect != "16:9" and clip["end"] - clip["start"] <= 180


def caption(post, platform, short=True):
    desc = (post["description"] or "").strip()
    tags = list(post["hashtags"])
    if platform == "ig":
        tags = tags[:30]  # Instagram allows at most 30 hashtags
    line = " ".join(tags)
    if platform == "yt" and short and "#shorts" not in (desc + line).lower():
        line = (line + " #Shorts").strip()
    return (desc + ("\n\n" + line if line else "")).strip()


def _run(job_id, index, pid):
    job = jobs.load(job_id)
    if not job:
        return
    clip, post = _find(job, index, pid)
    if post is None or post["status"] != "queued":
        return
    path = jobs.job_dir(job_id) / clip["file"] if clip.get("file") else None
    if path is None or not path.exists():
        _set(job_id, index, pid, status="error", error="The clip file is missing. Re-render it first.")
        return
    _set(job_id, index, pid, status="uploading", progress=0.0, error=None)
    last = [0.0]

    def prog(f):
        if time.time() - last[0] > 1.5 or f >= 1:
            last[0] = time.time()
            _set(job_id, index, pid, progress=round(f, 3))
    try:
        plat = post["platform"]
        if plat == "yt":
            from . import youtube
            short = is_short(job, clip)
            vid = youtube.upload(path, post["title"], caption(post, "yt", short), list(post["hashtags"]),
                                 privacy=post["privacy"], made_for_kids=post["made_for_kids"],
                                 publish_at=post.get("publish_at"), progress=prog)
            url = f"https://youtube.com/shorts/{vid}" if short else f"https://youtu.be/{vid}"
        elif plat in ("ig", "fb"):
            from . import meta
            wait = META_GAP - (time.time() - _last_meta[0])
            if wait > 0:
                _set(job_id, index, pid, status="queued", progress=0.0)
                time.sleep(wait)
                _set(job_id, index, pid, status="uploading")
            try:
                if plat == "ig":
                    vid, url = meta.upload_instagram(path, caption(post, "ig"), progress=prog)
                else:
                    vid, url = meta.upload_facebook(path, caption(post, "fb"), progress=prog)
            finally:
                _last_meta[0] = time.time()
        else:
            raise RuntimeError(f"Unknown platform {plat}")
        _set(job_id, index, pid, status="done", progress=1.0, video_id=vid, url=url, done_at=time.time())
    except Exception as e:
        traceback.print_exc()
        msg = str(e)[:500]
        if post["platform"] == "yt" and "daily limit" in msg:
            # YouTube's free quota resets at midnight Pacific time: try again automatically after that
            nxt = _next_quota_reset()
            _set(job_id, index, pid, status="waiting", retry_at=nxt, progress=0.0,
                 error=f"YouTube's daily upload limit is used up. Clipora will upload it automatically after "
                       f"{datetime.fromtimestamp(nxt).strftime('%b %d %H:%M')} (server time), if the site is running.")
            return
        _set(job_id, index, pid, status="error", error=msg)


def _next_quota_reset():
    from datetime import timedelta, timezone
    now = datetime.now(timezone.utc)
    pacific = now - timedelta(hours=8)  # PST; close enough (PDT is 1 h earlier) with the 20-minute margin
    reset = (pacific + timedelta(days=1)).replace(hour=0, minute=20, second=0, microsecond=0) + timedelta(hours=8)
    return reset.timestamp()


def _loop():
    while True:
        task = _q.get()
        try:
            if task[0] in jobs.list_ids():
                _run(*task)
        except Exception:
            traceback.print_exc()
        finally:
            _q.task_done()


def due_posts():
    """(job_id, index, post_id) of scheduled posts whose time has come."""
    now, out = time.time(), []
    for jid in jobs.list_ids():
        job = jobs.load(jid)
        for c in (job or {}).get("clips", []):
            for p in c.get("posts", []):
                if p.get("status") == "waiting" and (p.get("retry_at") or 0) <= now:
                    out.append((jid, c["index"], p["id"]))
                    continue
                if p.get("status") == "scheduled":
                    try:
                        if _ts(p["publish_at"]) <= now:
                            out.append((jid, c["index"], p["id"]))
                    except (KeyError, ValueError, AttributeError):
                        out.append((jid, c["index"], p["id"]))
    return out


def _schedule_loop():
    while True:
        try:
            for jid, index, pid in due_posts():
                _set(jid, index, pid, status="queued", error=None)
                _q.put((jid, index, pid))
        except Exception:
            traceback.print_exc()
        time.sleep(20)


def _ensure_workers():
    global _worker, _scheduler
    with _start_lock:
        if not (_worker and _worker.is_alive()):
            _worker = threading.Thread(target=_loop, daemon=True, name="clipora-publish")
            _worker.start()
        if not (_scheduler and _scheduler.is_alive()):
            _scheduler = threading.Thread(target=_schedule_loop, daemon=True, name="clipora-schedule")
            _scheduler.start()


def recover():
    """After a restart: in-flight uploads can't resume (mark for Retry); scheduled posts keep waiting."""
    for jid in jobs.list_ids():
        job = jobs.load(jid)
        if job and any(p.get("status") in ("queued", "uploading") for c in job.get("clips", []) for p in c.get("posts", [])):
            def f(j):
                for c in j.get("clips", []):
                    for p in c.get("posts", []):
                        if p.get("status") in ("queued", "uploading"):
                            p.update(status="error", error="Interrupted by a server restart. Press Retry.")
            jobs.update(jid, f)
    _ensure_workers()
