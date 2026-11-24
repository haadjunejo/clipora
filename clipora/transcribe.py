"""Speech → text with word timestamps (faster-whisper). The model stays loaded between jobs."""
import gc
import glob
import os
import subprocess
import threading

import numpy as np

from . import config
from .utils import fmt_time

_model = None
_model_device = None
_model_key = None
_gpu_broken = False
_lock = threading.Lock()


def preload_cuda_libs():
    """CTranslate2 needs CUDA 12 cuBLAS + cuDNN 9; load pip-installed copies into the process."""
    import ctypes
    import site
    roots = [p for p in site.getsitepackages() + [site.getusersitepackages()] if os.path.isdir(p)]
    pats = ["nvidia/cuda_runtime/lib/libcudart.so.12", "nvidia/cublas/lib/libcublasLt.so.12",
            "nvidia/cublas/lib/libcublas.so.12", "nvidia/cudnn/lib/libcudnn*.so.9"]
    files = []
    for r in roots:
        for p in pats:
            files += sorted(glob.glob(os.path.join(r, p)))
    loaded, pending = 0, list(dict.fromkeys(files))
    for _ in range(4):
        still = []
        for f in pending:
            try:
                ctypes.CDLL(f, mode=ctypes.RTLD_GLOBAL)
                loaded += 1
            except OSError:
                still.append(f)
        pending = still
        if not pending:
            break
    return loaded


def load_audio(path, log, sr=16000):
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-vn",
                        "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("Could not read audio: " + p.stderr.decode(errors="ignore")[-800:])
    audio = np.frombuffer(p.stdout, np.int16).astype(np.float32) / 32768.0
    secs = len(audio) / sr
    loud = float(np.sqrt(np.mean(audio[: sr * 600] ** 2))) if len(audio) else 0.0
    log(f"🔊 Audio: {fmt_time(secs)} long, loudness {loud:.3f}")
    if secs < 1 or loud < 0.0005:
        raise RuntimeError("The video's audio is silent or empty, so there is nothing to transcribe.")
    return audio


def gpu_count():
    try:
        import torch
        return torch.cuda.device_count() if torch.cuda.is_available() else 0
    except Exception:
        return 0


def _get_model(log, name=None, workers=1):
    """Load (or reuse) Whisper. workers=2 on a 2-GPU machine puts one copy on each GPU."""
    global _model, _model_device, _gpu_broken, _model_key
    from faster_whisper import WhisperModel
    name = name or config.WHISPER_MODEL
    want_gpu = config.has_gpu() and not _gpu_broken
    device = "cuda" if want_gpu else "cpu"
    n_gpu = max(1, min(workers, gpu_count())) if want_gpu else 1
    key = (name, device, n_gpu)
    if _model is not None and _model_key == key:
        return _model
    _model = None
    gc.collect()
    if want_gpu:
        log(f"Loaded {preload_cuda_libs()} CUDA libraries")
        for cand in dict.fromkeys([name, config.WHISPER_MODEL]):
            try:
                idx = list(range(n_gpu)) if n_gpu > 1 else 0
                _model = WhisperModel(cand, device="cuda", device_index=idx, compute_type="float16",
                                      num_workers=n_gpu)
                _model_device, _model_key = "cuda", key
                if cand != name:
                    log(f"ℹ️ {name} is not available here, using {cand}")
                log(f"🧠 Whisper {cand} on {n_gpu} GPU{'s' if n_gpu > 1 else ''}")
                return _model
            except Exception as e:
                log(f"⚠️ Whisper {cand} failed to load on the GPU ({str(e)[:160]})")
        _gpu_broken = True
        log("→ using the CPU (slow)")
    cpu_name = config.WHISPER_MODEL if config.WHISPER_MODEL in ("tiny", "base", "small") else "small"
    _model = WhisperModel(cpu_name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
    _model_device, _model_key = "cpu", key
    return _model


def _transcribe_once(model, audio, language, vad, log, progress):
    kw = dict(language=language, word_timestamps=True, vad_filter=vad, beam_size=5)
    if language is None:
        kw["language_detection_segments"] = 6
    try:
        segs_iter, info = model.transcribe(audio, **kw)
    except TypeError:
        kw.pop("language_detection_segments", None)
        segs_iter, info = model.transcribe(audio, **kw)
    log(f"Language: {info.language} ({info.language_probability:.0%})")
    if language is None and info.language_probability < 0.7:
        log("   ⚠️ Not sure about the language — set it in the options if this is wrong")
    segments = []
    for s in segs_iter:
        words = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)}
                 for w in (s.words or []) if w.word.strip()]
        segments.append({"s": round(s.start, 3), "e": round(s.end, 3), "text": s.text.strip(), "words": words})
        if progress and info.duration:
            progress(min(1.0, s.end / info.duration))
    return {"language": info.language, "segments": segments}


def transcribe(path, language, log, progress=None):
    global _gpu_broken, _model
    with _lock:  # one transcription at a time on the GPU
        audio = load_audio(path, log)
        for _ in range(2):
            model = _get_model(log)
            try:
                data = _transcribe_once(model, audio, language, True, log, progress)
                if not data["segments"]:
                    log("⚠️ No speech found with the voice filter — retrying without it...")
                    data = _transcribe_once(model, audio, language, False, log, progress)
                break
            except Exception as e:
                if _model_device == "cuda":
                    log(f"⚠️ GPU Whisper failed ({str(e)[:200]}) → switching to CPU")
                    _gpu_broken, _model = True, None
                    continue
                raise
        if not data["segments"]:
            raise RuntimeError("No speech found in this video (music-only, silent, or unknown language). "
                               "Try a talking video or set the language in the options.")
        if config.has_gpu():
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
        return data


# ---------------- long videos: chunked, both GPUs, resumable ----------------
CHUNK_SEC = int(os.environ.get("WHISPER_CHUNK_SEC", 20 * 60))
OVERLAP = 4.0


def _chunk_audio(path, start, length, sr=16000):
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
                        "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("Could not read audio: " + p.stderr.decode(errors="ignore")[-500:])
    return np.frombuffer(p.stdout, np.int16).astype(np.float32) / 32768.0


def transcribe_long(path, language, log, progress=None, cache_dir=None):
    """For long videos: 20-minute parts, transcribed in parallel on every GPU, each part saved as it finishes
    (so a server restart in the same session continues instead of starting over)."""
    import json
    from concurrent.futures import ThreadPoolExecutor
    from pathlib import Path
    from .utils import ffprobe_duration
    global _gpu_broken, _model
    total = ffprobe_duration(path)
    n = max(1, int(np.ceil(total / CHUNK_SEC)))
    cache = Path(cache_dir) if cache_dir else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    with _lock:
        workers = max(1, min(2, gpu_count())) if config.has_gpu() else 1
        model = _get_model(log, config.WHISPER_LONG_MODEL, workers)
        log(f"🔊 Audio: {fmt_time(total)} long → {n} part{'s' if n > 1 else ''} of {CHUNK_SEC / 60:g} min"
            + (f", {workers} at a time" if workers > 1 else ""))
        done = {}
        if cache:
            for k in range(n):
                f = cache / f"part_{k:03d}.json"
                if f.exists():
                    try:
                        done[k] = json.loads(f.read_text(encoding="utf-8"))
                    except Exception:
                        pass
            if done:
                log(f"♻️ {len(done)} of {n} parts were already transcribed, continuing")
        lang = language
        if lang is None:  # detect once, so every part uses the same language
            if done:
                lang = next(iter(done.values())).get("language")
            else:
                a = _chunk_audio(path, min(total * 0.1, 600), min(120, total))
                _, info = model.transcribe(a, language=None, vad_filter=True, beam_size=1)
                lang = info.language
                log(f"Language: {lang} ({info.language_probability:.0%})")
        finished = [len(done)]

        def work(k):
            if k in done:
                return k, done[k]
            start = k * CHUNK_SEC
            audio = _chunk_audio(path, start, CHUNK_SEC + OVERLAP)
            segs = []
            if len(audio) >= 1600 and float(np.sqrt(np.mean(audio ** 2))) >= 0.0003:
                segs_iter, _ = model.transcribe(audio, language=lang, word_timestamps=True, vad_filter=True,
                                                beam_size=5)
                for sg in segs_iter:
                    words = [{"w": w.word.strip(), "s": round(start + w.start, 3), "e": round(start + w.end, 3)}
                             for w in (sg.words or []) if w.word.strip()]
                    segs.append({"s": round(start + sg.start, 3), "e": round(start + sg.end, 3),
                                 "text": sg.text.strip(), "words": words})
            res = {"language": lang, "segments": segs}
            if cache:
                (cache / f"part_{k:03d}.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
            finished[0] += 1
            if progress:
                progress(finished[0] / n)
            log(f"   📝 Part {k + 1}/{n} done ({fmt_time(start)} - {fmt_time(min(total, start + CHUNK_SEC))})")
            return k, res

        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                results = dict(pool.map(work, range(n)))
        except Exception as e:
            if _model_device == "cuda":
                _gpu_broken, _model = True, None
            raise RuntimeError(f"Transcription failed: {str(e)[:300]}")
    # stitch: each part owns its own 20 minutes; drop words repeated in the 4 s overlap
    segments, last_end = [], -1.0
    for k in range(n):
        limit = (k + 1) * CHUNK_SEC
        for sg in results[k]["segments"]:
            if sg["s"] >= limit:
                continue
            words = [w for w in sg["words"] if w["s"] >= last_end - 0.05]
            if not words:
                continue
            segments.append({"s": words[0]["s"], "e": max(sg["e"], words[-1]["e"]),
                             "text": " ".join(w["w"] for w in words), "words": words})
            last_end = words[-1]["e"]
    if not segments:
        raise RuntimeError("No speech found in this video (music-only, silent, or unknown language). "
                           "Try a talking video or set the language in the options.")
    if config.has_gpu():
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass
    return {"language": lang, "segments": segments}
