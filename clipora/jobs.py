"""Job storage (one folder + job.json per job) and a single background worker queue.
Simple on purpose: one GPU = one job at a time. Swap for Redis/Celery when you scale."""
import json
import queue
import shutil
import threading
import time
import traceback
import uuid

from . import config

_lock = threading.RLock()
_queue = queue.Queue()
_worker = None

STAGES = [  # name, label, share of total progress
    ("download", "Getting video", 0.12),
    ("transcribe", "Transcribing speech", 0.38),
    ("pick", "AI is picking the best moments", 0.12),
    ("render", "Rendering clips", 0.38),
]


def job_dir(job_id):
    return config.JOBS / job_id


def _path(job_id):
    return job_dir(job_id) / "job.json"


def save(job):
    with _lock:
        p = _path(job["id"])
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)


def load(job_id):
    if not job_id or "/" in job_id or "\\" in job_id or ".." in job_id:
        return None
    with _lock:
        p = _path(job_id)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))


def update(job_id, fn):
    """Load → modify with fn(job) → save, atomically."""
    with _lock:
        job = load(job_id)
        if job is None:
            return None
        fn(job)
        job["updated"] = time.time()
        save(job)
        return job


def create(source, options, file_path=None):
    """Create a job folder (moving an uploaded file into it) and put it in the queue."""
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    job_dir(job_id).mkdir(parents=True)
    if file_path is not None:
        shutil.move(str(file_path), job_dir(job_id) / file_path.name)
    job = {
        "id": job_id, "created": time.time(), "updated": time.time(),
        "status": "queued", "stage": None, "progress": 0.0, "message": "Waiting in queue...",
        "source": source, "options": options, "title": source.get("name") or source.get("url") or "Video",
        "duration": None, "language": None, "clips": [], "log": [], "error": None,
    }
    save(job)
    enqueue(("job", job_id))
    return job


def list_jobs():
    out = []
    for p in sorted(config.JOBS.glob("*/job.json"), reverse=True):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        clips = j.get("clips", [])
        done = [c for c in clips if c.get("status") == "done"]
        out.append({k: j.get(k) for k in ("id", "created", "updated", "status", "progress", "title", "duration",
                                           "message", "stage", "language")}
                   | {"clip_count": len(clips), "clips_done": len(done), "thumb": bool(j.get("duration")),
                      "top_score": max((c.get("score") or 0 for c in clips), default=None),
                      "scores": [c.get("score") for c in done],
                      "best": [{"index": c["index"], "title": c.get("title"), "score": c.get("score"),
                                "len": round(c["end"] - c["start"], 1)}
                               for c in sorted(done, key=lambda c: -(c.get("score") or 0))[:3]],
                      "source_kind": (j.get("source") or {}).get("kind"),
                      "posts": [{k: p.get(k) for k in ("id", "platform", "status", "progress", "url", "video_id",
                                                        "publish_at", "created", "done_at", "privacy", "error")}
                                | {"index": c["index"], "clip_title": c.get("title")}
                                for c in clips for p in c.get("posts", [])]})
    return out


def list_ids():
    return [p.parent.name for p in config.JOBS.glob("*/job.json")]


def delete(job_id):
    if load(job_id) is None:
        return False
    with _lock:
        shutil.rmtree(job_dir(job_id), ignore_errors=True)
    return True


# ---------------- worker ----------------
def enqueue(task):
    _queue.put(task)


def queue_position(job_id):
    items = list(_queue.queue)
    for i, t in enumerate(items):
        if t[0] == "job" and t[1] == job_id:
            return i + 1
    return 0


def _loop():
    from . import pipeline
    while True:
        task = _queue.get()
        try:
            if task[0] == "job":
                pipeline.run_job(task[1])
            elif task[0] == "rerender":
                pipeline.rerender_clip(task[1], task[2])
        except Exception:
            traceback.print_exc()
        finally:
            _queue.task_done()


def start_worker():
    global _worker
    if _worker and _worker.is_alive():
        return
    # recover after a restart: unfinished jobs go back in the queue
    for p in sorted(config.JOBS.glob("*/job.json")):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if j.get("status") in ("queued", "running"):
            j["status"], j["message"] = "queued", "Restarted — waiting in queue..."
            save(j)
            _queue.put(("job", j["id"]))
        for c in j.get("clips", []):
            if c.get("status") == "rendering":
                c["status"] = "queued"
                save(j)
                _queue.put(("rerender", j["id"], c["index"]))
    _worker = threading.Thread(target=_loop, daemon=True, name="clipora-worker")
    _worker.start()
