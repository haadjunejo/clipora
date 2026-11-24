/* Clipora clip editor: live 9:16 preview, word-level transcript, timeline with waveform, six settings tabs. */
"use strict";

const PRESET_SIZE = { bold_yellow: 100, karaoke: 84, boxed: 74, neon: 82, minimal: 66, none: 66 };
const FILLERS = new Set(["um", "uh", "umm", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm", "uhh", "ahh"]);
const isFiller = (w) => FILLERS.has(w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""));
const OVERRIDE_KEYS = ["caption_style", "reframe", "crop_x", "show_hook", "hook_seconds", "hook_position", "caption_size", "caption_position", "text_color", "highlight_color", "uppercase", "words_per_line", "remove_fillers", "remove_silences", "progress_bar", "watermark", "watermark_position"];
const ASPECT_WH = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };

function groupWords(words, maxWords) {
  const maxChars = Math.max(18, maxWords * 6), groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || cur.reduce((a, x) => a + x.w.length + 1, 0) + w.w.length > maxChars || w.s - cur[cur.length - 1].e > 0.6)) { groups.push(cur); cur = []; }
    cur.push(w);
    if (/[.!?…]$/.test(w.w)) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const Editor = { isDirty: () => false };

Editor.open = function (jobId, index) {
  setActiveNav("projects");
  const S = scope();
  const view = $("#view");
  view.className = "view full";
  view.innerHTML = `<div class="empty" style="padding-top:18vh"><span class="spinner" style="margin:0 auto 16px;width:26px;height:26px"></span><p>Opening the editor…</p></div>`;
  const E = {
    job: null, clip: null, words: [], segs: [], start: 0, end: 0, cuts: [], o: {}, text: {},
    mode: "live", playing: false, loop: true, sel: null, anchor: null, nowIdx: -1, tab: store.get("ed-tab", "captions"),
    hist: [], fut: [], saved: "", renderedVis: "", rendered: null, srcOK: true, busy: false, win: [0, 1], zoom: 1, peaks: null, peaksKey: "",
    autoCuts: [], allCuts: [], need: true,
  };

  /* ---------------- state helpers ---------------- */
  const snapshot = () => JSON.stringify({ s: E.start, e: E.end, c: E.cuts, o: E.o, t: E.text });
  const visSnap = () => JSON.stringify({ s: E.start, e: E.end, c: E.cuts, o: E.o, h: E.text.hook });
  const dirty = () => snapshot() !== E.saved;
  Editor.isDirty = dirty;
  function commit() { // remember the previous state for undo
    const cur = snapshot();
    if (E.hist[E.hist.length - 1] !== cur) { E.hist.push(cur); if (E.hist.length > 100) E.hist.shift(); E.fut = []; }
  }
  function restore(snap) {
    const x = JSON.parse(snap);
    E.start = x.s; E.end = x.e; E.cuts = x.c; E.o = x.o; E.text = x.t;
    changed(true); drawSettings();
  }
  function undo() { if (!E.hist.length) return; E.fut.push(snapshot()); restore(E.hist.pop()); }
  function redo() { if (!E.fut.length) return; E.hist.push(snapshot()); restore(E.fut.pop()); }

  function computeCuts() {
    const cuts = [];
    for (const [a, b] of E.cuts) { const x = Math.max(E.start, a), y = Math.min(E.end, b); if (y > x) cuts.push([x, y, "m"]); }
    const ws = E.words.filter((w) => w.s >= E.start - 0.05 && w.e <= E.end + 0.05);
    if (E.o.remove_fillers) ws.forEach((w) => { if (isFiller(w.w)) cuts.push([w.s, w.e, "a"]); });
    if (E.o.remove_silences && ws.length) {
      let prev = ws[0].s;
      for (const w of ws) { if (w.s - prev > 0.9) cuts.push([prev + 0.25, w.s - 0.2, "a"]); prev = Math.max(prev, w.e); }
    }
    E.autoCuts = cuts.filter((c) => c[2] === "a");
    const sorted = cuts.filter(([a, b]) => b - a > 0.08).sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [a, b] of sorted) { if (merged.length && a <= merged[merged.length - 1][1] + 0.05) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b); else merged.push([a, b]); }
    E.allCuts = merged;
  }
  const cutBefore = (t) => E.allCuts.reduce((acc, [a, b]) => acc + (a < t ? Math.min(t, b) - a : 0), 0);
  const outLen = () => (E.end - E.start) - cutBefore(E.end);
  const outT = (t) => (t - E.start) - cutBefore(t);
  const inCut = (t) => E.allCuts.find(([a, b]) => t >= a && t < b);
  const srcFromOut = (o, st) => { // rendered-time → source-time, using the state the clip was rendered with
    let t = st.start;
    for (const [a, b] of st.cuts) { if (a - t >= o) break; o -= a - t; t = b; }
    return t + o;
  };

  /* ---------------- load ---------------- */
  (async () => {
    let job, w;
    try {
      job = await api(`/api/jobs/${jobId}`);
      const c = job.clips.find((x) => x.index === index);
      if (!c) throw new Error("Clip not found");
      w = await api(`/api/jobs/${jobId}/words?start=${c.start}&end=${c.end}&pad=120`);
    } catch (e) {
      view.innerHTML = `<div class="card empty" style="max-width:520px;margin:10vh auto"><div class="ico">${ic("alert", "lg")}</div><h3>Can't open this clip</h3><p>${esc(e.message)}</p><a class="btn primary" href="#/p/${esc(jobId)}">Back to project</a></div>`;
      return;
    }
    if (!view.isConnected || App.route !== location.hash) return;
    E.job = job; E.clip = job.clips.find((x) => x.index === index);
    E.segs = w.segments.map((sg) => ({ s: sg.s, e: sg.e, words: [] }));
    w.segments.forEach((sg, si) => sg.words.forEach((x) => { const word = { w: x.w, s: x.s, e: x.e, i: E.words.length, seg: si }; E.words.push(word); E.segs[si].words.push(word); }));
    loadClipState();
    E.saved = snapshot();
    E.renderedVis = visSnap();
    E.rendered = { start: E.start, cuts: E.allCuts.map((c) => [...c]) };
    build();
  })();

  function loadClipState() {
    const c = E.clip;
    E.start = c.start; E.end = c.end;
    E.cuts = (c.cuts || []).map((x) => [+x[0], +x[1]]);
    E.o = {}; OVERRIDE_KEYS.forEach((k) => (E.o[k] = c.effective ? c.effective[k] : E.job.options[k]));
    E.text = { title: c.title || "", hook: c.hook || "", description: c.description || "", hashtags: [...(c.hashtags || [])] };
    computeCuts();
  }

  /* ---------------- layout ---------------- */
  let src, rvid, canvas, ctx, small, sctx, screenEl, ro;
  function build() {
    const c = E.clip, job = E.job;
    const aspect = job.options.aspect || "9:16";
    setCrumbs([{ label: "Projects", href: "#/projects" }, { label: job.title, href: `#/p/${job.id}` }, { label: `Clip ${c.index}` }]);
    view.innerHTML = `
    <div class="ed" data-m="preview">
      <div class="ed-bar">
        <a class="icon-btn" href="#/p/${esc(job.id)}" aria-label="Back to project">${ic("back")}</a>
        <div class="ttl grow"><div class="eyebrow" style="font-size:10.5px">Clip ${c.index} · <span id="edVer">v${c.version}</span> · <span class="mono">${esc(aspect)}</span></div><h2 id="edTitle"></h2></div>
        <span id="edState"></span>
        <div class="acts">
          <button class="icon-btn" id="undoBtn" title="Undo (Ctrl+Z)" aria-label="Undo">${ic("undo", "sm")}</button>
          <button class="btn ghost" id="discardBtn">Discard</button>
          <button class="btn" id="saveBtn">${ic("check", "sm")}Save</button>
          <button class="btn primary" id="renderBtn">${ic("refresh", "sm")}Re-render</button>
        </div>
      </div>
      <div class="mtabs" id="mtabs">${segHTML([["preview", "Preview", "play"], ["transcript", "Transcript", "type"], ["edit", "Edit", "settings"]], "preview", "full")}</div>

      <section class="card panel tx-panel" data-mpane="transcript">
        <div class="panel-h"><h3>Transcript</h3><div class="search" style="flex:0 1 150px">${ic("search")}<input class="input" id="txq" placeholder="Find…" style="min-height:30px;font-size:12px" aria-label="Find in transcript"></div></div>
        <div class="panel-b"><div class="tx" id="tx"></div></div>
        <div class="panel-f">
          <div class="sel-bar" id="selBar"><span class="tiny faint">Click a word to jump · shift-click or drag to select</span></div>
          <div class="row tiny faint" id="txLegend"></div>
        </div>
      </section>

      <section class="card stage" data-mpane="preview">
        <div class="stage-top">
          <div id="modeSeg">${segHTML([["live", "Live preview", "eye"], ["rendered", "Rendered", "film"]], E.mode)}</div>
          <span class="tiny faint" id="stageNote"></span>
        </div>
        <div class="stage-mid">
          <div class="device ${aspect === "1:1" ? "sq" : aspect === "16:9" ? "wide" : ""}">
            <div class="screen ${aspect === "16:9" ? "landscape" : ""}" id="screen">
              <canvas id="cv"></canvas>
              <video class="rendered hidden" id="rvid" playsinline preload="metadata"></video>
              <div class="hookov" id="hookOv"><span></span></div>
              <div class="cap" id="capOv"></div>
              <img class="wm hidden" id="wmOv" alt="">
              <div class="pbar hidden" id="pbOv"><span></span></div>
              <div class="msg hidden" id="scrMsg"></div>
              <div class="busy hidden" id="scrBusy"><span class="spinner" style="width:28px;height:28px"></span><span id="busyTxt">Rendering…</span></div>
            </div>
          </div>
          <video id="src" playsinline preload="auto" style="position:absolute;width:2px;height:2px;opacity:0;pointer-events:none;left:0;top:0"></video>
        </div>
        <div class="transport">
          <button class="icon-btn flat" id="toStart" title="Go to start" aria-label="Go to start">${ic("skipb", "sm")}</button>
          <button class="icon-btn flat" id="back5" title="Back 5s (Shift+←)" aria-label="Back 5 seconds">${ic("left", "sm")}</button>
          <button class="play-btn" id="playBtn" aria-label="Play">${ic("play")}</button>
          <button class="icon-btn flat" id="fwd5" title="Forward 5s (Shift+→)" aria-label="Forward 5 seconds">${ic("right", "sm")}</button>
          <button class="icon-btn flat on" id="loopBtn" title="Loop clip" aria-label="Loop">${ic("repeat", "sm")}</button>
          <span class="tc" id="tc"></span>
          <button class="icon-btn flat" id="muteBtn" title="Mute" aria-label="Mute">${ic("vol", "sm")}</button>
        </div>
      </section>

      <section class="card panel set-panel" data-mpane="edit">
        <div class="tabs" id="tabs" role="tablist">${[["captions", "Captions", "type"], ["layout", "Layout", "layout"], ["hook", "Hook", "zap"], ["brand", "Brand", "palette"], ["audio", "Audio", "music"], ["text", "Text", "hash"]]
        .map(([k, l, i]) => `<button role="tab" data-t="${k}" class="${E.tab === k ? "on" : ""}">${ic(i, "sm")}${l}</button>`).join("")}</div>
        <div class="panel-b" id="setBody"></div>
      </section>

      <section class="card tl" data-mpane="preview">
        <div class="tl-bar">
          <div class="grp"><span class="lbl">In</span><button class="icon-btn sm flat" data-n="s:-1" title="−1s">−</button><input id="inT" aria-label="Start time"><button class="icon-btn sm flat" data-n="s:1" title="+1s">+</button></div>
          <div class="grp"><span class="lbl">Out</span><button class="icon-btn sm flat" data-n="e:-1" title="−1s">−</button><input id="outT" aria-label="End time"><button class="icon-btn sm flat" data-n="e:1" title="+1s">+</button></div>
          <button class="btn sm ghost" id="setIn" title="Set start at playhead (I)">${ic("bracketL", "sm")}<span class="desk-only">Start here</span></button>
          <button class="btn sm ghost" id="setOut" title="Set end at playhead (O)">${ic("bracketR", "sm")}<span class="desk-only">End here</span></button>
          <span class="chip" id="lenChip"></span>
          <div class="row" style="margin-left:auto;gap:4px">
            <button class="icon-btn sm" id="zOut" title="Zoom out" aria-label="Zoom out">${ic("zoomout", "sm")}</button>
            <button class="icon-btn sm" id="zFit" title="Fit clip" aria-label="Fit">${ic("fit", "sm")}</button>
            <button class="icon-btn sm" id="zIn" title="Zoom in" aria-label="Zoom in">${ic("zoomin", "sm")}</button>
          </div>
        </div>
        <div class="tl-wrap"><div class="tl-canvas" id="tlc"><canvas id="tlcv"></canvas><div class="tl-sel" id="tlSel"></div><div class="tl-h" id="hIn" aria-label="Start handle"></div><div class="tl-h" id="hOut" aria-label="End handle"></div><div class="tl-ph" id="tlPh"></div></div></div>
      </section>
    </div>`;

    src = $("#src"); rvid = $("#rvid"); canvas = $("#cv"); ctx = canvas.getContext("2d");
    small = document.createElement("canvas"); sctx = small.getContext("2d");
    screenEl = $("#screen");
    // live preview needs the source video; fall back to the rendered file if the browser can't play it
    // long streams have no full video: play the downloaded section around this clip instead
    E.off = 0; E.sec = null;
    if (job.source_url) src.src = job.source_url;
    else if (c.section) { E.sec = c.section; E.off = c.section[0]; src.src = `/media/${job.id}/${c.section[2]}`; }
    else E.srcOK = false;
    src.addEventListener("loadedmetadata", () => { setVT(E.start + 0.01); });
    src.addEventListener("seeked", () => (E.need = true));
    src.addEventListener("loadeddata", () => (E.need = true));
    src.addEventListener("error", () => { E.srcOK = false; if (E.mode === "live" && E.clip.url) setMode("rendered"); drawStage(); });
    src.addEventListener("waiting", () => $("#stageNote").textContent = "Buffering…");
    src.addEventListener("playing", () => drawStage());
    rvid.addEventListener("ended", () => { if (E.loop && E.mode === "rendered") { rvid.currentTime = 0; rvid.play(); } else setPlaying(false); });
    if (c.url) rvid.src = c.url;
    ro = new ResizeObserver(() => { sizeCanvas(); drawTimeline(); }); ro.observe(screenEl); ro.observe($("#tlc"));
    S.add(() => { ro.disconnect(); src.pause(); src.removeAttribute("src"); src.load(); rvid.pause(); });

    bindUI();
    fitWindow();
    loadFraming();
    drawTranscript();
    drawSettings();
    changed(false);
    if (!E.srcOK && c.url) setMode("rendered"); else setMode(E.mode);
    if (c.status === "rendering" || c.status === "queued") watchRender();
    loop();
  }

  function sizeCanvas() {
    const r = screenEl.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(r.width * dpr)); canvas.height = Math.max(2, Math.round(r.height * dpr));
    E.need = true;
  }

  /* ---------------- drawing the live preview ---------------- */
  function drawFrame() {
    const W = canvas.width, H = canvas.height;
    if (src.readyState < 2 || !src.videoWidth) { ctx.fillStyle = "#0c0b12"; ctx.fillRect(0, 0, W, H); return; }
    const vw = src.videoWidth, vh = src.videoHeight;
    const mode = previewMode(W, H, vw, vh);
    const cropW = vh * W / H;
    if (mode === "split") {
      const f = E.framing, topH = Math.round(H / 2), aTop = W / topH;
      let rw = Math.min(vw, Math.max(f.w * vw * 3.2, vw * 0.12)), rh = rw / aTop;
      if (rh > vh) { rh = vh; rw = vh * aTop; }
      const tx = clamp(f.cx * vw - rw / 2, 0, vw - rw), ty = clamp(f.cy * vh - rh / 2, 0, vh - rh);
      ctx.drawImage(src, tx, ty, rw, rh, 0, 0, W, topH);
      const aBot = W / (H - topH);
      let bh = vh, bw = vh * aBot;
      if (bw > vw) { bw = vw; bh = vw / aBot; }
      const bx = clamp(E.o.crop_x * vw - bw / 2, 0, vw - bw);
      ctx.drawImage(src, bx, (vh - bh) / 2, bw, bh, 0, topH, W, H - topH);
      ctx.fillStyle = "#000"; ctx.fillRect(0, topH - Math.max(1, H * 0.0016), W, Math.max(2, H * 0.0032));
      return;
    }
    if (mode === "blur") {
      const sw = 36, sh = Math.max(2, Math.round(36 * H / W));
      small.width = sw; small.height = sh;
      const sc = Math.max(sw / vw, sh / vh);
      sctx.drawImage(src, (sw - vw * sc) / 2, (sh - vh * sc) / 2, vw * sc, vh * sc);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(small, 0, 0, W, H);
      ctx.fillStyle = "rgba(0,0,0,.42)"; ctx.fillRect(0, 0, W, H);
      const fh = vh * W / vw;
      if (fh <= H) ctx.drawImage(src, 0, (H - fh) / 2, W, fh);
      else { const sh2 = H * vw / W; ctx.drawImage(src, 0, (vh - sh2) / 2, vw, sh2, 0, 0, W, H); }
    } else {
      const cw = Math.min(vw, cropW);
      const cx = mode === "face" && E.framing?.found ? E.framing.cx * vw : E.o.crop_x * vw;
      ctx.drawImage(src, clamp(cx - cw / 2, 0, vw - cw), 0, cw, vh, 0, 0, W, H);
    }
  }
  function previewMode(W, H, vw, vh) {
    let mode = E.o.reframe;
    const f = E.framing, portrait = H > W;
    if (mode === "split" && !portrait) mode = "face";
    if (mode === "face" && f?.found && f.small && portrait) mode = "split";  // same rule as the renderer
    if (mode === "split" && !f?.found) mode = f ? "blur" : "center";
    if (mode !== "split" && vh * W / H > vw) mode = vw / vh < W / H - 0.01 ? "blur" : "center";
    return mode;
  }
  let framingTimer = 0, framingKey = "";
  function loadFraming() {
    clearTimeout(framingTimer);
    framingTimer = setTimeout(async () => {
      const key = `${E.start.toFixed(0)}-${E.end.toFixed(0)}`;
      if (key === framingKey) return;
      framingKey = key;
      try { E.framing = await api(`/api/jobs/${E.job.id}/framing?start=${E.start.toFixed(2)}&end=${E.end.toFixed(2)}`); }
      catch { E.framing = { found: false }; }
      E.need = true; drawStage(); if (E.tab === "layout") drawSettings();
    }, 500);
  }
  S.add(() => clearTimeout(framingTimer));
  function overlayStyle() {
    const [OW, OH] = ASPECT_WH[E.job.options.aspect || "9:16"], portrait = OH > OW;
    return { OW, OH, portrait };
  }
  function drawOverlays(t) {
    const { OW, portrait } = overlayStyle();
    const o = E.o, live = E.mode === "live";
    const ot = live ? outT(t) : (rvid.currentTime || 0);
    // captions
    const cap = $("#capOv");
    const stl = styleById(o.caption_style);
    if (!live || o.caption_style === "none") cap.innerHTML = "";
    else {
      const ws = E.words.filter((w) => w.s >= E.start - 0.05 && w.e <= E.end + 0.05 && !inCut((w.s + w.e) / 2));
      const groups = groupWords(ws, o.words_per_line);
      let html = "";
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        let gEnd = g[g.length - 1].e + 0.25;
        if (gi + 1 < groups.length) gEnd = Math.min(gEnd, groups[gi + 1][0].s);
        if (t < g[0].s || t >= gEnd) continue;
        let wi = 0;
        for (let k = 0; k < g.length; k++) if (t >= (k ? g[k].s : g[0].s)) wi = k;
        const hi = o.highlight_color || stl.hi, txt = o.text_color || "#FFFFFF";
        const toks = g.map((w, k) => {
          const word = esc(o.uppercase ? w.w.toUpperCase() : w.w);
          const lit = hi && (o.caption_style === "karaoke" ? k <= wi : k === wi);
          return lit ? `<span class="${k === wi ? "hl" : ""}" style="color:${hi}">${word}</span>` : word;
        }).join(" ");
        html = o.caption_style === "boxed" ? `<span class="line">${toks}</span>` : toks;
        cap.style.color = txt;
        break;
      }
      cap.className = `cap st-${o.caption_style}`;
      cap.style.fontSize = ((PRESET_SIZE[o.caption_style] * (o.caption_size / 100)) / OW * 100) + "cqw";
      const pos = o.caption_position;
      Object.assign(cap.style, pos === "middle" ? { top: "50%", bottom: "auto", transform: "translateY(-50%)" }
        : pos === "top" ? { top: (portrait ? 24 : 18) + "%", bottom: "auto", transform: "none" }
          : { top: "auto", bottom: (portrait ? 27 : 10) + "%", transform: "none" });
      if (cap.innerHTML !== html) cap.innerHTML = html;
    }
    // hook
    const hook = $("#hookOv");
    const showHook = live && o.show_hook && E.text.hook && ot < o.hook_seconds;
    hook.style.opacity = showHook ? 1 : 0;
    hook.classList.toggle("center", o.hook_position === "center");
    hook.style.top = o.hook_position === "center" ? "50%" : (portrait ? "12%" : "7%");
    const hs = hook.firstElementChild;
    const ht = o.uppercase ? E.text.hook.toUpperCase() : E.text.hook;
    if (hs.textContent !== ht) hs.textContent = ht;
    hs.style.fontSize = (64 / OW * 100) + "cqw";
    // watermark + progress bar
    const wm = $("#wmOv");
    const showWm = live && o.watermark && App.status?.logo;
    wm.classList.toggle("hidden", !showWm);
    if (showWm) { if (!wm.getAttribute("src")) wm.src = "/brand/logo.png"; wm.className = `wm ${o.watermark_position}`; }
    const pb = $("#pbOv");
    pb.classList.toggle("hidden", !(live && o.progress_bar));
    if (live && o.progress_bar) pb.firstElementChild.style.width = clamp(ot / Math.max(outLen(), .1), 0, 1) * 100 + "%";
  }

  /* ---------------- playback ---------------- */
  const vT = () => src.currentTime + (E.off || 0);  // video time → time in the original stream
  const setVT = (t) => { src.currentTime = Math.max(0, t - (E.off || 0)); };
  const curT = () => E.mode === "live" ? vT() : srcFromOut(rvid.currentTime || 0, E.rendered);
  function setPlaying(p) {
    E.playing = p;
    const v = E.mode === "live" ? src : rvid;
    if (p) {
      if (E.mode === "live" && (vT() < E.start - 0.05 || vT() >= E.end - 0.05)) setVT(E.start);
      v.play().catch(() => { E.playing = false; drawTransport(); });
    } else { src.pause(); rvid.pause(); }
    drawTransport();
  }
  function seek(t) {
    if (E.mode === "live") { setVT(clamp(t, E.sec ? E.sec[0] : 0, E.sec ? E.sec[1] : (E.job.duration || t))); E.need = true; }
    else {
      const st = E.rendered; let o = t - st.start;
      for (const [a, b] of st.cuts) if (a < t) o -= Math.min(t, b) - a;
      rvid.currentTime = clamp(o, 0, rvid.duration || o);
    }
  }
  function drawTransport() {
    $("#playBtn").innerHTML = ic(E.playing ? "pause" : "play");
    $("#playBtn").setAttribute("aria-label", E.playing ? "Pause" : "Play");
  }
  let raf = 0, lastTC = "";
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!view.isConnected) return;
    const live = E.mode === "live";
    if (live && E.playing) {
      const t = vT(), cut = inCut(t);
      if (cut) setVT(cut[1] + 0.01);
      else if (t >= E.end || (E.sec && t >= E.sec[1] - 0.05)) { if (E.loop) setVT(E.start); else { setPlaying(false); setVT(E.end); } }
    }
    const t = curT();
    if (live && (E.playing || E.need)) { drawFrame(); E.need = false; }
    if (live || E.playing) drawOverlays(t);
    // time code + playhead + current word
    const ot = live ? outT(t) : (rvid.currentTime || 0), total = live ? outLen() : (rvid.duration || outLen());
    const tc = `<b>${fmtTC(clamp(ot, 0, total))}</b> / ${fmtTC(total)}`;
    if (tc !== lastTC) { $("#tc").innerHTML = tc; lastTC = tc; }
    placePlayhead(t);
    markNow(t);
  }
  S.add(() => cancelAnimationFrame(raf));

  function setMode(m) {
    if (m === "live" && !E.srcOK) { toast("Live preview isn't available for this video format", "info"); m = "rendered"; }
    if (m === "rendered" && !E.clip.url) { m = "live"; }
    const t = curT();
    setPlaying(false);
    E.mode = m;
    $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === m));
    $("#cv").classList.toggle("hidden", m !== "live");
    rvid.classList.toggle("hidden", m !== "rendered");
    if (m === "rendered") { $("#capOv").innerHTML = ""; $("#hookOv").style.opacity = 0; $("#wmOv").classList.add("hidden"); $("#pbOv").classList.add("hidden"); }
    seek(t); E.need = true;
    drawStage();
  }
  function drawStage() {
    const note = $("#stageNote");
    if (E.mode === "live") {
      const m = src && src.videoWidth ? previewMode(canvas.width, canvas.height, src.videoWidth, src.videoHeight) : E.o.reframe;
      note.textContent = m === "split" && E.o.reframe === "face" ? "Small facecam found — rendering as split screen"
        : m === "face" ? "Preview uses the average face position — the render follows it live" : "Live preview of your edits";
    }
    else note.textContent = visSnap() !== E.renderedVis ? "Shows the last render — re-render to apply edits" : `Rendered v${E.clip.version}`;
    $$("#modeSeg button")[1].disabled = !E.clip.url;
    const msg = $("#scrMsg");
    if (E.mode === "live" && !E.srcOK) {
      msg.classList.remove("hidden");
      msg.innerHTML = E.job.long ? `${ic("info", "lg")}<b>Live preview unavailable</b><span>Long stream: only clip sections are downloaded. Use Rendered, or Re-render once to download this clip's section.</span>`
        : `${ic("alert", "lg")}<b>Live preview unavailable</b><span>This video format can't play in the browser. Use Rendered.</span>`;
    }
    else if (E.mode === "live" && E.sec && (E.start < E.sec[0] - 0.05 || E.end > E.sec[1] + 0.05)) {
      note.textContent = "Outside the downloaded section: the preview stops at its edge. Re-render downloads the new range.";
    }
    else msg.classList.add("hidden");
  }

  /* ---------------- transcript ---------------- */
  function drawTranscript() {
    const q = ($("#txq").value || "").trim().toLowerCase();
    const tx = $("#tx");
    if (!E.words.length) { tx.innerHTML = `<div class="empty" style="padding:30px 6px"><p style="margin:0">No words were transcribed here.</p></div>`; return; }
    tx.innerHTML = E.segs.filter((sg) => sg.words.length).map((sg) => `<div class="seg-row"><span class="ts" data-t="${sg.s}">${fmtTC(sg.s)}</span>${sg.words.map((w) => `<span class="w" data-i="${w.i}">${esc(w.w)}</span>`).join(" ")}</div>`).join("");
    paintWords();
    if (q) $$(".w", tx).forEach((el) => { if (E.words[+el.dataset.i].w.toLowerCase().includes(q)) el.style.outline = "1.5px solid var(--warn)"; });
    const first = $(`.w[data-i="${(E.words.find((w) => w.s >= E.start - 0.05) || {}).i}"]`, tx);
    if (first && !q) requestAnimationFrame(() => { const pb = tx.parentElement; pb.scrollTop += first.getBoundingClientRect().top - pb.getBoundingClientRect().top - 40; });
  }
  function paintWords() {
    const manual = E.cuts, auto = E.autoCuts;
    const selA = E.sel ? Math.min(E.sel[0], E.sel[1]) : -1, selB = E.sel ? Math.max(E.sel[0], E.sel[1]) : -2;
    $$("#tx .w").forEach((el) => {
      const w = E.words[+el.dataset.i], mid = (w.s + w.e) / 2;
      const inside = w.s >= E.start - 0.05 && w.e <= E.end + 0.05;
      const m = manual.some(([a, b]) => mid >= a && mid <= b), a = !m && auto.some(([x, y]) => mid >= x && mid <= y);
      el.className = "w" + (inside ? " in" : "") + (isFiller(w.w) ? " filler" : "") + (m ? " cut" : "") + (a ? " autocut" : "") + (w.i >= selA && w.i <= selB ? " sel" : "") + (w.i === E.nowIdx ? " now" : "");
    });
    const fill = E.words.filter((w) => w.s >= E.start && w.e <= E.end && isFiller(w.w)).length;
    $("#txLegend").innerHTML = `<span>${E.words.filter((w) => w.s >= E.start - 0.05 && w.e <= E.end + 0.05).length} words</span><span>·</span><span>${fill} filler${fill === 1 ? "" : "s"}</span><span>·</span><span>${E.cuts.length} cut${E.cuts.length === 1 ? "" : "s"}</span>`;
  }
  function markNow(t) {
    const w = E.words.find((x) => t >= x.s && t < x.e + 0.05);
    const i = w ? w.i : -1;
    if (i === E.nowIdx) return;
    const prev = $(`#tx .w.now`); if (prev) prev.classList.remove("now");
    E.nowIdx = i;
    if (i >= 0) {
      const el = $(`#tx .w[data-i="${i}"]`);
      if (el) {
        el.classList.add("now");
        if (E.playing) { const pb = el.closest(".panel-b"), r = el.getBoundingClientRect(), pr = pb.getBoundingClientRect(); if (r.top < pr.top + 20 || r.bottom > pr.bottom - 20) pb.scrollTop += r.top - pr.top - pr.height / 3; }
      }
    }
  }
  function drawSelBar() {
    const bar = $("#selBar");
    if (!E.sel) { bar.innerHTML = `<span class="tiny faint">Click a word to jump · shift-click or drag to select</span>`; return; }
    const a = E.words[Math.min(...E.sel)], b = E.words[Math.max(...E.sel)];
    const n = Math.abs(E.sel[1] - E.sel[0]) + 1;
    const hasCut = E.cuts.some(([x, y]) => x < b.e && y > a.s);
    bar.innerHTML = `<span class="tiny muted" style="width:100%">${n} word${n === 1 ? "" : "s"} · ${fmtTC(a.s)}–${fmtTC(b.e)}</span>
      <button class="btn sm" data-sa="clip">${ic("fit", "sm")}Use as clip</button>
      ${hasCut ? `<button class="btn sm" data-sa="restore">${ic("undo", "sm")}Restore</button>` : `<button class="btn sm danger" data-sa="cut">${ic("scissors", "sm")}Cut</button>`}
      <button class="icon-btn sm flat" data-sa="clear" aria-label="Clear selection">${ic("x", "sm")}</button>`;
  }

  /* ---------------- timeline ---------------- */
  const tlX = (t) => { const [a, b] = E.win, w = $("#tlc").clientWidth; return ((t - a) / (b - a)) * w; };
  const tlT = (x) => { const [a, b] = E.win, w = $("#tlc").clientWidth; return a + (x / w) * (b - a); };
  function fitWindow() {
    const len = E.end - E.start, pad = clamp(len * 0.35 / E.zoom, 1, 300);
    const dur = E.job.duration || E.end + pad;
    E.win = [Math.max(0, E.start - pad), Math.min(dur, E.end + pad)];
    loadPeaks();
  }
  let peaksTimer = 0;
  function loadPeaks() {
    clearTimeout(peaksTimer);
    peaksTimer = setTimeout(async () => {
      const [a, b] = E.win, key = `${a.toFixed(2)}-${b.toFixed(2)}`;
      if (key === E.peaksKey || b - a > 900) return;
      try {
        const n = Math.round(clamp($("#tlc").clientWidth / 3, 80, 700));
        const r = await api(`/api/jobs/${E.job.id}/waveform?start=${a.toFixed(2)}&end=${b.toFixed(2)}&n=${n}`);
        E.peaks = r; E.peaksKey = key; drawTimeline();
      } catch { }
    }, 250);
  }
  S.add(() => clearTimeout(peaksTimer));
  function drawTimeline() {
    const box = $("#tlc"); if (!box) return;
    const cv = $("#tlcv"), dpr = Math.min(2, devicePixelRatio || 1), W = box.clientWidth, H = box.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const c3 = css.getPropertyValue("--text-3").trim(), line = css.getPropertyValue("--line-2").trim(), acc = "#8b5cf6";
    const [a, b] = E.win, span = b - a;
    // ruler
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => (s / span) * W >= 70) || 600;
    g.font = "600 10px ui-monospace, Menlo, monospace"; g.fillStyle = c3; g.strokeStyle = line;
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      const x = ((t - a) / span) * W;
      g.beginPath(); g.moveTo(x, 14); g.lineTo(x, 20); g.stroke();
      g.fillText(fmtDur(t), x + 3, 11);
      for (let k = 1; k < 4; k++) { const xx = x + (k * step / 4 / span) * W; if (xx < W) { g.beginPath(); g.moveTo(xx, 17); g.lineTo(xx, 20); g.stroke(); } }
    }
    // waveform
    const wy0 = 26, wh = 58, mid = wy0 + wh / 2;
    const pk = E.peaks && E.peaksKey ? E.peaks : null;
    if (pk && pk.peaks.length) {
      const n = pk.peaks.length, pa = pk.start, pb = pk.end;
      const bw = Math.max(1, ((pb - pa) / span) * W / n);
      for (let i = 0; i < n; i++) {
        const t = pa + (i / n) * (pb - pa), x = ((t - a) / span) * W;
        if (x < -2 || x > W + 2) continue;
        const h = Math.max(1.5, pk.peaks[i] * wh * 0.92);
        const inside = t >= E.start && t <= E.end;
        g.fillStyle = inside ? "rgba(181,138,255,.95)" : "rgba(160,157,175,.35)";
        g.fillRect(x, mid - h / 2, Math.max(1, bw - 1), h);
      }
    } else {
      g.fillStyle = "rgba(160,157,175,.18)";
      for (let x = 0; x < W; x += 4) { const h = 4 + Math.abs(Math.sin(x * 0.05)) * 14; g.fillRect(x, mid - h / 2, 2, h); }
    }
    // caption blocks
    const cy = 92, ch = 22;
    const ws = E.words.filter((w) => w.e > a && w.s < b);
    groupWords(ws, E.o.words_per_line).forEach((grp) => {
      const x0 = ((grp[0].s - a) / span) * W, x1 = ((grp[grp.length - 1].e - a) / span) * W;
      const inside = grp[0].s >= E.start - 0.05 && grp[grp.length - 1].e <= E.end + 0.05;
      g.fillStyle = inside ? "rgba(139,92,246,.35)" : "rgba(160,157,175,.12)";
      roundRect(g, x0, cy, Math.max(3, x1 - x0 - 2), ch, 5); g.fill();
      if (x1 - x0 > 40) {
        g.save(); g.beginPath(); g.rect(x0 + 5, cy, x1 - x0 - 10, ch); g.clip();
        g.fillStyle = inside ? "#f4f2fb" : c3; g.font = "600 10px Inter, sans-serif";
        g.fillText(grp.map((w) => w.w).join(" "), x0 + 6, cy + 14.5); g.restore();
      }
    });
    // cuts
    E.allCuts.forEach(([x, y]) => {
      const x0 = ((x - a) / span) * W, x1 = ((y - a) / span) * W;
      g.fillStyle = "rgba(241,109,130,.22)"; g.fillRect(x0, wy0 - 2, x1 - x0, cy + ch - wy0 + 2);
      g.strokeStyle = "rgba(241,109,130,.75)"; g.lineWidth = 1;
      g.save(); g.beginPath(); g.rect(x0, wy0 - 2, x1 - x0, cy + ch - wy0 + 2); g.clip();
      for (let k = x0 - 120; k < x1; k += 6) { g.beginPath(); g.moveTo(k, cy + ch); g.lineTo(k + 120, wy0 - 2); g.stroke(); }
      g.restore();
    });
    // selection + handles
    const s = $("#tlSel"), xs = tlX(E.start), xe = tlX(E.end);
    s.style.left = xs + "px"; s.style.width = Math.max(2, xe - xs) + "px";
    $("#hIn").style.left = xs + "px"; $("#hOut").style.left = xe + "px";
    g.fillStyle = acc;
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  let lastPh = -1;
  function placePlayhead(t) {
    const x = Math.round(tlX(t) * 2) / 2;
    if (x === lastPh) return; lastPh = x;
    const ph = $("#tlPh"); if (ph) ph.style.left = x + "px";
  }
  function snapWord(t, which) {
    let best = t, bd = 0.15;
    for (const w of E.words) { const v = which === "s" ? w.s - 0.08 : w.e + 0.25; const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } }
    return best;
  }

  /* ---------------- settings panel ---------------- */
  const swatchRow = (key, list, def) => {
    const cur = E.o[key] || "";
    return `<div class="swatches" data-sw="${key}">
      <button type="button" class="swatch ${!cur ? "on" : ""}" data-c="" title="Style default" style="background:${def || "#fff"};position:relative">${!def ? "" : ""}</button>
      ${list.map((c) => `<button type="button" class="swatch ${cur === c ? "on" : ""}" data-c="${c}" title="${c}" style="background:${c}"></button>`).join("")}
      <label class="swatch custom ${cur && !list.includes(cur) ? "on" : ""}" title="Custom colour"><input type="color" value="${cur || def || "#ffffff"}" data-cc="${key}"></label></div>`;
  };
  const soonRow = (t, d) => `<div class="setting"><div><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ""}</div><span class="badge soon">SOON</span></div>`;
  function drawSettings() {
    const o = E.o, body = $("#setBody");
    if (!body) return;
    $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === E.tab));
    const stl = styleById(o.caption_style);
    const T = {
      captions: `
        <div class="sec"><div class="label">Caption style <span class="faint">${esc(stl.name)}</span></div>
          <div class="styles-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))" id="edStyles">${CAPTION_STYLES.map((s) => `<button type="button" class="style-tile ${s.id === o.caption_style ? "on" : ""}" data-style="${s.id}">${styleThumb(s)}<span class="nm">${s.name}</span></button>`).join("")}</div></div>
        <div class="sec"><div class="label">Size <span class="range-val" id="szOut">${o.caption_size}%</span></div><input type="range" min="50" max="160" step="5" value="${o.caption_size}" data-r="caption_size"></div>
        <div class="sec"><div class="label">Text colour</div>${swatchRow("text_color", ["#FFFFFF", "#FFE500", "#3CF0FF", "#FF5C8A", "#000000"], "#FFFFFF")}</div>
        <div class="sec"><div class="label">Highlight colour ${stl.hi ? "" : '<span class="faint">not used by this style</span>'}</div>${stl.hi ? swatchRow("highlight_color", ["#FFE500", "#88FF00", "#3CF0FF", "#B58AFF", "#FF5C8A"], stl.hi) : ""}</div>
        <div class="sec"><div class="label">Position</div><div data-seg="caption_position">${segHTML([["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]], o.caption_position, "full")}</div></div>
        <div class="sec"><div class="label">Words per line <span class="range-val" id="wplO">${o.words_per_line}</span></div><input type="range" min="1" max="8" value="${o.words_per_line}" data-r="words_per_line"></div>
        <div class="sec"><div class="setting" style="padding-top:0"><div><div class="t">Uppercase</div></div>${toggleHTML("eUpper", o.uppercase)}</div>${soonRow("Keyword highlight", "Colour the most important words")}${soonRow("Auto emoji", "Adds a matching emoji to lines")}</div>`,
      layout: `
        <div class="sec"><div class="label">Framing</div><div class="layout-cards" id="edLayout" style="grid-template-columns:repeat(2,minmax(0,1fr))">${layoutCardsHTML(o.reframe)}</div>
          <p class="tiny faint" style="margin:10px 0 0;line-height:1.5">${{
            face: "Follows the speaker's face. If it's a small facecam (streams), Clipora switches to split screen automatically.",
            split: "Facecam on top, the main view (game, screen, stage) below. Best for streams.",
            blur: "The whole frame stays visible over a blurred copy of itself. Nothing gets cut off.",
            center: "A fixed crop. Pick where with the slider below, or drag the preview.",
          }[o.reframe] || ""}</p>
          ${E.framing ? `<p class="tiny" style="margin:8px 0 0;color:${E.framing.found ? "var(--ok)" : "var(--text-3)"}">${E.framing.found ? `${ic("check", "xs")} Face found${E.framing.small ? " — small facecam" : ""}` : "No face found in this clip"}</p>` : ""}</div>
        ${["center", "split"].includes(o.reframe) ? `<div class="sec"><div class="label">${o.reframe === "split" ? "Main view position" : "Crop position"} <span class="range-val" id="cxO">${Math.round(o.crop_x * 100)}%</span></div>
          <input type="range" min="0" max="100" value="${Math.round(o.crop_x * 100)}" data-r="crop_x_pct" aria-label="Crop position">
          <div class="between tiny faint" style="margin-top:4px"><span>Left</span><span>Right</span></div>
          <p class="tiny faint" style="margin:8px 0 0">Tip: drag left or right on the preview.</p></div>` : ""}
        <div class="sec"><div class="setting" style="padding:0"><div><div class="t">Aspect ratio</div><div class="d">Set when the project was created</div></div><span class="chip">${esc(E.job.options.aspect || "9:16")}</span></div></div>
        <div class="sec">${soonRow("Zoom on emphasis", "Punch-in on loud or important moments")}</div>`,
      hook: `
        <div class="sec"><div class="setting" style="padding-top:0"><div><div class="t">Show hook title</div><div class="d">Big text in the first seconds</div></div>${toggleHTML("eHook", o.show_hook)}</div></div>
        <div class="sec"><div class="label">Hook text <span class="row" style="gap:8px"><span class="counter" id="hkC"></span><button class="ai-btn" data-ai="hook">${ic("sparkles")}Rewrite</button></span></div><input class="input" id="eHookTxt" maxlength="80" value="${esc(E.text.hook)}" placeholder="e.g. Nobody tells you this"></div>
        <div class="sec"><div class="label">Duration <span class="range-val" id="hsO">${o.hook_seconds}s</span></div><input type="range" min="0.5" max="10" step="0.5" value="${o.hook_seconds}" data-r="hook_seconds"></div>
        <div class="sec"><div class="label">Position</div><div data-seg="hook_position">${segHTML([["top", "Top"], ["center", "Center"]], o.hook_position, "full")}</div></div>`,
      brand: `
        <div class="sec"><div class="setting" style="padding-top:0"><div><div class="t">Logo watermark</div><div class="d">${App.status?.logo ? "Your brand logo on the video" : 'Upload a logo in <a href="#/settings" style="color:var(--violet)">Settings</a> first'}</div></div>${toggleHTML("eWm", o.watermark && App.status?.logo, !App.status?.logo)}</div>
          <div class="row" style="gap:14px;margin-top:6px"><div class="corner-grid" id="corners">${["top_left", "top_right", "bottom_left", "bottom_right"].map((p) => `<button type="button" data-p="${p}" class="${o.watermark_position === p ? "on" : ""}" title="${p.replace("_", " ")}" aria-label="${p.replace("_", " ")}"></button>`).join("")}</div><span class="tiny faint">Logo position</span></div></div>
        <div class="sec"><div class="setting" style="padding:0"><div><div class="t">Progress bar</div><div class="d">Thin bar along the bottom edge</div></div>${toggleHTML("eBar", o.progress_bar)}</div></div>
        <div class="sec">${soonRow("Intro / outro card", "Branded first and last second")}</div>`,
      audio: `
        <div class="sec"><div class="label">Clean-up</div>
          <div class="setting"><div><div class="t">Remove filler words</div><div class="d">${E.words.filter((w) => w.s >= E.start && w.e <= E.end && isFiller(w.w)).length} found in this clip</div></div>${toggleHTML("eFill", o.remove_fillers)}</div>
          <div class="setting"><div><div class="t">Remove silences</div><div class="d">Cuts pauses longer than ~1 second</div></div>${toggleHTML("eSil", o.remove_silences)}</div>
          <p class="tiny faint" style="margin:6px 0 0">Final length after cuts: <b class="mono" style="color:var(--text)">${fmtTC(outLen())}</b></p></div>
        <div class="sec">${soonRow("Background music", "Add a track under the voice")}${soonRow("Auto-ducking", "Lowers music while someone speaks")}</div>`,
      text: `
        <div class="sec"><div class="label">Title <span class="row" style="gap:8px"><span class="counter" id="tiC"></span><button class="ai-btn" data-ai="title">${ic("sparkles")}Rewrite</button></span></div><input class="input" id="eTitle" maxlength="100" value="${esc(E.text.title)}"></div>
        <div class="sec"><div class="label">Description <span class="row" style="gap:8px"><span class="counter" id="deC"></span><button class="ai-btn" data-ai="description">${ic("sparkles")}Rewrite</button></span></div><textarea class="textarea" id="eDesc" maxlength="2200">${esc(E.text.description)}</textarea></div>
        <div class="sec"><div class="label">Hashtags <button class="ai-btn" data-ai="hashtags">${ic("sparkles")}Suggest</button></div><div class="tags-input" id="eTags"></div></div>
        ${E.clip.reason ? `<div class="sec"><div class="note">${ic("sparkles")}<span><b>Why the AI picked it:</b> ${esc(E.clip.reason)}</span></div></div>` : ""}`,
    };
    body.innerHTML = T[E.tab];
    $$("input[type=range]", body).forEach((r) => {
      bindRange(r, (val) => {
        const k = r.dataset.r; if (!r._c) { commit(); r._c = true; }
        if (k === "crop_x_pct") { E.o.crop_x = val / 100; $("#cxO").textContent = val + "%"; E.need = true; return changed(false); }
        E.o[k] = val;
        if (k === "caption_size") $("#szOut").textContent = val + "%";
        if (k === "words_per_line") $("#wplO").textContent = val;
        if (k === "hook_seconds") $("#hsO").textContent = val + "s";
        changed(false);
      });
      r.addEventListener("change", () => (r._c = false));
    });
    const tg = (id, k, after) => { const el = $("#" + id, body); if (el) bindToggle(el, (x) => { commit(); E.o[k] = x; changed(true); after && after(); }); };
    tg("eUpper", "uppercase"); tg("eHook", "show_hook"); tg("eWm", "watermark"); tg("eBar", "progress_bar");
    tg("eFill", "remove_fillers", () => drawSettings()); tg("eSil", "remove_silences", () => drawSettings());
    $$("[data-seg]", body).forEach((w) => segBind($(".seg", w), (x) => { commit(); E.o[w.dataset.seg] = x; changed(false); }));
    const textIn = (id, key, max, cid) => {
      const el = $("#" + id, body); if (!el) return;
      const count = () => { const c = $("#" + cid, body); if (c) { c.textContent = `${el.value.length}/${max}`; c.classList.toggle("over", el.value.length > max); } };
      el.addEventListener("focus", commit);
      el.addEventListener("input", () => { E.text[key] = el.value; count(); changed(false); if (key === "title") $("#edTitle").textContent = el.value || "Untitled clip"; });
      count();
    };
    textIn("eHookTxt", "hook", 80, "hkC"); textIn("eTitle", "title", 100, "tiC"); textIn("eDesc", "description", 2200, "deC");
    if ($("#eTags", body)) drawTags();
    body.onclick = async (e) => {
      const st = e.target.closest("[data-style]");
      if (st) { commit(); E.o.caption_style = st.dataset.style; E.o.highlight_color = ""; changed(false); drawSettings(); return; }
      const lc = e.target.closest("#edLayout .layout-card");
      if (lc && !lc.disabled) { commit(); E.o.reframe = lc.dataset.v; changed(true); drawSettings(); return; }
      const sw = e.target.closest(".swatch[data-c]");
      if (sw) { const k = sw.closest("[data-sw]").dataset.sw; commit(); E.o[k] = sw.dataset.c; changed(false); drawSettings(); return; }
      const cp = e.target.closest("#corners [data-p]");
      if (cp) { commit(); E.o.watermark_position = cp.dataset.p; changed(false); drawSettings(); return; }
      const ai = e.target.closest("[data-ai]");
      if (ai) aiRewrite(ai);
    };
    body.oninput = (e) => {
      const cc = e.target.closest("[data-cc]");
      if (cc) { E.o[cc.dataset.cc] = cc.value.toUpperCase(); changed(false); }
    };
    body.onchange = (e) => { if (e.target.closest("[data-cc]")) { commit(); drawSettings(); } };
  }
  function drawTags() {
    const box = $("#eTags");
    box.innerHTML = E.text.hashtags.map((t, i) => `<span class="tag">${esc(t)}<button type="button" data-ti="${i}" aria-label="Remove ${esc(t)}">${ic("x", "xs")}</button></span>`).join("") + `<input id="tagIn" placeholder="${E.text.hashtags.length ? "" : "#shorts #podcast"}" aria-label="Add hashtag">`;
    const inp = $("#tagIn");
    const add = () => {
      const parts = inp.value.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : "#" + t).slice(0, 40));
      if (!parts.length) return;
      commit(); E.text.hashtags = [...new Set([...E.text.hashtags, ...parts])].slice(0, 10); changed(false); drawTags(); $("#tagIn").focus();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === " ") { e.preventDefault(); add(); }
      if (e.key === "Backspace" && !inp.value && E.text.hashtags.length) { commit(); E.text.hashtags.pop(); changed(false); drawTags(); $("#tagIn").focus(); }
    });
    inp.addEventListener("blur", add);
    box.onclick = (e) => { const b = e.target.closest("[data-ti]"); if (b) { commit(); E.text.hashtags.splice(+b.dataset.ti, 1); changed(false); drawTags(); } else inp.focus(); };
  }
  async function aiRewrite(btn) {
    const field = btn.dataset.ai;
    const ws = E.words.filter((w) => w.s >= E.start && w.e <= E.end).map((w) => w.w).join(" ");
    btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = `<span class="spinner" style="width:11px;height:11px;border-width:1.5px"></span>Thinking`;
    try {
      const r = await postJSON("/api/ai/rewrite", { field, transcript: ws, current: field === "hashtags" ? E.text.hashtags.join(" ") : E.text[field] });
      commit();
      if (field === "hashtags") E.text.hashtags = r.result; else E.text[field] = r.result;
      if (field === "title") $("#edTitle").textContent = r.result;
      changed(false); drawSettings(); toast("AI suggestion added — Ctrl+Z to undo", "info");
    } catch (e) { toast(e.message, "err", 5000); btn.disabled = false; btn.innerHTML = old; }
  }

  /* ---------------- change propagation ---------------- */
  function changed(redrawTx) {
    if (E.end - E.start < 3) E.end = E.start + 3;
    computeCuts();
    loadFraming();  // debounced; only refetches when the clip range really moved
    $("#edTitle").textContent = E.text.title || "Untitled clip";
    $("#inT").value = fmtTC(E.start); $("#outT").value = fmtTC(E.end);
    const len = outLen(), raw = E.end - E.start;
    $("#lenChip").innerHTML = `${ic("clock")}${fmtTC(len)}${Math.abs(raw - len) > 0.05 ? `<span class="faint">&nbsp;(−${(raw - len).toFixed(1)}s cut)</span>` : ""}`;
    $("#lenChip").style.color = len > 180 ? "var(--warn)" : "";
    $("#lenChip").title = len > 180 ? "YouTube Shorts allow up to 3 minutes" : "";
    const d = dirty(), needR = visSnap() !== E.renderedVis;
    $("#edState").innerHTML = E.busy ? `<span class="badge live"><span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>Rendering</span>`
      : d ? `<span class="dirty">Unsaved changes</span>` : needR ? `<span class="badge warn">Saved · not rendered</span>` : `<span class="badge ok">${ic("check")}Up to date</span>`;
    $("#saveBtn").disabled = !d || E.busy;
    $("#renderBtn").disabled = E.busy;
    $("#discardBtn").classList.toggle("hidden", !d);
    $("#undoBtn").disabled = !E.hist.length;
    if (redrawTx) paintWords(); else paintWords();
    drawTimeline(); drawStage(); E.need = true;
    if (E.tab === "audio" && redrawTx) { /* lengths shown in the audio tab */ }
  }

  /* ---------------- save / render ---------------- */
  function body(render) {
    const b = { start: +E.start.toFixed(2), end: +E.end.toFixed(2), cuts: E.cuts, render, ...E.text };
    OVERRIDE_KEYS.forEach((k) => (b[k] = E.o[k]));
    return b;
  }
  async function save(render) {
    if (E.busy) return;
    if (outLen() < 3) return toast("A clip must be at least 3 seconds long", "err");
    try {
      const job = await postJSON(`/api/jobs/${E.job.id}/clips/${E.clip.index}`, body(render));
      E.job = job; E.clip = job.clips.find((x) => x.index === index);
      E.saved = snapshot();
      if (render) { E.busy = true; watchRender(); toast("Re-rendering — this takes about a minute", "info"); }
      else toast("Saved");
      changed(false);
    } catch (e) { toast(e.message, "err", 5000); }
  }
  let renderTimer = 0;
  function watchRender() {
    E.busy = true; $("#scrBusy").classList.remove("hidden"); $("#busyTxt").textContent = "Rendering your clip…";
    changed(false);
    const tick = async () => {
      try {
        const job = await api(`/api/jobs/${E.job.id}`);
        const c = job.clips.find((x) => x.index === index);
        if (!c) return;
        if (c.status === "done" || c.status === "error") {
          E.busy = false; $("#scrBusy").classList.add("hidden");
          E.job = job;
          if (c.status === "done") {
            E.clip = { ...c }; rvid.src = c.url; if (!E.job.source_url && c.section && (!E.sec || c.section[2] !== E.sec[2] || c.section[0] !== E.sec[0])) { E.sec = c.section; E.off = c.section[0]; E.srcOK = true; src.src = `/media/${E.job.id}/${c.section[2]}`; } $("#edVer").textContent = `v${c.version}`;
            E.renderedVis = visSnap(); E.rendered = { start: E.start, cuts: E.allCuts.map((x) => [...x]) };
            toast(`Clip ${index} rendered (v${c.version})`); setMode("rendered");
          } else { E.clip.status = "error"; toast("Render failed: " + (c.error || "").slice(0, 160), "err", 8000); }
          changed(false); return;
        }
        $("#busyTxt").textContent = c.status === "queued" ? "Waiting in queue…" : "Rendering your clip…";
      } catch { }
      renderTimer = setTimeout(tick, 2000);
    };
    renderTimer = setTimeout(tick, 1500);
  }
  S.add(() => clearTimeout(renderTimer));

  /* ---------------- events ---------------- */
  function bindUI() {
    segBind($("#modeSeg .seg"), setMode);
    segBind($("#mtabs .seg"), (m) => { $(".ed").dataset.m = m; if (m === "preview") { sizeCanvas(); drawTimeline(); } });
    $("#tabs").onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; E.tab = b.dataset.t; store.set("ed-tab", E.tab); drawSettings(); };
    $("#playBtn").onclick = () => setPlaying(!E.playing);
    $("#toStart").onclick = () => seek(E.start);
    $("#back5").onclick = () => seek(Math.max(E.start, curT() - 5));
    $("#fwd5").onclick = () => seek(Math.min(E.end - 0.1, curT() + 5));
    $("#loopBtn").onclick = () => { E.loop = !E.loop; $("#loopBtn").classList.toggle("on", E.loop); };
    $("#muteBtn").onclick = () => { src.muted = rvid.muted = !src.muted; $("#muteBtn").innerHTML = ic(src.muted ? "mute" : "vol", "sm"); };
    $("#saveBtn").onclick = () => save(false);
    $("#renderBtn").onclick = () => save(true);
    $("#undoBtn").onclick = undo;
    $("#discardBtn").onclick = async () => {
      if (!(await confirmBox({ title: "Discard changes?", text: "Your unsaved edits to this clip will be lost.", ok: "Discard", danger: true }))) return;
      restore(E.saved); E.hist = []; changed(true);
    };
    App.guard = async () => !dirty() || confirmBox({ title: "Leave without saving?", text: "You have unsaved changes to this clip.", ok: "Leave", danger: true });
    S.add(() => { App.guard = null; Editor.isDirty = () => false; });

    // in/out fields
    const setIn = (t) => { commit(); E.start = clamp(t, 0, E.end - 3); changed(true); };
    const setOut = (t) => { commit(); E.end = clamp(t, E.start + 3, E.job.duration || t); changed(true); };
    $("#inT").addEventListener("change", (e) => { const t = parseTC(e.target.value); if (isFinite(t)) setIn(t); else changed(false); });
    $("#outT").addEventListener("change", (e) => { const t = parseTC(e.target.value); if (isFinite(t)) setOut(t); else changed(false); });
    $(".tl-bar").addEventListener("click", (e) => {
      const n = e.target.closest("[data-n]"); if (!n) return;
      const [w, d] = n.dataset.n.split(":");
      if (w === "s") setIn(E.start + +d); else setOut(E.end + +d);
    });
    $("#setIn").onclick = () => setIn(curT());
    $("#setOut").onclick = () => setOut(curT());
    $("#zIn").onclick = () => { E.zoom = Math.min(8, E.zoom * 1.6); fitWindow(); drawTimeline(); };
    $("#zOut").onclick = () => { E.zoom = Math.max(0.05, E.zoom / 1.6); fitWindow(); drawTimeline(); };
    $("#zFit").onclick = () => { E.zoom = 1; fitWindow(); drawTimeline(); };

    // timeline drag
    const tlc = $("#tlc");
    let drag = null;
    tlc.addEventListener("pointerdown", (e) => {
      const r = tlc.getBoundingClientRect(), x = e.clientX - r.left;
      const h = e.target.closest(".tl-h");
      drag = h ? (h.id === "hIn" ? "in" : "out") : "seek";
      if (drag !== "seek") commit();
      tlc.setPointerCapture(e.pointerId);
      if (drag === "seek") seek(tlT(x));
    });
    tlc.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = tlc.getBoundingClientRect(), x = clamp(e.clientX - r.left, 0, r.width);
      let t = tlT(x);
      if (drag === "seek") return seek(t);
      if (!e.altKey) t = snapWord(t, drag === "in" ? "s" : "e");
      if (drag === "in") E.start = clamp(t, 0, E.end - 3); else E.end = clamp(t, E.start + 3, E.job.duration || t);
      changed(false);
      seek(drag === "in" ? E.start : Math.max(E.start, E.end - 1.5));
    });
    // drag on the preview to move the crop (fixed crop / split screen)
    let pan = null;
    screenEl.addEventListener("pointerdown", (e) => {
      if (E.mode !== "live" || !["center", "split"].includes(E.o.reframe)) return;
      commit(); pan = { x: e.clientX, v: E.o.crop_x, w: screenEl.clientWidth }; screenEl.setPointerCapture(e.pointerId);
    });
    screenEl.addEventListener("pointermove", (e) => {
      if (!pan) return;
      E.o.crop_x = clamp(pan.v - (e.clientX - pan.x) / pan.w * 0.6, 0, 1); E.need = true;
      const r = $('#setBody [data-r="crop_x_pct"]'); if (r) { r.value = Math.round(E.o.crop_x * 100); paintRange(r); $("#cxO").textContent = r.value + "%"; }
    });
    const endPan = () => { if (pan) { pan = null; changed(false); } };
    screenEl.addEventListener("pointerup", endPan); screenEl.addEventListener("pointercancel", endPan);

    const endDrag = () => { if (drag && drag !== "seek") { changed(true); loadFraming(); if (E.start < E.win[0] || E.end > E.win[1]) fitWindow(); } drag = null; };
    tlc.addEventListener("pointerup", endDrag); tlc.addEventListener("pointercancel", endDrag);
    tlc.addEventListener("wheel", (e) => { if (!e.ctrlKey && Math.abs(e.deltaY) < Math.abs(e.deltaX)) return; e.preventDefault(); E.zoom = clamp(E.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.05, 8); fitWindow(); drawTimeline(); }, { passive: false });

    // transcript
    const tx = $("#tx");
    let dragSel = false;
    tx.addEventListener("pointerdown", (e) => {
      const ts = e.target.closest(".ts"); if (ts) { seek(+ts.dataset.t); return; }
      const w = e.target.closest(".w"); if (!w) return;
      const i = +w.dataset.i;
      if (e.shiftKey && E.anchor != null) E.sel = [E.anchor, i];
      else { E.anchor = i; E.sel = null; dragSel = true; seek(E.words[i].s); }
      paintWords(); drawSelBar();
    });
    tx.addEventListener("pointerover", (e) => {
      if (!dragSel) return; const w = e.target.closest(".w"); if (!w) return;
      const i = +w.dataset.i; if (i !== E.anchor) { E.sel = [E.anchor, i]; paintWords(); drawSelBar(); }
    });
    const stopSel = () => { dragSel = false; };
    document.addEventListener("pointerup", stopSel); S.add(() => document.removeEventListener("pointerup", stopSel));
    $("#selBar").addEventListener("click", (e) => {
      const a = e.target.closest("[data-sa]")?.dataset.sa; if (!a || !E.sel) return;
      const w0 = E.words[Math.min(...E.sel)], w1 = E.words[Math.max(...E.sel)];
      if (a === "clip") {
        if (w1.e - w0.s < 3) return toast("Select at least 3 seconds of speech", "info");
        commit(); E.start = Math.max(0, w0.s - 0.1); E.end = w1.e + 0.3; E.sel = null; fitWindow(); changed(true); seek(E.start);
      }
      if (a === "cut") { commit(); E.cuts = [...E.cuts, [w0.s, w1.e]]; E.sel = null; changed(true); }
      if (a === "restore") { commit(); E.cuts = E.cuts.filter(([x, y]) => !(x < w1.e && y > w0.s)); E.sel = null; changed(true); }
      if (a === "clear") { E.sel = null; paintWords(); }
      drawSelBar();
    });
    $("#txq").addEventListener("input", () => drawTranscript());

    // keyboard
    const key = (e) => {
      const typing = e.target.closest("input, textarea, select, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(false); return; }
      if (mod && e.key === "Enter") { e.preventDefault(); save(true); return; }
      if (typing || layers.length) return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (e.key === " ") { e.preventDefault(); setPlaying(!E.playing); }
      else if (e.key.toLowerCase() === "i") $("#setIn").click();
      else if (e.key.toLowerCase() === "o") $("#setOut").click();
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(curT() - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(curT() + (e.shiftKey ? 5 : 1)); }
      else if ((e.key === "Delete" || e.key === "Backspace") && E.sel) { $('[data-sa="cut"]')?.click(); }
      else if (e.key === "Escape" && E.sel) { E.sel = null; paintWords(); drawSelBar(); }
    };
    document.addEventListener("keydown", key); S.add(() => document.removeEventListener("keydown", key));
    S.on(bus, "theme", drawTimeline);
  }

  return () => S.done();
};
