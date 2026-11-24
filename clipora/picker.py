"""Choose the best clips from a transcript (AI first, rule-based fallback)."""
import json
import math
import re

SYSTEM_PROMPT = """You are an expert short-form video editor who finds viral clips for TikTok, YouTube Shorts and Instagram Reels.
You get part of a video transcript. Each line is "[start_seconds] text".
Pick the moments most likely to go viral: strong hooks, surprising facts, funny moments, hot takes,
emotional stories, clear valuable advice, conflict, or a satisfying payoff.
Rules:
- Every clip must make sense on its own without the rest of the video.
- Start exactly where a sentence begins with a hook (no "and", "so", "um" starts) and end after a complete thought/punchline.
- Use only timestamps that appear in the transcript (you may end at the start time of the following line).
- Write the title, hook and description in the same language as the transcript.
Respond with ONLY JSON, no markdown, in this format:
{"clips":[{"start":12.3,"end":58.1,"score":87,"scores":{"hook":90,"flow":80,"value":85,"trend":75},
"title":"short catchy title","hook":"3-7 word on-screen hook",
"description":"1-2 sentence post caption","hashtags":["#tag1","#tag2"],"reason":"why it is viral"}]}
"scores" rate 0-99: hook = how strongly the first seconds grab attention, flow = clean start/end and pacing,
value = how useful/entertaining/emotional it is, trend = fit with what performs on short-form platforms now."""

VIRAL_WORDS = set("""secret never always crazy insane money million truth mistake why how stop worst best
nobody everyone shocking love hate fear died rich broke actually honestly literally biggest wrong""".split())


def parse_json_clips(text):
    if not text:
        return None
    text = re.sub(r"```(?:json)?", "", text)
    cands = []
    m = re.search(r"\{.*\}", text, flags=re.S)
    if m:
        try:
            obj = json.loads(m.group(0))
            cands = obj.get("clips", []) if isinstance(obj, dict) else obj
        except Exception:
            cands = []
    if not cands:
        m = re.search(r"\[.*\]", text, flags=re.S)
        if m:
            try:
                cands = json.loads(m.group(0))
            except Exception:
                return None
    good = []
    for c in cands if isinstance(cands, list) else []:
        try:
            s, e = float(c["start"]), float(c["end"])
            if e > s:
                c["start"], c["end"] = s, e
                c["score"] = float(c.get("score", 50))
                tags = c.get("hashtags") or []
                c["hashtags"] = [t if str(t).startswith("#") else f"#{t}" for t in tags if str(t).strip()][:8]
                good.append(c)
        except Exception:
            continue
    return good or None


def chunk_transcript(segments, max_chars=12000, overlap_segments=4):
    chunks, cur, size = [], [], 0
    for s in segments:
        line = f"[{s['s']:.1f}] {s['text']}"
        if cur and size + len(line) > max_chars:
            chunks.append(cur)
            cur = cur[-overlap_segments:]
            size = sum(len(x) for x in cur)
        cur.append(line)
        size += len(line) + 1
    if cur:
        chunks.append(cur)
    return ["\n".join(c) for c in chunks]


def snap_to_words(start, end, words):
    if not words:
        return start, end
    starts = [w for w in words if w["s"] >= start - 1.0]
    s = starts[0]["s"] if starts else start
    ends = [w for w in words if w["e"] <= end + 1.0 and w["s"] >= s]
    e = ends[-1]["e"] if ends else end
    return max(0.0, s - 0.15), e + 0.35


def overlap_ratio(a, b):
    inter = max(0, min(a["end"], b["end"]) - max(a["start"], b["start"]))
    return inter / max(1e-6, min(a["end"] - a["start"], b["end"] - b["start"]))


def heuristic_clips(segments, n, min_s, max_s):
    target = (min_s + max_s) / 2
    windows = []
    for i, s in enumerate(segments):
        j = i
        while j < len(segments) - 1 and segments[j]["e"] - s["s"] < target:
            j += 1
        text = " ".join(x["text"] for x in segments[i:j + 1])
        start, end = s["s"], segments[j]["e"]
        if end - start < min_s:
            continue
        words = text.lower().split()
        wps = len(words) / max(1, end - start)
        score = (wps * 10 + text.count("?") * 3 + text.count("!") * 3
                 + sum(w.strip(".,!?") in VIRAL_WORDS for w in words) * 4)
        first = re.split(r"(?<=[.!?])\s", s["text"].strip())[0]
        windows.append({"start": start, "end": min(end, start + max_s), "score": score,
                        "title": first[:60], "hook": " ".join(first.split()[:6]),
                        "description": first, "hashtags": ["#shorts", "#viral"], "reason": "rule-based pick"})
    windows.sort(key=lambda c: -c["score"])
    picked = []
    for w in windows:
        if all(overlap_ratio(w, p) < 0.1 for p in picked):
            picked.append(w)
        if len(picked) >= n:
            break
    if picked:
        top = max(p["score"] for p in picked)
        for p in picked:
            p["score"] = round(40 + 50 * p["score"] / max(top, 1e-6))
    return picked


def find_clips(segments, words, duration, opts, router, log, progress=None):
    n, min_s, max_s = opts["num_clips"], opts["min_sec"], opts["max_sec"]
    if not segments:
        raise RuntimeError("The transcript is empty.")
    candidates = []
    chunks = chunk_transcript(segments)
    per_chunk = min(12, max(2, math.ceil(n * 1.5 / len(chunks)) + 1))  # one answer must fit in the reply
    for i, ch in enumerate(chunks):
        log(f"🔎 Analyzing part {i + 1}/{len(chunks)}")  # long streams have many parts
        user = (f"Find the {per_chunk} best clips in this part. Each clip must be between {min_s} and {max_s} seconds "
                f"long; aim for about {round((min_s + max_s) / 2)} seconds so the story has a hook, build-up and payoff "
                f"(end - start must be at least {min_s}).\n\n"
                + (f"The creator asked: \"{opts['ai_prompt']}\" — prefer moments that match this.\n\n"
                   if opts.get("ai_prompt") else "")
                + f"TRANSCRIPT:\n{ch}")
        text = router.chat(SYSTEM_PROMPT, user, validate=parse_json_clips) if router else None
        got = parse_json_clips(text)
        if got:
            candidates += got
        if progress:
            progress((i + 1) / len(chunks))
    if not candidates:
        log("ℹ️ No AI available — using rule-based picker")
        final = heuristic_clips(segments, n, min_s, max_s)
    else:
        fixed = []
        for c in candidates:
            s, e = c["start"], c["end"]
            if e - s > max_s:
                e = s + max_s
            if e - s < min_s:
                e = s + min_s
            s, e = snap_to_words(s, min(e, duration), words)
            e = min(e, duration)
            if e - s < min_s * 0.6:
                continue
            c["start"], c["end"] = round(s, 2), round(e, 2)
            fixed.append(c)
        fixed.sort(key=lambda c: -c["score"])
        final = []
        for c in fixed:
            if all(overlap_ratio(c, f) < 0.1 for f in final):
                final.append(c)
            if len(final) >= n:
                break
        if len(final) < n:
            for h in heuristic_clips(segments, n * 3, min_s, max_s):
                if len(final) >= n:
                    break
                if all(overlap_ratio(h, f) < 0.1 for f in final):
                    final.append(h)
    out = []
    for c in final:
        scores = {}
        if isinstance(c.get("scores"), dict):
            for k in ("hook", "flow", "value", "trend"):
                try:
                    scores[k] = max(0, min(99, round(float(c["scores"][k]))))
                except (KeyError, TypeError, ValueError):
                    pass
        out.append({
            "scores": scores,
            "start": round(float(c["start"]), 2), "end": round(float(c["end"]), 2),
            "score": round(float(c.get("score", 50))),
            "title": str(c.get("title", "")).strip()[:100] or "Clip",
            "hook": str(c.get("hook", "")).strip()[:80],
            "description": str(c.get("description", "")).strip()[:500],
            "hashtags": c.get("hashtags") or [],
            "reason": str(c.get("reason", "")).strip()[:300],
        })
    return out
