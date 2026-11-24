"""Cut → reframe (face tracking / blur / center) → burn animated captions, logo and progress bar."""
import os
import re
import subprocess
import threading
from pathlib import Path

import numpy as np

from . import config
from .utils import download_file, run

OW, OH = config.OUTPUT_W, config.OUTPUT_H  # default 9:16 size

FONT_URLS = {
    "Anton-Regular.ttf": "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf",
    "Montserrat.ttf": "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf",
}
YUNET_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/"
             "face_detection_yunet_2023mar.onnx")


def ensure_assets(log=print):
    for fname, url in FONT_URLS.items():
        try:
            download_file(url, config.FONTS / fname)
        except Exception as e:
            log(f"⚠️ Could not download font {fname}: {e}")


# ---------------- face detection ----------------
class FaceFinder:
    def __init__(self, log=print):
        import cv2
        self.cv2 = cv2
        self.yunet = None
        try:
            path = download_file(YUNET_URL, config.CACHE / "yunet.onnx")
            self.yunet = cv2.FaceDetectorYN.create(str(path), "", (320, 320), 0.6, 0.3, 50)
        except Exception as e:
            log(f"YuNet face detector unavailable ({e})")
        self.haar = None
        if self.yunet is None:
            try:  # older backup detector (removed in OpenCV 5)
                self.haar = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
            except Exception:
                log("⚠️ No face detector available — clips will use the blurred-background layout")
        self.lock = threading.Lock()

    def find(self, frame):
        cv2 = self.cv2
        h, w = frame.shape[:2]
        scale = 480 / w
        small = cv2.resize(frame, (480, int(h * scale)))
        faces = []
        with self.lock:
            if self.yunet is not None:
                self.yunet.setInputSize((small.shape[1], small.shape[0]))
                _, det = self.yunet.detect(small)
                if det is not None:
                    faces = [(d[0], d[1], d[2], d[3], d[-1]) for d in det]
            elif self.haar is not None:
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                faces = [(x, y, fw, fh, 1.0) for x, y, fw, fh in
                         self.haar.detectMultiScale(gray, 1.1, 5, minSize=(30, 30))]
        if not faces:
            return None
        x, y, fw, fh, conf = max(faces, key=lambda f: f[2] * f[3] * f[4])
        # centre x, face width, centre y, face height (in full-frame pixels)
        return ((x + fw / 2) / scale, fw / scale, (y + fh / 2) / scale, fh / scale)


_faces = None


def get_faces(log=print):
    global _faces
    if _faces is None:
        _faces = FaceFinder(log)
    return _faces


def smooth_track(samples, n_frames, fps, frame_w, crop_w):
    idx = sorted(samples)
    xs = [samples[i] for i in idx]
    last = None
    for k in range(len(xs)):
        if xs[k] is None:
            xs[k] = last
        else:
            last = xs[k]
    nxt = None
    for k in range(len(xs) - 1, -1, -1):
        if xs[k] is None:
            xs[k] = nxt
        else:
            nxt = xs[k]
    xs = np.array([frame_w / 2 if v is None else v for v in xs], dtype=float)
    k = 5
    if len(xs) >= k:
        pad = np.pad(xs, (k // 2, k // 2), mode="edge")
        xs = np.array([np.median(pad[i:i + k]) for i in range(len(xs))])
    cam = np.empty_like(xs)
    cur = xs[0]
    dead = crop_w * 0.12
    for i, t in enumerate(xs):
        diff = t - cur
        if abs(diff) > crop_w * 0.6:
            cur = t
        elif abs(diff) > dead:
            cur += diff * 0.35
        cam[i] = cur
    per_frame = np.interp(np.arange(n_frames), idx, cam) if len(idx) > 1 else np.full(n_frames, cam[0])
    win = max(1, int(fps * 0.5))
    if win > 1 and n_frames > win:
        per_frame = np.convolve(np.pad(per_frame, (win // 2, win - 1 - win // 2), mode="edge"),
                                np.ones(win) / win, mode="valid")
    left = np.clip(per_frame - crop_w / 2, 0, frame_w - crop_w)
    return left.astype(int)


# ---------------- captions ----------------
CAPTION_PRESETS = {
    #            font, size, text color, highlight, outline, box?
    "bold_yellow": ("Anton", 100, "#FFFFFF", "#FFE500", "#000000", False),
    "karaoke": ("Montserrat", 84, "#FFFFFF", "#B58AFF", "#000000", False),
    "boxed": ("Montserrat", 74, "#FFFFFF", "#88FF00", "#000000", True),
    "neon": ("Montserrat", 82, "#FFFFFF", "#3CF0FF", "#FF3CF0", False),
    "minimal": ("Montserrat", 66, "#FFFFFF", None, "#000000", False),
}


def ass_color(hex_rgb, alpha="00"):
    """#RRGGBB -> ASS &HAABBGGRR"""
    h = hex_rgb.lstrip("#")
    return f"&H{alpha}{h[4:6]}{h[2:4]}{h[0:2]}".upper()


def ass_time(t):
    cs = int(round(max(0, t) * 100))
    return f"{cs // 360000}:{(cs // 6000) % 60:02d}:{(cs // 100) % 60:02d}.{cs % 100:02d}"


def ass_escape(s):
    return s.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ")


def group_words(words, max_words=3, max_chars=18):
    groups, cur = [], []
    max_chars = max(max_chars, max_words * 6)
    for w in words:
        if cur and (len(cur) >= max_words or sum(len(x["w"]) + 1 for x in cur) + len(w["w"]) > max_chars
                    or w["s"] - cur[-1]["e"] > 0.6):
            groups.append(cur)
            cur = []
        cur.append(w)
        if re.search(r"[.!?…]$", w["w"]):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return groups


def build_ass(words, clip_len, opts, hook_text=None, w=OW, h=OH):
    style = opts["caption_style"]
    uppercase = opts["uppercase"]
    font, size, color, hi, outline, boxed = CAPTION_PRESETS.get(style, CAPTION_PRESETS["bold_yellow"])
    size = int(size * opts.get("caption_size", 100) / 100)
    color = opts.get("text_color") or color
    if hi is not None:
        hi = opts.get("highlight_color") or hi
    neon = style == "neon"
    border_style, outline_w, shadow = (3, 18, 0) if boxed else ((1, 5, 0) if neon else (1, 7, 3))
    back = "&H80000000" if boxed else "&H96000000"
    out_col = "&H80000000" if boxed else ass_color(outline)
    portrait = h > w
    pos = opts.get("caption_position", "bottom")
    align, margin_v = {"bottom": (2, int(h * (0.27 if portrait else 0.1))), "middle": (5, 0),
                       "top": (8, int(h * (0.24 if portrait else 0.18)))}.get(pos, (2, int(h * 0.27)))
    if opts.get("hook_position") == "center":
        hook_align, hook_mv = 5, 0
    else:
        hook_align, hook_mv = 8, int(h * (0.12 if portrait else 0.07))
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Cap,{font},{size},{ass_color(color)},&H000000FF,{out_col},{back},-1,0,0,0,100,100,1,0,"
        f"{border_style},{outline_w},{shadow},{align},70,70,{margin_v},1",
        f"Style: Hook,Montserrat,64,&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,22,0,"
        f"{hook_align},90,90,{hook_mv},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    if hook_text:
        txt = ass_escape(hook_text.upper() if uppercase else hook_text)
        lines.append(f"Dialogue: 1,{ass_time(0)},{ass_time(min(opts['hook_seconds'], clip_len))},Hook,,0,0,0,,"
                     f"{{\\fad(150,250)}}{txt}")
    if style != "none":
        pre = "{\\blur4}" if neon else ""
        c_txt = ass_color(color)[4:]
        c_hi = ass_color(hi)[4:] if hi else None
        groups = group_words(words, max_words=opts["words_per_line"])
        for gi, g in enumerate(groups):
            g_end = g[-1]["e"] + 0.25
            if gi + 1 < len(groups):
                g_end = min(g_end, groups[gi + 1][0]["s"])
            toks = [ass_escape(x["w"].upper() if uppercase else x["w"]) for x in g]
            if hi is None:
                lines.append(f"Dialogue: 0,{ass_time(g[0]['s'])},{ass_time(g_end)},Cap,,0,0,0,,{pre}{' '.join(toks)}")
                continue
            for wi, wd in enumerate(g):
                st = wd["s"] if wi > 0 else g[0]["s"]
                en = g[wi + 1]["s"] if wi + 1 < len(g) else g_end
                if en <= st:
                    en = st + 0.05
                parts = []
                for ti, t in enumerate(toks):
                    lit = ti <= wi if style == "karaoke" else ti == wi
                    if lit:
                        pop = "\\fscx112\\fscy112" if style in ("bold_yellow", "neon") and ti == wi else ""
                        parts.append(f"{{\\c&H{c_hi}&{pop}}}{t}{{\\c&H{c_txt}&\\fscx100\\fscy100}}")
                    else:
                        parts.append(t)
                lines.append(f"Dialogue: 0,{ass_time(st)},{ass_time(en)},Cap,,0,0,0,,{pre}{' '.join(parts)}")
    return "\n".join(lines) + "\n"


def clip_words(all_words, start, end):
    return [{"w": w["w"], "s": round(w["s"] - start, 3), "e": round(w["e"] - start, 3)}
            for w in all_words if w["s"] >= start - 0.05 and w["e"] <= end + 0.05]


# ---------------- cuts (removed words / fillers / silences) ----------------
FILLERS = {"um", "uh", "umm", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm", "uhh", "ahh"}


def is_filler(word):
    return re.sub(r"[^\w']", "", word.lower()) in FILLERS


def compute_cuts(clip, opts, all_words, start, end):
    """Ranges (seconds relative to the clip start) to remove from the clip."""
    cuts = []
    for c in clip.get("cuts") or []:
        try:
            a, b = max(start, float(c[0])), min(end, float(c[1]))
        except (TypeError, ValueError, IndexError):
            continue
        if b > a:
            cuts.append((a - start, b - start))
    ws = [w for w in all_words if w["s"] >= start - 0.05 and w["e"] <= end + 0.05]
    if opts.get("remove_fillers"):
        cuts += [(w["s"] - start, w["e"] - start) for w in ws if is_filler(w["w"])]
    if opts.get("remove_silences") and ws:
        prev = ws[0]["s"]
        for w in ws:
            if w["s"] - prev > 0.9:
                cuts.append((prev + 0.25 - start, w["s"] - 0.2 - start))
            prev = max(prev, w["e"])
    cuts = sorted((max(0.0, a), min(end - start, b)) for a, b in cuts if b - a > 0.08)
    merged = []
    for a, b in cuts:
        if merged and a <= merged[-1][1] + 0.05:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def retime_words(words, cuts):
    """Drop words inside cuts and shift the rest so captions stay in sync after cutting."""
    if not cuts:
        return words

    def shift(t):
        return t - sum(min(t, b) - a for a, b in cuts if a < t)
    out = []
    for w in words:
        mid = (w["s"] + w["e"]) / 2
        if any(a <= mid <= b for a, b in cuts):
            continue
        out.append({"w": w["w"], "s": round(shift(w["s"]), 3), "e": round(shift(w["e"]), 3)})
    return out


def sample_faces(cap, n, fps, log=print, progress=None, share=0.3):
    """Scan the clip ~5 times a second. Returns ({frame_index: centre_x or None}, [face tuples], frames read)."""
    faces = get_faces(log)
    step = max(1, int(fps / 5))
    samples, found, i = {}, [], 0
    while True:
        if not cap.grab():
            break
        if i % step == 0:
            ok, fr = cap.retrieve()
            f = faces.find(fr) if ok else None
            samples[i] = f[0] if f else None
            if f:
                found.append(f)
        i += 1
        if progress and i % 60 == 0:
            progress(share * min(1, i / max(n, 1)))
    return samples, found, i


def split_regions(fw, fh, W, H, face, crop_x=0.5, top_share=0.5):
    """Split screen for streams: facecam (top) + main view (bottom). Returns (top_h, top_box, bottom_box)."""
    import numpy as np
    top_h = int(H * top_share)
    cx, f_w, cy, f_h = face
    a_top = W / top_h
    rw = min(fw, max(f_w * 3.2, fw * 0.12))
    rh = rw / a_top
    if rh > fh:
        rh, rw = fh, fh * a_top
    x0 = int(np.clip(cx - rw / 2, 0, fw - rw)); y0 = int(np.clip(cy - rh / 2, 0, fh - rh))
    top = (x0, y0, int(rw), int(rh))
    a_bot = W / (H - top_h)
    bh, bw = fh, fh * a_bot
    if bw > fw:
        bw, bh = fw, fw / a_bot
    bx = int(np.clip(crop_x * fw - bw / 2, 0, fw - bw)); by = int((fh - bh) / 2)
    return top_h, top, (bx, by, int(bw), int(bh))


def blur_frame(frame, W=OW, H=OH):
    import cv2
    h, w = frame.shape[:2]
    s = max(W / w, H / h)
    bg = cv2.resize(frame, (int(w * s) + 1, int(h * s) + 1))
    y0, x0 = (bg.shape[0] - H) // 2, (bg.shape[1] - W) // 2
    bg = bg[y0:y0 + H, x0:x0 + W]
    bg = cv2.resize(cv2.GaussianBlur(cv2.resize(bg, (W // 8, H // 8)), (0, 0), 6), (W, H))
    bg = (bg * 0.6).astype(np.uint8)
    fg = cv2.resize(frame, (W, int(h * W / w)))
    if fg.shape[0] > H:
        fg = fg[(fg.shape[0] - H) // 2:(fg.shape[0] - H) // 2 + H]
    y = (H - fg.shape[0]) // 2
    bg[y:y + fg.shape[0]] = fg
    return bg


class _Overlays:
    """Brand logo watermark + progress bar, drawn straight onto each frame."""

    def __init__(self, opts, W, H, log=print):
        import cv2
        self.W, self.H = W, H
        self.bar = bool(opts.get("progress_bar"))
        self.bar_h = max(8, int(H * 0.007))
        self.logo = None
        if opts.get("watermark") and config.LOGO_FILE.exists():
            img = cv2.imread(str(config.LOGO_FILE), cv2.IMREAD_UNCHANGED)
            if img is None:
                log("⚠️ Could not read the brand logo")
                return
            if img.ndim == 2:
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
            if img.shape[2] == 3:
                img = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
            lw = int(min(W, H) * 0.18)
            lh = max(1, min(int(H * 0.25), int(img.shape[0] * lw / img.shape[1])))
            img = cv2.resize(img, (lw, lh), interpolation=cv2.INTER_AREA)
            m = int(min(W, H) * 0.04)
            pos = opts.get("watermark_position", "top_right")
            x = m if pos.endswith("left") else W - lw - m
            y = m if pos.startswith("top") else H - lh - m - (self.bar_h if self.bar else 0)
            self.logo = (x, y, img[:, :, :3].astype(np.float32), img[:, :, 3:].astype(np.float32) / 255 * 0.9)

    def apply(self, frame, frac):
        if self.logo is not None:
            x, y, rgb, a = self.logo
            roi = frame[y:y + rgb.shape[0], x:x + rgb.shape[1]]
            roi[:] = (roi * (1 - a) + rgb * a).astype(np.uint8)
        if self.bar:
            strip = frame[self.H - self.bar_h:, :]
            strip[:] = (strip * 0.4).astype(np.uint8)
            strip[:, :int(self.W * max(0.0, min(1.0, frac)))] = (246, 92, 139)  # BGR of #8B5CF6


def clip_options(opts, clip):
    """Job options with this clip's editor overrides applied."""
    return {**config.DEFAULT_OPTIONS, **opts, **{k: clip[k] for k in config.CLIP_OVERRIDE_KEYS if k in clip}}


def render_clip(video_path, clip, out_path, work_dir, opts, all_words, log=print, progress=None, offset=0.0):
    """Render one clip to out_path. Returns the layout used. `offset` = where video_path starts in the original
    video (long streams render from a downloaded section instead of the whole video)."""
    import cv2
    work_dir = Path(work_dir)
    start, end = float(clip["start"]), float(clip["end"])
    dur = end - start
    opts = clip_options(opts, clip)
    W, H = config.ASPECTS.get(opts.get("aspect"), (OW, OH))
    tag = Path(out_path).stem
    tmp = work_dir / f"cut_{tag}.mp4"
    ass_path = work_dir / f"subs_{tag}.ass"

    # 1) cut the moment out of the source (dropping removed words / fillers / pauses)
    cuts = compute_cuts(clip, opts, all_words, start, end)
    keep, t = [], 0.0
    for a, b in cuts + [(dur, dur)]:
        if a - t > 0.05:
            keep.append((t, a))
        t = b
    if sum(b - a for a, b in keep) < 2:
        raise RuntimeError("Almost the whole clip was cut out — remove fewer words.")
    base_cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{max(0.0, start - offset):.3f}", "-i", video_path,
                "-t", f"{dur:.3f}"]
    enc_cmd = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-c:a", "aac", "-b:a", "192k", tmp]
    if not cuts:
        run(base_cmd + enc_cmd)
    else:
        def graph(audio):
            parts, labels = [], ""
            for i, (a, b) in enumerate(keep):
                parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]")
                labels += f"[v{i}]"
                if audio:
                    parts.append(f"[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{i}]")
                    labels += f"[a{i}]"
            parts.append(f"{labels}concat=n={len(keep)}:v=1:a={1 if audio else 0}[v]" + ("[a]" if audio else ""))
            return ";".join(parts)
        try:
            run(base_cmd + ["-filter_complex", graph(True), "-map", "[v]", "-map", "[a]"] + enc_cmd)
        except RuntimeError:  # source without an audio track
            run(base_cmd + ["-filter_complex", graph(False), "-map", "[v]"] + enc_cmd)
        log(f"✂️ Removed {len(cuts)} part(s), {sum(b - a for a, b in cuts):.1f}s in total")

    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    fw, fh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out_len = sum(b - a for a, b in keep)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or int(out_len * fps)

    # 2) choose the framing
    mode = opts["reframe"]
    crop_w = int(round(fh * W / H))
    if crop_w > fw:
        mode = "blur" if fw / fh < W / H - 0.01 else "center"
        crop_w = fw

    lefts, split = None, None
    portrait = H > W
    if mode == "split" and not portrait:
        mode = "face"  # split screen only makes sense for tall videos
    if mode in ("face", "split"):
        samples, found, n = sample_faces(cap, n, fps, log, progress)
        cap.release()
        cap = cv2.VideoCapture(str(tmp))
        enough = len(found) >= max(2, len(samples) * 0.15)
        med = tuple(float(np.median([f[k] for f in found])) for k in range(4)) if found else None
        small_cam = med is not None and med[1] < fw * 0.085  # a small face = a facecam over gameplay/screen
        if mode == "face" and enough and small_cam and portrait:
            mode = "split"
            log("🎮 Small facecam detected → split screen (facecam on top, main view below)")
        if mode == "split":
            if not found:
                log("No face found for the split screen → blurred background layout")
                mode = "blur"
            else:
                split = split_regions(fw, fh, W, H, med, float(opts.get("crop_x", 0.5)))
        elif mode == "face":
            if not enough:
                mode = "blur"
            else:
                lefts = smooth_track(samples, n, fps, fw, crop_w)

    # 3) captions + hook
    hook = clip.get("hook") if opts["show_hook"] else None
    words = retime_words(clip_words(all_words, start, end), cuts)
    ass_path.write_text(build_ass(words, out_len, opts, hook, W, H), encoding="utf-8")
    overlay = _Overlays(opts, W, H, log)

    # run ffmpeg inside the job folder and use relative paths in the filter: absolute Windows paths
    # ("C:/...") contain ':' which ffmpeg's filter syntax treats as a separator
    fonts_rel = Path(os.path.relpath(config.FONTS, work_dir)).as_posix()
    vf = f"ass={ass_path.name}:fontsdir={fonts_rel}"
    enc = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
         "-r", f"{fps:.3f}", "-i", "-", "-i", str(tmp), "-map", "0:v", "-map", "1:a?", "-vf", vf,
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(Path(out_path).resolve())],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(work_dir))
    err_chunks = []
    reader = threading.Thread(target=lambda: err_chunks.append(enc.stderr.read()), daemon=True)
    reader.start()  # read errors in the background so ffmpeg never blocks on a full pipe
    i = 0
    center_left = int(np.clip(float(opts.get("crop_x", 0.5)) * fw - crop_w / 2, 0, max(0, fw - crop_w)))
    base = 0.3 if (lefts is not None or split is not None) else 0.0
    try:
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if mode == "blur":
                out = blur_frame(fr, W, H)
            elif split is not None:
                top_h, (tx, ty, tw, th), (bx, by, bw, bh) = split
                out = np.empty((H, W, 3), np.uint8)
                out[:top_h] = cv2.resize(fr[ty:ty + th, tx:tx + tw], (W, top_h), interpolation=cv2.INTER_LINEAR)
                out[top_h:] = cv2.resize(fr[by:by + bh, bx:bx + bw], (W, H - top_h), interpolation=cv2.INTER_LINEAR)
                out[top_h - 3:top_h + 3] = 0  # thin divider
            else:
                left = int(lefts[min(i, len(lefts) - 1)]) if lefts is not None else center_left
                out = cv2.resize(fr[:, left:left + crop_w], (W, H), interpolation=cv2.INTER_LINEAR)
            overlay.apply(out, i / max(n - 1, 1))
            enc.stdin.write(out.tobytes())
            i += 1
            if progress and i % 30 == 0:
                progress(base + (1 - base) * min(1, i / max(n, 1)))
    except BrokenPipeError:
        pass
    finally:
        cap.release()
        try:
            enc.stdin.close()
        except Exception:
            pass
        enc.wait()
        reader.join(timeout=5)
    if enc.returncode != 0:
        err = b"".join(c for c in err_chunks if c).decode(errors="ignore")
        raise RuntimeError("Render failed: " + err[-1500:])
    tmp.unlink(missing_ok=True)
    ass_path.unlink(missing_ok=True)
    return mode


def make_poster(video, out_jpg, at=None, width=540):
    """Grab one frame as a JPEG thumbnail. Returns True on success."""
    try:
        cmd = ["ffmpeg", "-y", "-loglevel", "error"]
        if at is not None:
            cmd += ["-ss", f"{max(0.0, at):.2f}"]
        run(cmd + ["-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", str(out_jpg)])
        return Path(out_jpg).exists()
    except Exception:
        return False
