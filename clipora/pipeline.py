"""The full clipping pipeline for one job, reporting progress into job.json."""
import json
import time
import traceback
from pathlib import Path

from . import config, jobs
from .utils import ffprobe_duration, fmt_time, safe_name

MAX_LOG = 400


class Reporter:
    def __init__(self, job_id):
        self.job_id = job_id
        self.stage_base = 0.0
        self.stage_share = 0.0
        self._last = 0.0

    def log(self, msg):
        msg = str(msg)
        try:
            print(f"[{self.job_id}] {msg}", flush=True)
        except Exception:  # a console that can't show emoji must never break a job
            pass

        def f(j):
            j["log"].append({"t": time.time(), "msg": msg})
            j["log"] = j["log"][-MAX_LOG:]
        jobs.update(self.job_id, f)

    def stage(self, name):
        base = 0.0
        for n, label, share in jobs.STAGES:
            if n == name:
                self.stage_base, self.stage_share = base, share

                def f(j, n=n, label=label, base=base):
                    j["stage"], j["message"], j["progress"] = n, label + "...", round(base, 3)
                jobs.update(self.job_id, f)
                self.log(f"▶ {label}")
                return
            base += share

    def progress(self, frac, message=None):
        now = time.time()
        if now - self._last < 1.0 and frac < 1.0 and message is None:
            return  # don't write the file more than once a second
        self._last = now
        total = round(self.stage_base + self.stage_share * max(0.0, min(1.0, frac)), 3)

        def f(j):
            j["progress"] = max(j.get("progress") or 0, total)
            if message:
                j["message"] = message
        jobs.update(self.job_id, f)


def auto_clip_count(duration, opts):
    """About one clip per 4 minutes, never more than fit without overlapping, between 3 and 100."""
    fit = int(duration / max(opts.get("max_sec", 60), 10) * 0.8)
    return max(3, min(config.MAX_CLIPS, round(duration / 240), max(fit, 3)))


def _video_path(job_id):
    d = jobs.job_dir(job_id)
    for f in sorted(d.glob("source.*")):
        if f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov") and not f.name.endswith(".part"):
            return f
    return None


def _audio_path(job_id):
    """Long streams keep only the audio (audio.*) plus short video sections per clip."""
    for f in sorted(jobs.job_dir(job_id).glob("audio.*")):
        if not f.name.endswith(".part"):
            return f
    return None


def _media_path(job_id):
    return _video_path(job_id) or _audio_path(job_id)


SECTION_PAD = 20.0  # seconds of extra video around each clip, so small trims in the editor need no new download


def _clip_video(job_id, clip, log):
    """(video file, offset) to render this clip from: the full video, or a downloaded section of a long stream."""
    video = _video_path(job_id)
    if video is not None:
        return video, 0.0
    job = jobs.load(job_id)
    url = (job.get("source") or {}).get("url")
    if not url:
        raise RuntimeError("The source video is missing.")
    from . import download, render
    d = jobs.job_dir(job_id)
    start, end = float(clip["start"]), float(clip["end"])
    sec = clip.get("section")
    if not (sec and sec[0] <= start + 0.05 and sec[1] >= end - 0.05 and (d / sec[2]).exists()):
        s0, s1 = max(0.0, start - SECTION_PAD), min(job.get("duration") or end + SECTION_PAD, end + SECTION_PAD)
        if sec:
            (d / sec[2]).unlink(missing_ok=True)
        path = download.download_section(url, d, s0, s1, f"sec_{clip['index']:02d}", log)
        sec = [round(s0, 3), round(s1, 3), path.name]

        def keep(j, idx=clip["index"], sec=sec):
            c = next((c for c in j["clips"] if c["index"] == idx), None)
            if c is not None:
                c["section"] = sec
        jobs.update(job_id, keep)
        if not (d / "thumb.jpg").exists():
            render.make_poster(path, d / "thumb.jpg", at=SECTION_PAD + 1, width=640)
            jobs.update(job_id, lambda j: j.update(thumb=True))
    return d / sec[2], float(sec[0])


def _load_words(job_id):
    t = jobs.job_dir(job_id) / "transcript.json"
    data = json.loads(t.read_text(encoding="utf-8"))
    return [w for s in data["segments"] for w in s["words"]]


def _render_one(job_id, clip, opts, all_words, rep, idx_label):
    from .render import make_poster, render_clip
    d = jobs.job_dir(job_id)
    video, offset = _clip_video(job_id, clip, rep.log)
    version = int(clip.get("version", 0)) + 1
    out = d / f"clip{clip['index']:02d}_v{version}.mp4"
    old = clip.get("file")

    def prog(f):
        rep.progress((idx_label[0] + f) / idx_label[1], f"Rendering clip {idx_label[0] + 1} of {idx_label[1]}")

    mode = render_clip(str(video), clip, out, d, opts, all_words, log=rep.log, progress=prog, offset=offset)
    if old and old != out.name:
        (d / old).unlink(missing_ok=True)
        (d / old).with_suffix(".jpg").unlink(missing_ok=True)
    make_poster(out, out.with_suffix(".jpg"), at=min(1.0, max(0.0, clip["end"] - clip["start"] - 0.5)))
    return out.name, version, mode


def run_job(job_id):
    job = jobs.load(job_id)
    if not job or job["status"] not in ("queued", "running"):
        return
    rep = Reporter(job_id)
    opts = job["options"]
    d = jobs.job_dir(job_id)
    jobs.update(job_id, lambda j: j.update(status="running", error=None))
    try:
        from . import download, llm, picker, render, transcribe
        render.ensure_assets(rep.log)

        # 1) video
        rep.stage("download")
        video, long_mode = _media_path(job_id), opts.get("long_mode", "auto")
        if video is None:
            src = job["source"]
            if src.get("kind") != "url":
                raise RuntimeError("The uploaded file is missing. Please upload it again.")
            use_long = long_mode == "on"
            if long_mode == "auto":
                info = download.probe(src["url"], d, rep.log)
                if info.get("title"):
                    jobs.update(job_id, lambda j: j.update(title=info["title"]))
                if (info.get("duration") or 0) >= config.LONG_VIDEO_SEC:
                    use_long = True
                    rep.log(f"📼 {fmt_time(info['duration'])} long → long stream mode: audio first, then only the "
                            f"clip sections")
            if use_long:
                video, title = download.download_audio(src["url"], d, rep.log, rep.progress)
                jobs.update(job_id, lambda j: j.update(long=True))
            else:
                video, title = download.download_video(src["url"], d, rep.log, rep.progress)
            if title:
                jobs.update(job_id, lambda j: j.update(title=title))
        duration = ffprobe_duration(video)
        if not (d / "thumb.jpg").exists() and _video_path(job_id):
            render.make_poster(video, d / "thumb.jpg", at=min(duration * 0.1, 30), width=640)
        jobs.update(job_id, lambda j: j.update(duration=duration, thumb=(d / "thumb.jpg").exists(),
                                               source_size=video.stat().st_size))
        rep.log(f"✅ Video ready: {fmt_time(duration)} long")

        # 2) transcript (cached in the job folder)
        rep.stage("transcribe")
        tpath = d / "transcript.json"
        data = None
        if tpath.exists():
            data = json.loads(tpath.read_text(encoding="utf-8"))
            if not data.get("segments"):
                data = None
        if data is None:
            if long_mode == "on" or (long_mode != "off" and duration >= config.LONG_VIDEO_SEC):
                data = transcribe.transcribe_long(video, opts.get("language"), rep.log, rep.progress, d / "tparts")
            else:
                data = transcribe.transcribe(video, opts.get("language"), rep.log, rep.progress)
            tpath.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        segments = data["segments"]
        words = [w for s in segments for w in s["words"]]
        jobs.update(job_id, lambda j: j.update(language=data.get("language")))
        rep.log(f"✅ {len(segments)} segments, {len(words)} words")

        # 3) pick clips
        rep.stage("pick")
        pick_opts = dict(opts)
        if not pick_opts.get("num_clips"):  # Auto: about one clip per 4 minutes of video
            pick_opts["num_clips"] = auto_clip_count(duration, pick_opts)
            rep.log(f"🎯 Auto: aiming for {pick_opts['num_clips']} clips for a {fmt_time(duration)} video")
        router = llm.get_router(rep.log)
        try:
            clips = picker.find_clips(segments, words, duration, pick_opts, router, rep.log, rep.progress)
        finally:
            router.log_fn = None
        for i, c in enumerate(clips, 1):
            c.update(index=i, status="queued", version=0, file=None, layout=None, error=None)
        jobs.update(job_id, lambda j: j.update(clips=clips))
        rep.log(f"✅ Picked {len(clips)} clips")

        # 4) render
        rep.stage("render")
        for k, c in enumerate(clips):
            jobs.update(job_id, lambda j, k=k: j["clips"][k].update(status="rendering"))
            t0 = time.time()
            try:
                fname, version, mode = _render_one(job_id, c, opts, words, rep, (k, len(clips)))

                def ok(j, k=k, fname=fname, version=version, mode=mode):
                    j["clips"][k].update(status="done", file=fname, version=version, layout=mode, error=None)
                jobs.update(job_id, ok)
                rep.log(f"🎬 Clip {k + 1}/{len(clips)} done ({mode}, {time.time() - t0:.0f}s)")
            except Exception as e:
                jobs.update(job_id, lambda j, k=k, e=e: j["clips"][k].update(status="error", error=str(e)[:500]))
                rep.log(f"❌ Clip {k + 1} failed: {str(e)[:300]}")

        def finish(j):
            done = sum(c["status"] == "done" for c in j["clips"])
            if done == 0 and j["clips"]:
                first = next((c.get("error") for c in j["clips"] if c.get("error")), "unknown error")
                j.update(status="error", stage=None, message="Failed",
                         error=f"Every clip failed to render. First error:\n{first}")
            else:
                j.update(status="done", progress=1.0, stage=None, message=f"Done — {done} clips ready")
        job = jobs.update(job_id, finish)
        rep.log("✅ All done" if job["status"] == "done" else "❌ No clips could be rendered")
    except Exception as e:
        traceback.print_exc()
        msg = str(e)
        jobs.update(job_id, lambda j: j.update(status="error", error=msg[:3000], message="Failed"))
        rep.log("❌ " + msg[:1000])


def rerender_clip(job_id, index):
    job = jobs.load(job_id)
    if not job:
        return
    k = next((i for i, c in enumerate(job["clips"]) if c["index"] == index), None)
    if k is None:
        return
    rep = Reporter(job_id)
    rep.progress = lambda frac, message=None: None  # keep the job's finished status/message untouched
    jobs.update(job_id, lambda j: j["clips"][k].update(status="rendering", error=None))
    try:
        from . import render
        render.ensure_assets(rep.log)
        clip = jobs.load(job_id)["clips"][k]
        words = _load_words(job_id)
        fname, version, mode = _render_one(job_id, clip, job["options"], words, rep, (0, 1))
        jobs.update(job_id, lambda j: j["clips"][k].update(status="done", file=fname, version=version, layout=mode))
        rep.log(f"🎬 Clip {index} re-rendered ({mode})")
    except Exception as e:
        traceback.print_exc()
        jobs.update(job_id, lambda j: j["clips"][k].update(status="error", error=str(e)[:500]))
        rep.log(f"❌ Re-render of clip {index} failed: {str(e)[:300]}")


def clip_download_name(clip):
    return f"{clip['index']:02d}_{safe_name(clip.get('title'))}.mp4"
