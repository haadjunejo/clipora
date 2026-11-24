/* Clipora pages: home, projects, project, calendar, connections, analytics, settings. */
"use strict";

/* tiny lifecycle helper: everything registered here is undone when the page changes */
function scope() {
  const fns = [];
  return {
    on(t, ev, fn, o) { t.addEventListener(ev, fn, o); fns.push(() => t.removeEventListener(ev, fn, o)); },
    every(ms, fn) { const id = setInterval(fn, ms); fns.push(() => clearInterval(id)); },
    add(fn) { fns.push(fn); },
    done() { fns.splice(0).forEach((f) => { try { f(); } catch (e) { console.error(e); } }); },
  };
}
const defaults = () => ({ ...(App.status?.defaults || {}), ...(App.status?.settings?.defaults || {}) });
const statusBadge = (j) => {
  if (j.status === "done") return `<span class="badge ok">${ic("check")}Ready</span>`;
  if (j.status === "error") return `<span class="badge err">${ic("alert")}Failed</span>`;
  if (j.status === "running") return `<span class="badge live"><i class="dot live" style="width:6px;height:6px"></i>${Math.round((j.progress || 0) * 100)}%</span>`;
  return `<span class="badge">${ic("clock")}Queued</span>`;
};
function projectCard(j) {
  const busy = j.status === "running" || j.status === "queued";
  return `<article class="card proj" data-id="${esc(j.id)}" tabindex="0">
    <div class="th">${j.thumb ? `<img src="/media/${esc(j.id)}/thumb.jpg" alt="" loading="lazy">` : `<div class="ph">${ic("film", "lg")}</div>`}
      <span class="tl">${statusBadge(j)}</span>${j.duration ? `<span class="dur">${fmtDur(j.duration)}</span>` : ""}
      ${busy ? `<div class="prog"><span style="width:${Math.round((j.progress || 0) * 100)}%"></span></div>` : ""}</div>
    <div class="info"><div class="ttl">${esc(j.title)}</div>
      <div class="meta"><span>${ic("film")}${j.clips_done || 0} clips</span>${j.top_score ? `<span>${ic("flame")}${j.top_score}</span>` : ""}<span style="margin-left:auto">${ago(j.created)}</span></div></div>
  </article>`;
}
function bindProjectCards(root) {
  root.addEventListener("click", (e) => { const c = e.target.closest(".proj"); if (c) location.hash = `#/p/${c.dataset.id}`; });
  root.addEventListener("keydown", (e) => { const c = e.target.closest(".proj"); if (c && e.key === "Enter") location.hash = `#/p/${c.dataset.id}`; });
}

/* ======================= upload ======================= */
const CHUNK = 50 * 1024 * 1024; // public tunnel allows ~100 MB per request → send 50 MB pieces
function sendXHR(url, fd, onProgress, ctl) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (ctl) ctl.xhr = xhr;
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded); };
    xhr.onloadend = () => {
      if (ctl && ctl.cancelled) return reject(new Error("Upload cancelled"));
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { }
      if (xhr.status === 401) { bus.dispatchEvent(new Event("auth")); return reject(new Error("Please log in")); }
      if (xhr.status !== 200) return reject(new Error(data.error || (xhr.status ? `Error ${xhr.status}` : "Connection lost")));
      resolve(data);
    };
    xhr.open("POST", url); xhr.send(fd);
  });
}
async function uploadInPieces(file, onProgress, ctl) {
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const total = Math.max(1, Math.ceil(file.size / CHUNK));
  for (let i = 0; i < total; i++) {
    const fd = new FormData();
    fd.append("index", i);
    if (i === 0) fd.append("size", file.size);
    fd.append("chunk", file.slice(i * CHUNK, (i + 1) * CHUNK), "chunk");
    for (let attempt = 0; ; attempt++) {
      if (ctl.cancelled) throw new Error("Upload cancelled");
      try { await sendXHR(`/api/uploads/${id}`, fd, (loaded) => onProgress(i * CHUNK + loaded), ctl); break; }
      catch (err) {
        if (ctl.cancelled || attempt >= 2 || /log in|too big|cancel/i.test(err.message)) throw err;
        await sleep(2000);
      }
    }
  }
  return id;
}

/* ======================= HOME ======================= */
const Pages = {};
Pages.home = function () {
  setActiveNav("home"); setCrumbs([{ label: "Home", href: "#/" }]);
  const S = scope();
  const d = defaults();
  const st = {
    mode: store.get("src-mode", "link"), file: null, uploading: false,
    o: { ...d },
  };
  const LENGTHS = [
    { id: "short", label: "15–35s", min: 15, max: 35 }, { id: "medium", label: "30–60s", min: 30, max: 60 },
    { id: "long", label: "60–90s", min: 60, max: 90 }, { id: "def", label: `${d.min_sec}–${d.max_sec}s`, min: d.min_sec, max: d.max_sec },
  ];
  const lenId = () => (LENGTHS.find((l) => l.min === st.o.min_sec && l.max === st.o.max_sec) || { id: "custom" }).id;
  const v = $("#view");
  v.innerHTML = `
  <div class="home-grid">
    <div class="grow">
      <section class="hero">
        <span class="hero-badge"><span>NEW</span>${ic("sparkles", "xs")}AI picks, reframes & captions for you</span>
        <h1>Turn long videos into<br><span class="grad-text">moments worth watching.</span></h1>
        <p class="sub">Your AI-powered content studio. Create, edit, and publish short-form videos effortlessly.</p>
        <div class="source">
          ${segHTML([["link", "Video link", "link"], ["file", "Upload video", "upload"]], st.mode)}
          <div id="srcLink" class="${st.mode === "link" ? "" : "hidden"}">
            <div class="url-box">${ic("link")}<input id="urlInput" type="url" inputmode="url" placeholder="Paste a YouTube or any video link…" autocomplete="off"><span id="srcChip"></span>
              <button class="btn primary" id="goTop">${ic("sparkles", "sm")}<span>Get clips</span></button></div>
          </div>
          <div id="srcFile" class="${st.mode === "file" ? "" : "hidden"}"></div>
        </div>
        <div class="quick">
          <div class="opt-card"><div class="label">Number of clips</div>
            <div class="row" style="margin-top:12px;gap:14px"><div class="big-num" id="nOut"></div></div>
            <input type="range" min="0" max="100" value="${st.o.num_clips}" id="nClips" aria-label="Number of clips (0 = Auto)" style="margin-top:10px">
            <div class="between tiny faint" style="margin-top:4px"><span>Auto</span><span>100</span></div></div>
          <div class="opt-card"><div class="label">Clip length</div>
            <div class="len-chips" id="lenChips" style="margin-top:12px">${LENGTHS.map((l) => `<button type="button" data-v="${l.id}">${l.label}</button>`).join("")}<button type="button" data-v="custom">Custom</button></div>
            <div class="row" id="lenCustom" style="margin-top:10px">
              <input class="input" type="number" id="minSec" min="5" max="180" value="${st.o.min_sec}" aria-label="Minimum seconds" style="min-height:34px"><span class="faint">to</span>
              <input class="input" type="number" id="maxSec" min="10" max="300" value="${st.o.max_sec}" aria-label="Maximum seconds" style="min-height:34px"><span class="faint small">sec</span></div></div>
          <div class="opt-card"><div class="label">Caption style <span class="faint" id="styleName"></span></div>
            <div class="styles-grid" id="styleGrid" style="margin-top:12px">${CAPTION_STYLES.map((s) => `<button type="button" class="style-tile" data-v="${s.id}" title="${s.name}">${styleThumb(s)}<span class="nm">${s.name}</span></button>`).join("")}</div></div>
        </div>
        <button type="button" class="adv-toggle" id="advBtn">${ic("settings", "sm")}Layout & advanced options ${ic("down", "sm")}</button>
        <div class="adv hidden" id="adv">
          <div class="opt-card span2"><div class="label">Video layout</div><div class="layout-cards" id="layoutCards" style="margin-top:12px">${layoutCardsHTML(st.o.reframe)}</div></div>
          <div class="opt-card"><div class="label">Aspect ratio</div><div style="margin-top:12px" id="aspectSeg">${segHTML([["9:16", "9:16"], ["1:1", "1:1"], ["16:9", "16:9"]], st.o.aspect, "full")}</div>
            <div class="field" style="margin-top:12px"><div class="label">Long video mode <span class="faint">for streams</span></div><div id="longSeg">${segHTML([["auto", "Auto"], ["on", "On"], ["off", "Off"]], st.o.long_mode || "auto", "full")}</div>
              <span class="tiny faint">Auto turns it on for videos over 90 min: audio-only download, fast transcription on both GPUs, then only the clip sections are downloaded.</span></div>
            <div class="field" style="margin-top:12px"><label class="label" for="lang">Spoken language</label><select class="select" id="lang"><option value="">Auto-detect</option>${Object.entries(LANGS).map(([k, n]) => `<option value="${k}" ${st.o.language === k ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
          <div class="opt-card"><div class="label">Captions</div>
            <div class="setting"><div><div class="t">Uppercase</div></div>${toggleHTML("tUpper", st.o.uppercase)}</div>
            <div class="setting"><div class="grow"><div class="t">Words per line</div><div class="range-row" style="margin-top:6px"><input type="range" min="1" max="8" value="${st.o.words_per_line}" id="wpl"><span class="range-val" id="wplOut">${st.o.words_per_line}</span></div></div></div></div>
          <div class="opt-card"><div class="label">Hook title</div>
            <div class="setting"><div><div class="t">Show hook at start</div><div class="d">Big title in the first seconds</div></div>${toggleHTML("tHook", st.o.show_hook)}</div>
            <div class="setting"><div class="grow"><div class="t">Duration</div><div class="range-row" style="margin-top:6px"><input type="range" min="1" max="8" step="0.5" value="${st.o.hook_seconds}" id="hookSec"><span class="range-val" id="hookOut">${st.o.hook_seconds}s</span></div></div></div></div>
          <div class="opt-card"><div class="label">Clean-up & brand</div>
            <div class="setting"><div><div class="t">Remove filler words</div><div class="d">“um”, “uh”, “erm”…</div></div>${toggleHTML("tFill", st.o.remove_fillers)}</div>
            <div class="setting"><div><div class="t">Remove silences</div><div class="d">Cuts pauses longer than ~1s</div></div>${toggleHTML("tSil", st.o.remove_silences)}</div>
            <div class="setting"><div><div class="t">Progress bar</div></div>${toggleHTML("tBar", st.o.progress_bar)}</div>
            <div class="setting"><div><div class="t">Logo watermark</div><div class="d" id="wmHint"></div></div>${toggleHTML("tWm", st.o.watermark && App.status?.logo, !App.status?.logo)}</div></div>
          <div class="opt-card span2"><div class="label">AI direction <span class="faint">optional</span></div>
            <textarea class="textarea" id="aiPrompt" maxlength="500" placeholder="e.g. Find the funniest moments, or anything about money and business…" style="margin-top:10px">${esc(st.o.ai_prompt || "")}</textarea></div>
        </div>
        <div class="go-row">
          <button class="btn primary lg" id="goBtn">${ic("sparkles", "sm")}Generate clips</button>
          <span class="faint small" id="goHint">Runs in the background, so you can close this tab.</span>
          <span class="form-err" id="formErr" role="alert"></span>
        </div>
      </section>
      <div class="section-head"><div><h2>Recent projects</h2><p>Pick up where you left off</p></div><a class="btn ghost sm" href="#/projects">View all ${ic("right", "sm")}</a></div>
      <div class="proj-grid" id="recent"></div>
    </div>
    <aside class="side-panel" id="sidePanel"></aside>
  </div>`;

  /* --- source --- */
  segBind($(".source .seg", v), (m) => {
    st.mode = m; store.set("src-mode", m);
    $("#srcLink").classList.toggle("hidden", m !== "link");
    $("#srcFile").classList.toggle("hidden", m !== "file");
    if (m === "link") $("#urlInput").focus();
  });
  const urlIn = $("#urlInput");
  const detect = () => {
    const u = urlIn.value.trim();
    let chip = "";
    if (/youtu\.?be/i.test(u)) chip = `${ic("yt", "xs")}YouTube`;
    else if (/instagram\.com/i.test(u)) chip = `${ic("ig", "xs")}Instagram`;
    else if (/tiktok\.com/i.test(u)) chip = `${ic("tt", "xs")}TikTok`;
    else if (/facebook\.com|fb\.watch/i.test(u)) chip = `${ic("fb", "xs")}Facebook`;
    else if (/^https?:\/\/\S+\.\S+/.test(u)) chip = `${ic("globe", "xs")}Link`;
    $("#srcChip").innerHTML = chip ? `<span class="src-chip">${chip}</span>` : "";
  };
  S.on(urlIn, "input", detect);
  S.on(urlIn, "keydown", (e) => { if (e.key === "Enter") submit(); });

  function drawFile() {
    const box = $("#srcFile");
    if (!st.file) {
      box.innerHTML = `<label class="drop" id="drop"><input type="file" accept="video/*,.mkv,.mov,.webm" class="sr" id="fileIn">
        <span class="ico">${ic("upload", "lg")}</span><strong>Drop your video here or <u>browse files</u></strong>
        <span class="faint small">MP4, MOV, MKV or WEBM · big files are fine. For long streams, pasting the link is much faster</span></label>`;
      const drop = $("#drop"), fin = $("#fileIn");
      fin.addEventListener("change", () => { if (fin.files[0]) { st.file = fin.files[0]; drawFile(); } });
      ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
      drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) { st.file = f; drawFile(); } });
      return;
    }
    const f = st.file;
    box.innerHTML = `<div class="file-card"><span class="fi">${ic("film", "lg")}</span>
      <div class="grow"><div class="name">${esc(f.name)}</div>
        <div class="between tiny faint" style="margin-top:4px"><span id="upInfo">${fmtBytes(f.size)} · ready to upload</span><span id="upPct" class="num"></span></div>
        <div class="progress hidden" id="upBar"><span style="width:0"></span></div></div>
      <button class="icon-btn sm" id="fileX" aria-label="Remove file">${ic("x", "sm")}</button></div>`;
    $("#fileX").onclick = () => {
      if (st.uploading) { st.ctl.cancelled = true; st.ctl.xhr && st.ctl.xhr.abort(); return; }
      st.file = null; drawFile();
    };
  }
  drawFile();

  /* --- options --- */
  const nClips = $("#nClips");
  const drawN = (n) => { $("#nOut").innerHTML = n ? `${n}<small>${n === 1 ? "clip" : "clips"}</small>` : `Auto<small>≈ 1 per 4 min</small>`; };
  bindRange(nClips, (n) => { st.o.num_clips = n; drawN(n); });
  drawN(st.o.num_clips);
  const drawLen = () => {
    const id = lenId();
    $$("#lenChips button").forEach((b) => b.classList.toggle("on", b.dataset.v === id));
    $("#lenCustom").classList.toggle("hidden", id !== "custom");
  };
  $("#lenChips").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const l = LENGTHS.find((x) => x.id === b.dataset.v);
    if (l) { st.o.min_sec = l.min; st.o.max_sec = l.max; $("#minSec").value = l.min; $("#maxSec").value = l.max; drawLen(); }
    else { $$("#lenChips button").forEach((x) => x.classList.toggle("on", x === b)); $("#lenCustom").classList.remove("hidden"); $("#minSec").focus(); }
  });
  $("#minSec").oninput = () => { st.o.min_sec = +$("#minSec").value; };
  $("#maxSec").oninput = () => { st.o.max_sec = +$("#maxSec").value; };
  drawLen();
  const drawStyle = () => {
    $$("#styleGrid .style-tile").forEach((b) => b.classList.toggle("on", b.dataset.v === st.o.caption_style));
    $("#styleName").textContent = styleById(st.o.caption_style).name;
  };
  $("#styleGrid").addEventListener("click", (e) => { const b = e.target.closest(".style-tile"); if (b) { st.o.caption_style = b.dataset.v; drawStyle(); } });
  drawStyle();
  $("#advBtn").onclick = () => { $("#adv").classList.toggle("hidden"); $("#advBtn").classList.toggle("open"); };
  $("#layoutCards").addEventListener("click", (e) => {
    const b = e.target.closest(".layout-card"); if (!b || b.disabled) return;
    st.o.reframe = b.dataset.v; $$("#layoutCards .layout-card").forEach((x) => x.classList.toggle("on", x === b));
  });
  segBind($("#aspectSeg .seg"), (a) => { st.o.aspect = a; });
  segBind($("#longSeg .seg"), (x) => { st.o.long_mode = x; });
  $("#lang").onchange = (e) => { st.o.language = e.target.value || null; };
  bindToggle($("#tUpper"), (x) => (st.o.uppercase = x));
  bindToggle($("#tHook"), (x) => (st.o.show_hook = x));
  bindToggle($("#tFill"), (x) => (st.o.remove_fillers = x));
  bindToggle($("#tSil"), (x) => (st.o.remove_silences = x));
  bindToggle($("#tBar"), (x) => (st.o.progress_bar = x));
  bindToggle($("#tWm"), (x) => (st.o.watermark = x));
  $("#wmHint").innerHTML = App.status?.logo ? "Uses your brand logo" : `<a href="#/settings" style="color:var(--violet)">Upload a logo</a> first`;
  bindRange($("#wpl"), (n) => { st.o.words_per_line = n; $("#wplOut").textContent = n; });
  bindRange($("#hookSec"), (n) => { st.o.hook_seconds = n; $("#hookOut").textContent = n + "s"; });
  $("#aiPrompt").oninput = (e) => { st.o.ai_prompt = e.target.value; };

  /* --- submit --- */
  async function submit() {
    const err = $("#formErr"); err.textContent = "";
    if (st.uploading) return;
    if (!(st.o.max_sec >= st.o.min_sec + 5)) { err.textContent = "Max length must be at least 5 seconds more than min."; return; }
    const fd = new FormData();
    fd.append("options", JSON.stringify(st.o));
    const goBtn = $("#goBtn"), goTop = $("#goTop");
    if (st.mode === "link") {
      const url = urlIn.value.trim();
      if (!/^https?:\/\/\S+/.test(url)) { err.textContent = "Paste a full link starting with https://"; urlIn.focus(); return; }
      fd.append("url", url);
      goBtn.disabled = goTop.disabled = true;
      try {
        const job = await sendXHR("/api/jobs", fd);
        refreshJobs(); location.hash = `#/p/${job.id}`;
      } catch (e) { err.textContent = e.message; }
      finally { goBtn.disabled = goTop.disabled = false; }
      return;
    }
    if (!st.file) { err.textContent = "Choose a video file first."; return; }
    const f = st.file, t0 = performance.now();
    st.uploading = true; st.ctl = { cancelled: false };
    App.guard = () => confirmBox({ title: "Cancel the upload?", text: "Leaving this page stops the upload.", ok: "Stop upload", danger: true })
      .then((ok) => { if (ok) { st.ctl.cancelled = true; st.ctl.xhr && st.ctl.xhr.abort(); } return ok; });
    goBtn.disabled = true; $("#upBar").classList.remove("hidden");
    $("#fileX").title = "Cancel upload";
    try {
      const id = await uploadInPieces(f, (sent) => {
        const p = sent / f.size, secs = (performance.now() - t0) / 1000, speed = sent / Math.max(secs, .1);
        $("#upBar span").style.width = (p * 100).toFixed(1) + "%";
        $("#upPct").textContent = Math.floor(p * 100) + "%";
        $("#upInfo").textContent = `${fmtBytes(sent)} of ${fmtBytes(f.size)} · ${fmtBytes(speed)}/s · ${fmtDur((f.size - sent) / Math.max(speed, 1))} left`;
        goBtn.innerHTML = `${ic("upload", "sm")}Uploading ${Math.floor(p * 100)}%`;
      }, st.ctl);
      fd.append("upload_id", id); fd.append("upload_name", f.name);
      $("#upInfo").textContent = "Upload complete — starting…";
      const job = await sendXHR("/api/jobs", fd);
      App.guard = null; st.uploading = false;
      refreshJobs(); location.hash = `#/p/${job.id}`;
    } catch (e) {
      err.textContent = e.message;
      if ($("#upInfo")) $("#upInfo").textContent = `${fmtBytes(f.size)} · ${e.message}`;
    } finally {
      st.uploading = false; App.guard = null;
      if (goBtn.isConnected) { goBtn.disabled = false; goBtn.innerHTML = `${ic("sparkles", "sm")}Generate clips`; }
    }
  }
  $("#goBtn").onclick = submit; $("#goTop").onclick = submit;

  /* --- recent + side --- */
  bindProjectCards($("#recent"));
  const drawRecent = () => {
    const list = App.jobs.slice(0, 6);
    $("#recent").innerHTML = list.length ? list.map(projectCard).join("") :
      `<div class="card empty" style="grid-column:1/-1"><div class="ico">${ic("film", "lg")}</div><h3>No projects yet</h3><p>Paste a link or upload a video above. Your clips will show up here.</p></div>`;
  };
  const drawSide = () => {
    const s = App.status; if (!s) return;
    const ai = s.providers.filter((p) => p.has_key);
    const jobs = App.jobs, clips = jobs.reduce((a, j) => a + (j.clips_done || 0), 0);
    $("#sidePanel").innerHTML = `
      <div class="card pad-sm"><h3 style="margin:2px 2px 8px">Studio</h3>
        <div class="stat-line"><span class="k">${ic(s.gpu ? "zap" : "cpu")}Processing</span><span class="v">${s.gpu ? '<span class="badge ok">GPU</span>' : '<span class="badge warn">CPU · slow</span>'}</span></div>
        <div class="stat-line"><span class="k">${ic("sparkles")}AI providers</span><span class="v">${ai.length ? ai.map((p) => esc(p.name)).join(", ") : '<span class="faint">rule-based</span>'}</span></div>
        <div class="stat-line"><span class="k">${ic("layers")}Queue</span><span class="v">${s.queue} waiting</span></div>
        <div class="stat-line"><span class="k">${ic("cookie")}YouTube cookies</span><span class="v">${s.cookies ? '<span class="badge ok">Added</span>' : '<a class="badge" href="#/settings">Not added</a>'}</span></div>
        <div class="stat-line"><span class="k">${ic("hdd")}Free space</span><span class="v">${s.disk_free_gb} GB</span></div></div>
      <div class="card pad-sm"><div class="between" style="margin:2px 2px 10px"><h3>Your numbers</h3><a class="faint tiny" href="#/analytics">Details</a></div>
        <div class="stats" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="card stat" style="padding:14px;box-shadow:none"><div class="k">Projects</div><div class="v" style="font-size:24px">${jobs.length}</div></div>
          <div class="card stat" style="padding:14px;box-shadow:none"><div class="k">Clips</div><div class="v" style="font-size:24px">${clips}</div></div></div></div>
      <div class="note">${ic("info")}<span><b>Tip:</b> podcasts, interviews and talks give the best clips. For blocked YouTube videos, add a cookies file in Settings or upload the file.</span></div>`;
  };
  drawRecent(); drawSide();
  S.on(bus, "jobs", () => { drawRecent(); drawSide(); });
  S.on(bus, "status", drawSide);
  return () => S.done();
};

/* ======================= PROJECTS ======================= */
Pages.projects = function () {
  setActiveNav("projects"); setCrumbs([{ label: "Studio", href: "#/" }, { label: "Projects" }]);
  const S = scope();
  const f = { q: "", status: "all", sort: "new" };
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${ic("film", "xs")}Your workspace</div><h1>Projects</h1><p class="sub">Every source video and every clip, in one place.</p></div>
      <a class="btn primary" href="#/">${ic("plus", "sm")}New project</a></div>
    <div class="stats" id="pStats"></div>
    <div class="toolbar" style="margin-top:22px">
      <div class="search">${ic("search")}<input class="input" id="pq" placeholder="Search projects…" aria-label="Search projects"></div>
      <select class="select" id="pStatus" aria-label="Status"><option value="all">All statuses</option><option value="done">Ready</option><option value="busy">Processing</option><option value="error">Failed</option></select>
      <select class="select" id="pSort" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="clips">Most clips</option><option value="score">Best score</option></select>
      <span class="faint small" id="pCount" style="margin-left:auto"></span></div>
    <div class="proj-grid" id="pGrid"></div>`;
  bindProjectCards($("#pGrid"));
  const draw = () => {
    const J = App.jobs;
    const clips = J.reduce((a, j) => a + (j.clips_done || 0), 0);
    const busy = J.filter((j) => j.status === "running" || j.status === "queued").length;
    const scores = J.flatMap((j) => j.scores || []).filter((x) => x != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    $("#pStats").innerHTML = [
      ["Projects", J.length, "film", "All time"], ["Clips made", clips, "scissors", "Ready to post"],
      ["Processing", busy, "refresh", busy ? "Running now" : "Nothing running"], ["Avg. virality", avg ?? "—", "flame", "AI score of your clips"],
    ].map(([k, val, i, foot]) => `<div class="card stat"><div class="k">${k}<i>${ic(i, "sm")}</i></div><div class="v">${val}</div><div class="f">${foot}</div></div>`).join("");
    let list = J.filter((j) => !f.q || (j.title || "").toLowerCase().includes(f.q));
    if (f.status === "busy") list = list.filter((j) => j.status === "running" || j.status === "queued");
    else if (f.status !== "all") list = list.filter((j) => j.status === f.status);
    list = [...list].sort((a, b) => f.sort === "old" ? a.created - b.created : f.sort === "clips" ? (b.clips_done || 0) - (a.clips_done || 0)
      : f.sort === "score" ? (b.top_score || 0) - (a.top_score || 0) : b.created - a.created);
    $("#pCount").textContent = `${list.length} of ${J.length}`;
    $("#pGrid").innerHTML = list.length ? list.map(projectCard).join("") :
      `<div class="card empty" style="grid-column:1/-1"><div class="ico">${ic(J.length ? "search" : "film", "lg")}</div><h3>${J.length ? "No matches" : "No projects yet"}</h3><p>${J.length ? "Try a different search or filter." : "Create your first project to see it here."}</p>${J.length ? "" : `<a class="btn primary" href="#/">${ic("plus", "sm")}New project</a>`}</div>`;
  };
  $("#pq").oninput = (e) => { f.q = e.target.value.trim().toLowerCase(); draw(); };
  $("#pStatus").onchange = (e) => { f.status = e.target.value; draw(); };
  $("#pSort").onchange = (e) => { f.sort = e.target.value; draw(); };
  draw();
  S.on(bus, "jobs", draw);
  return () => S.done();
};

/* ======================= PROJECT ======================= */
const STAGES = [
  ["download", "Downloading", "Getting the source video", "download"],
  ["transcribe", "Transcribing", "Word-level speech to text", "type"],
  ["pick", "Finding moments", "AI ranks the viral parts", "sparkles"],
  ["render", "Rendering", "Reframe, captions, export", "film"],
];
Pages.project = function (id) {
  setActiveNav("projects");
  const S = scope();
  const st = { job: null, timer: null, sel: new Set(), selecting: false, q: "", sort: "order", filter: "all", samples: [], logOpen: store.get("log-open", false) };
  const v = $("#view");
  v.innerHTML = `<div class="proj-head"><div class="th skeleton"></div><div class="grow"><div class="skeleton" style="height:26px;width:60%;border-radius:8px"></div><div class="skeleton" style="height:14px;width:35%;border-radius:6px;margin-top:12px"></div></div></div>
    <div class="clips">${Array.from({ length: 4 }, () => `<div class="card clip"><div class="phone skeleton"></div><div class="skeleton" style="height:14px;margin:14px 4px 0;border-radius:6px"></div></div>`).join("")}</div>`;
  let built = false;

  function build(job) {
    built = true;
    v.innerHTML = `
      <div class="proj-head">
        <div class="th">${job.thumb_url ? `<img src="${esc(job.thumb_url)}" alt="">` : `<div style="display:grid;place-items:center;height:100%;color:var(--text-3)">${ic("film", "lg")}</div>`}</div>
        <div class="grow"><h1 id="jTitle"></h1><div class="meta" id="jMeta"></div></div>
        <div class="row wrap" id="jActs"></div>
      </div>
      <div id="procBox"></div>
      <div id="errBox"></div>
      <div class="section-head" id="clipsHead"><div><h2 id="clipsTitle">Clips</h2><p id="clipsSub"></p></div>
        <div class="row wrap"><div class="search" style="flex-basis:200px">${ic("search")}<input class="input" id="cq" placeholder="Search clips…" aria-label="Search clips"></div>
          <select class="select" id="cSort" aria-label="Sort clips" style="min-height:36px;width:auto"><option value="order">In video order</option><option value="score">Highest score</option><option value="len">Shortest first</option></select>
          <button class="btn ghost sm" id="selBtn">${ic("checksq", "sm")}Select</button></div></div>
      <div class="clips" id="clips"></div>
      <div id="bulk"></div>
      <div class="card pad" style="margin-top:22px" id="logCard"><div class="between"><h3>${ic("list", "sm")} Activity log</h3><button class="btn ghost sm" id="logBtn"></button></div><div class="log hidden" id="log" style="margin-top:12px"></div></div>`;
    $("#cq").oninput = (e) => { st.q = e.target.value.trim().toLowerCase(); drawClips(true); };
    $("#cSort").onchange = (e) => { st.sort = e.target.value; drawClips(true); };
    $("#selBtn").onclick = () => { st.selecting = !st.selecting; st.sel.clear(); drawClips(true); drawBulk(); };
    const drawLogBtn = () => { $("#logBtn").innerHTML = st.logOpen ? `Hide ${ic("down", "sm")}` : `Show ${ic("down", "sm")}`; $("#log").classList.toggle("hidden", !st.logOpen); };
    $("#logBtn").onclick = () => { st.logOpen = !st.logOpen; store.set("log-open", st.logOpen); drawLogBtn(); drawLog(st.job); };
    drawLogBtn();
    bindClipEvents();
  }

  function drawHead(job) {
    setCrumbs([{ label: "Projects", href: "#/projects" }, { label: job.title || "Project" }]);
    $("#jTitle").textContent = job.title || "Video";
    const bits = [statusBadge(job)];
    if (job.duration) bits.push(`<span class="chip">${ic("clock")}${fmtDur(job.duration)}</span>`);
    if (job.language) bits.push(`<span class="chip">${ic("globe")}${esc(LANGS[job.language] || job.language)}</span>`);
    bits.push(`<span class="chip">${ic(job.source.kind === "url" ? "link" : "upload")}${job.source.kind === "url" ? "Link" : "Upload"}</span>`);
    if (job.long) bits.push(`<span class="chip" title="Audio-first download: only clip sections are downloaded">${ic("zap")}Long stream mode</span>`);
    bits.push(`<span class="chip">${ic("calendar")}${new Date(job.created * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>`);
    const o = job.options;
    bits.push(`<span class="chip">${ic("type")}${esc(styleById(o.caption_style).name)}</span><span class="chip">${ic("layout")}${esc(o.aspect || "9:16")}</span>`);
    $("#jMeta").innerHTML = bits.join("");
    const ready = job.clips.filter((c) => c.file).length;
    $("#jActs").innerHTML = `
      ${job.status === "error" ? `<button class="btn primary" data-a="retry">${ic("refresh", "sm")}Retry</button>` : ""}
      ${ready ? `<a class="btn" href="/api/jobs/${esc(job.id)}/zip">${ic("download", "sm")}Download all</a>` : ""}
      ${ready ? `<button class="btn primary" data-a="publish">${ic("send", "sm")}Publish</button>` : ""}
      <button class="icon-btn" data-a="more" aria-label="More">${ic("more")}</button>`;
  }

  function drawProc(job) {
    const box = $("#procBox");
    const active = job.status === "queued" || job.status === "running";
    if (!active) { box.innerHTML = ""; st.samples = []; return; }
    const p = job.progress || 0;
    const now = Date.now() / 1000;
    st.samples.push([now, p]); st.samples = st.samples.filter(([t]) => now - t < 90);
    let eta = "";
    if (st.samples.length > 3 && p > 0.03) {
      const [t0, p0] = st.samples[0], rate = (p - p0) / Math.max(now - t0, 1);
      if (rate > 0) eta = `about ${fmtDur((1 - p) / rate)} left`;
    }
    const idx = STAGES.findIndex((s) => s[0] === job.stage);
    const queued = job.status === "queued";
    if (!$(".proc", box)) {
      box.innerHTML = `<div class="card proc"><div class="between" style="align-items:flex-end;flex-wrap:wrap">
          <div><div class="eyebrow" id="pEyebrow"></div><h2 style="margin-top:8px" id="pMsg"></h2><p class="sub" id="pSub"></p></div>
          <div class="pct" id="pPct"></div></div>
        <div class="progress" style="margin-top:18px;height:8px"><span id="pBar"></span></div>
        <div class="steps" id="pSteps"></div></div>`;
    }
    $("#pEyebrow").innerHTML = queued ? `${ic("clock", "xs")}Waiting in queue` : `<i class="dot live" style="width:6px;height:6px"></i>Processing`;
    $("#pMsg").textContent = queued && job.queue_position > 1 ? `Position ${job.queue_position} in the queue` : (job.message || "Working…");
    $("#pSub").textContent = queued ? "Starts automatically when the current project finishes." : (eta ? `${eta} · ` : "") + "You can close this tab — processing continues on the server.";
    $("#pPct").innerHTML = `${Math.round(p * 100)}<small>%</small>`;
    $("#pBar").style.width = Math.max(2, p * 100) + "%";
    $("#pSteps").innerHTML = STAGES.map(([k, l, d, i], n) => `<div class="step ${n < idx ? "done" : n === idx ? "now" : ""}">
        <div class="si">${n < idx ? ic("check", "sm") : n === idx ? `<span class="spinner" style="width:14px;height:14px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></span>` : ic(i, "sm")}</div>
        <b>${l}</b><small>${n < idx ? "Done" : d}</small></div>`).join("");
  }

  function drawErr(job) {
    $("#errBox").innerHTML = job.status === "error" ? `<div class="note err" style="margin-bottom:8px">${ic("alert")}<div class="grow"><b>This project failed.</b>
      <div style="white-space:pre-wrap;margin-top:6px;font-family:var(--mono);font-size:11.5px;max-height:180px;overflow:auto">${esc(job.error || "Unknown error")}</div>
      <div class="row wrap" style="margin-top:12px"><button class="btn sm primary" data-a="retry">${ic("refresh", "sm")}Retry</button>${/cookies|Sign in|age-restricted|403/i.test(job.error || "") ? `<a class="btn sm" href="#/settings">${ic("cookie", "sm")}Add YouTube cookies</a>` : ""}<a class="btn sm ghost" href="#/">${ic("upload", "sm")}Upload the file instead</a></div></div></div>` : "";
  }

  function visibleClips(job) {
    let list = job.clips.filter((c) => !st.q || `${c.title} ${c.hook} ${c.description}`.toLowerCase().includes(st.q));
    if (st.sort === "score") list = [...list].sort((a, b) => (b.score || 0) - (a.score || 0));
    if (st.sort === "len") list = [...list].sort((a, b) => (a.end - a.start) - (b.end - b.start));
    return list;
  }
  function clipKey(c) { return [c.status, c.version, c.title, c.start, c.end, c.error, c.score, st.selecting, st.sel.has(c.index), (c.posts || []).map((p) => `${p.status}${Math.round((p.progress || 0) * 20)}`).join()].join("|"); }
  function clipCard(c, job) {
    const len = c.end - c.start, busy = c.status === "rendering" || c.status === "queued";
    const shape = (c.effective?.aspect || job.options.aspect) === "1:1" ? "sq" : (job.options.aspect === "16:9" ? "wide" : "");
    let media;
    if (c.file && c.status === "done") {
      media = `${c.poster ? `<img src="${esc(c.poster)}" alt="" loading="lazy">` : ""}<span class="play-fab">${ic("play")}</span>`;
    } else if (c.status === "error") {
      media = `<div class="ph err">${ic("alert", "lg")}<b>Render failed</b><small>${esc((c.error || "").slice(0, 220))}</small></div>`;
    } else {
      media = `<div class="ph skeleton" style="position:absolute;inset:0"></div><div class="ph"><span class="spinner"></span><b>${c.status === "rendering" ? "Rendering…" : "In line…"}</b><small>${fmtDur(len)} clip</small></div>`;
    }
    return `<article class="card clip ${st.sel.has(c.index) ? "sel" : ""}" data-index="${c.index}" data-key="${esc(clipKey(c))}">
      <span class="check">${ic("check", "xs")}</span>
      <div class="phone ${shape}" data-act="play">${media}
        <div class="ov"><div class="top">${c.score != null ? `<button class="score ${scoreClass(c.score)}" data-act="score" title="Why this score">${ic("flame", "xs")}${c.score}</button>` : "<span></span>"}<span class="tag-dark">#${c.index}</span></div>
          <div class="bot"><span class="tag-dark">${ic("clock")}${fmtDur(len)}</span>${c.layout ? `<span class="tag-dark">${esc(c.layout)}</span>` : ""}</div></div></div>
      <div class="body"><div class="title">${esc(c.title || "Clip")}</div>
        <div class="meta"><span class="mono">${fmtTC(c.start)} → ${fmtTC(c.end)}</span>${c.version > 1 ? `<span>· v${c.version}</span>` : ""}</div>${postBadges(c)}
        <div class="acts">
          <button class="icon-btn pri" data-act="edit" ${busy ? "disabled" : ""} title="Edit clip">${ic("edit", "sm")}<span>Edit</span></button>
          ${c.file ? `<a class="icon-btn" href="${esc(c.url)}&download=1" download="${esc(c.download_name)}" title="Download" aria-label="Download">${ic("download", "sm")}</a>` : `<button class="icon-btn" disabled aria-label="Download">${ic("download", "sm")}</button>`}
          <button class="icon-btn" data-act="publish" ${c.file ? "" : "disabled"} title="Publish" aria-label="Publish">${ic("send", "sm")}</button>
          <button class="icon-btn" data-act="more" title="More" aria-label="More">${ic("more", "sm")}</button></div></div></article>`;
  }
  function drawClips(force) {
    const job = st.job, wrap = $("#clips");
    const list = visibleClips(job);
    wrap.classList.toggle("selecting", st.selecting);
    $("#selBtn").classList.toggle("on", st.selecting);
    $("#selBtn").innerHTML = st.selecting ? `${ic("x", "sm")}Done` : `${ic("checksq", "sm")}Select`;
    const ready = job.clips.filter((c) => c.status === "done").length;
    $("#clipsTitle").textContent = job.clips.length ? `${job.clips.length} moment${job.clips.length === 1 ? "" : "s"}${job.status === "done" ? ", ready to go" : ""}` : "Clips";
    $("#clipsSub").textContent = job.clips.length ? `${ready} ready${job.clips.length - ready ? ` · ${job.clips.length - ready} in progress or failed` : ""}` : "";
    $("#clipsHead").classList.toggle("hidden", !job.clips.length);
    if (!job.clips.length) {
      const busy = job.status === "running" || job.status === "queued";
      wrap.innerHTML = busy ? Array.from({ length: Math.min(job.options.num_clips || 4, 8) }, () => `<div class="card clip"><div class="phone skeleton"></div><div class="skeleton" style="height:13px;margin:14px 4px 0;border-radius:6px"></div><div class="skeleton" style="height:13px;width:60%;margin:8px 4px 0;border-radius:6px"></div></div>`).join("")
        : job.status === "done" ? `<div class="card empty" style="grid-column:1/-1"><div class="ico">${ic("search", "lg")}</div><h3>No clips found</h3><p>The AI couldn't find good moments. Try a video with more talking, or different clip lengths.</p></div>` : "";
      return;
    }
    if (force) wrap.innerHTML = "";
    $$(".clip:not([data-index])", wrap).forEach((el) => el.remove());
    list.forEach((c, i) => {
      let card = wrap.querySelector(`.clip[data-index="${c.index}"]`);
      if (!card || card.dataset.key !== clipKey(c)) {
        const tmp = document.createElement("div"); tmp.innerHTML = clipCard(c, job);
        const fresh = tmp.firstElementChild;
        if (card) card.replaceWith(fresh); else wrap.appendChild(fresh);
        card = fresh;
      }
      if (wrap.children[i] !== card) wrap.insertBefore(card, wrap.children[i]);
    });
    $$(".clip", wrap).forEach((el) => { if (!list.some((c) => String(c.index) === el.dataset.index)) el.remove(); });
    if (!list.length) wrap.innerHTML = `<div class="card empty" style="grid-column:1/-1"><p style="margin:0">No clips match “${esc(st.q)}”.</p></div>`;
  }
  function drawBulk() {
    const b = $("#bulk");
    if (!st.selecting) { b.innerHTML = ""; return; }
    const n = st.sel.size;
    b.innerHTML = `<div class="bulk"><b class="small">${n} selected</b>
      <button class="btn sm ghost" data-b="all">Select all</button>
      <button class="btn sm" data-b="dl" ${n ? "" : "disabled"}>${ic("download", "sm")}Download</button>
      <button class="btn sm primary" data-b="pub" ${n ? "" : "disabled"}>${ic("send", "sm")}Publish</button>
      <button class="icon-btn sm flat" data-b="x" aria-label="Close">${ic("x", "sm")}</button></div>`;
  }
  function drawLog(job) {
    if (!st.logOpen || !job) return;
    const log = $("#log");
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = job.log.map((l) => `<div><span class="t">${new Date(l.t * 1000).toLocaleTimeString()}</span>${esc(l.msg)}</div>`).join("") || '<span class="faint">No activity yet</span>';
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  /* hover-to-preview: a muted looping video appears over the poster */
  let hoverVid = null;
  function stopHover() { if (hoverVid) { hoverVid.parentElement?.classList.remove("playing"); hoverVid.remove(); hoverVid = null; } }
  function bindClipEvents() {
    const wrap = $("#clips");
    wrap.addEventListener("mouseover", (e) => {
      const ph = e.target.closest(".phone"); if (!ph || !matchMedia("(hover: hover)").matches) return;
      const card = ph.closest(".clip"); const c = st.job.clips.find((x) => String(x.index) === card.dataset.index);
      if (!c || !c.url || c.status !== "done" || (hoverVid && hoverVid.parentElement === ph)) return;
      stopHover();
      hoverVid = document.createElement("video");
      Object.assign(hoverVid, { src: c.url, muted: true, loop: true, playsInline: true, autoplay: true, preload: "auto" });
      hoverVid.addEventListener("playing", () => ph.classList.add("playing"));
      ph.insertBefore(hoverVid, ph.querySelector(".ov"));
      hoverVid.play().catch(() => { });
    });
    wrap.addEventListener("mouseleave", stopHover);
    wrap.addEventListener("mouseout", (e) => { const ph = e.target.closest(".phone"); if (ph && !ph.contains(e.relatedTarget)) stopHover(); });
    wrap.addEventListener("click", async (e) => {
      const card = e.target.closest(".clip"); if (!card) return;
      const c = st.job.clips.find((x) => String(x.index) === card.dataset.index); if (!c) return;
      if (st.selecting && !e.target.closest("a")) {
        e.preventDefault();
        st.sel.has(c.index) ? st.sel.delete(c.index) : st.sel.add(c.index);
        drawClips(); drawBulk(); return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "score") { e.stopPropagation(); return scorePop(e.target.closest("[data-act]"), c); }
      if (act === "play") { if (c.url && c.status === "done") openPlayer(st.job, c); return; }
      if (act === "edit") { location.hash = `#/p/${id}/edit/${c.index}`; return; }
      if (act === "publish") return openPublish(st.job, [c]);
      if (act === "post-error") {
        e.preventDefault(); e.stopPropagation();
        const btn = e.target.closest("[data-pid]"), p = (c.posts || []).find((x) => x.id === btn.dataset.pid);
        if (!p) return;
        const pop = openPop(btn, `<div style="padding:6px 6px 2px"><b>${PNAME[p.platform]} ${p.status === "waiting" ? "is waiting" : "upload failed"}</b>
          <p class="small muted" style="margin:8px 0 12px;line-height:1.55;white-space:pre-wrap;word-break:break-word">${esc(p.error || "No details")}</p>
          <div class="row"><button class="btn sm primary" data-m="retry">${ic("refresh", "sm")}${p.status === "waiting" ? "Try now" : "Retry"}</button><button class="btn sm ghost" data-m="copy">${ic("copy", "sm")}Copy error</button></div></div>`, { width: 320 });
        pop.onclick = async (ev) => {
          const m = ev.target.closest("[data-m]")?.dataset.m; if (!m) return;
          if (m === "copy") { try { await navigator.clipboard.writeText(p.error || ""); toast("Error copied"); } catch { } return; }
          closePop(); retryPost(st.job, c, p.id);
        };
        return;
      }
      if (act === "more") {
        const pop = openPop(e.target.closest("[data-act]"), `
          ${c.url ? `<button class="mi" data-m="play">${ic("play", "sm")}Play</button>` : ""}
          <button class="mi" data-m="copy">${ic("copy", "sm")}Copy caption</button>
          <button class="mi" data-m="edit">${ic("edit", "sm")}Edit clip</button>
          <div class="divider" style="margin:6px 0"></div>
          <button class="mi danger" data-m="del">${ic("trash", "sm")}Delete clip</button>`);
        pop.onclick = async (ev) => {
          const m = ev.target.closest("[data-m]")?.dataset.m; if (!m) return; closePop();
          if (m === "play") openPlayer(st.job, c);
          if (m === "edit") location.hash = `#/p/${id}/edit/${c.index}`;
          if (m === "copy") copyCaption(c);
          if (m === "del") {
            if (!(await confirmBox({ title: "Delete this clip?", text: `“${esc(c.title)}” will be removed. This can't be undone.`, ok: "Delete clip", danger: true }))) return;
            try { renderAll(await api(`/api/jobs/${id}/clips/${c.index}`, { method: "DELETE" })); toast("Clip deleted"); } catch (err) { toast(err.message, "err"); }
          }
        };
      }
    });
  }
  function scorePop(anchor, c) {
    const sc = c.scores || {};
    const has = Object.keys(sc).length;
    openPop(anchor, `<div style="padding:6px 6px 2px"><div class="between"><b>Virality score</b><span class="score ${scoreClass(c.score)}" style="cursor:default">${c.score}</span></div>
      ${has ? `<div class="bars" style="margin-top:8px">${["hook", "flow", "value", "trend"].filter((k) => sc[k] != null).map((k) => `<div class="bl"><span style="text-transform:capitalize">${k}</span><div class="progress"><span style="width:${sc[k]}%"></span></div><b class="num">${sc[k]}</b></div>`).join("")}</div>` : ""}
      ${c.reason ? `<p class="small muted" style="margin:10px 0 4px;line-height:1.55">${esc(c.reason)}</p>` : ""}
      ${!has ? `<p class="tiny faint" style="margin:8px 0 2px">A detailed breakdown appears on clips picked by an AI provider.</p>` : ""}</div>`, { width: 280 });
  }

  function renderAll(job) {
    st.job = job;
    if (!built) build(job);
    drawHead(job); drawProc(job); drawErr(job); drawClips(); drawBulk(); drawLog(job);
  }

  async function poll() {
    clearTimeout(st.timer);
    try {
      const job = await api(`/api/jobs/${id}`);
      renderAll(job);
      const busy = job.status === "queued" || job.status === "running" || job.clips.some((c) => c.status === "queued" || c.status === "rendering"
        || (c.posts || []).some((p) => p.status === "queued" || p.status === "uploading"));
      st.timer = setTimeout(poll, busy ? 2000 : 15000);
    } catch (e) {
      if (/not found/i.test(e.message)) { toast("Project not found", "err"); location.hash = "#/projects"; return; }
      console.error(e); st.timer = setTimeout(poll, 4000);
    }
  }
  S.add(() => { clearTimeout(st.timer); stopHover(); });
  S.on(bus, "posted", () => poll());

  S.on(v, "click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    const b = e.target.closest("[data-b]")?.dataset.b;
    if (a === "retry") { try { renderAll(await postJSON(`/api/jobs/${id}/retry`, {})); poll(); refreshJobs(); } catch (err) { toast(err.message, "err"); } }
    if (a === "publish") openPublish(st.job, st.job.clips.filter((c) => c.file));
    if (a === "more") {
      const pop = openPop(e.target.closest("[data-a]"), `
        ${st.job.source.url ? `<a class="mi" href="${esc(st.job.source.url)}" target="_blank" rel="noopener">${ic("link", "sm")}Open source link</a>` : ""}
        ${st.job.source_url ? `<a class="mi" href="/media/${esc(id)}/source" download>${ic("download", "sm")}Download source video</a>` : ""}
        <div class="divider" style="margin:6px 0"></div>
        <button class="mi danger" data-m="del">${ic("trash", "sm")}Delete project</button>`);
      pop.onclick = async (ev) => {
        if (ev.target.closest("[data-m]")?.dataset.m !== "del") return; closePop();
        if (!(await confirmBox({ title: "Delete this project?", text: "The source video and all its clips will be deleted from the server. This can't be undone.", ok: "Delete project", danger: true }))) return;
        try { await api(`/api/jobs/${id}`, { method: "DELETE" }); toast("Project deleted"); refreshJobs(); location.hash = "#/projects"; } catch (err) { toast(err.message, "err"); }
      };
    }
    if (b === "x") { st.selecting = false; st.sel.clear(); drawClips(true); drawBulk(); }
    if (b === "all") { st.job.clips.filter((c) => c.file).forEach((c) => st.sel.add(c.index)); drawClips(); drawBulk(); }
    if (b === "dl") {
      const list = st.job.clips.filter((c) => st.sel.has(c.index) && c.url);
      for (const c of list) { const l = document.createElement("a"); l.href = c.url + "&download=1"; l.download = c.download_name; document.body.appendChild(l); l.click(); l.remove(); await sleep(600); }
      toast(`Downloading ${list.length} clip${list.length === 1 ? "" : "s"}`, "info");
    }
    if (b === "pub") openPublish(st.job, st.job.clips.filter((c) => st.sel.has(c.index) && c.file));
  });
  poll();
  return () => S.done();
};

async function copyCaption(c) {
  const text = `${c.title || ""}\n\n${c.description || ""}\n\n${(c.hashtags || []).join(" ")}`.trim();
  try { await navigator.clipboard.writeText(text); toast("Caption copied"); }
  catch { openModal({ title: "Copy the caption", body: `<textarea class="textarea" style="min-height:160px">${esc(text)}</textarea>` }); }
}

/* ---------- player ---------- */
function openPlayer(job, c) {
  const m = openModal({
    title: c.title || "Clip", wide: true,
    body: `<div class="player"><div class="phone ${job.options.aspect === "1:1" ? "sq" : job.options.aspect === "16:9" ? "wide" : ""}"><video src="${esc(c.url)}" controls autoplay playsinline ${c.poster ? `poster="${esc(c.poster)}"` : ""}></video></div>
      <div class="stack" style="align-content:start">
        <div class="row wrap">${c.score != null ? `<span class="score ${scoreClass(c.score)}" style="cursor:default">${ic("flame", "xs")}${c.score}</span>` : ""}<span class="chip">${ic("clock")}${fmtDur(c.end - c.start)}</span><span class="chip mono">${fmtTC(c.start)} → ${fmtTC(c.end)}</span>${c.layout ? `<span class="chip">${ic("layout")}${esc(c.layout)}</span>` : ""}<span class="chip">v${c.version}</span></div>
        ${c.hook ? `<div><div class="label">Hook</div><p style="margin:6px 0 0;font-weight:650">${esc(c.hook)}</p></div>` : ""}
        ${c.description ? `<div><div class="label">Caption</div><p class="muted" style="margin:6px 0 0;line-height:1.6">${esc(c.description)}</p></div>` : ""}
        ${(c.hashtags || []).length ? `<div class="row wrap">${c.hashtags.map((t) => `<span class="tag" style="padding-right:9px">${esc(t)}</span>`).join("")}</div>` : ""}
        ${c.reason ? `<div class="note">${ic("sparkles")}<span><b>Why it works:</b> ${esc(c.reason)}</span></div>` : ""}
        <div class="row wrap" style="margin-top:6px">
          <a class="btn" href="${esc(c.url)}&download=1" download="${esc(c.download_name)}">${ic("download", "sm")}Download</a>
          <button class="btn" data-p="copy">${ic("copy", "sm")}Copy caption</button>
          <a class="btn" href="#/p/${esc(job.id)}/edit/${c.index}">${ic("edit", "sm")}Edit</a>
          <button class="btn primary" data-p="pub">${ic("send", "sm")}Publish</button></div></div></div>`,
  });
  m.box.addEventListener("click", (e) => {
    const p = e.target.closest("[data-p]")?.dataset.p;
    if (p === "copy") copyCaption(c);
    if (p === "pub") { m.close(); openPublish(job, [c]); }
  });
}

/* ---------- publish ---------- */
const PNAME = { yt: "YouTube", ig: "Instagram", fb: "Facebook", tt: "TikTok" };
const pById = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];
const nowLocalISO = (mins = 0) => { const d = new Date(Date.now() + mins * 60000); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function postBadges(c) {
  const posts = c.posts || [];
  if (!posts.length) return "";
  const latest = {};
  posts.forEach((p) => { latest[p.platform] = p; });
  return `<div class="row wrap" style="gap:5px;margin-top:8px">${Object.values(latest).map((p) => {
    const name = PNAME[p.platform] || p.platform;
    if (p.status === "scheduled") return `<span class="badge live" title="Clipora posts it at this time (keep the site running)">${ic("clock")}${name} · ${shortDate(p.publish_at)}</span>`;
    if (p.status === "queued" || p.status === "uploading") return `<span class="badge live" title="Uploading to ${name}">${ic("upload")}${name} ${Math.round((p.progress || 0) * 100)}%</span>`;
    if (p.status === "error") return `<button class="badge err" data-act="post-error" data-pid="${esc(p.id)}" title="${esc(p.error || "")}" style="border:0;cursor:pointer">${ic("alert")}${name} failed · Why?</button>`;
    if (p.status === "waiting") return `<button class="badge warn" data-act="post-error" data-pid="${esc(p.id)}" title="${esc(p.error || "")}" style="border:0;cursor:pointer">${ic("clock")}${name} · waiting for quota</button>`;
    const sched = p.publish_at && new Date(p.publish_at) > new Date();
    return `<a class="badge ok" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on ${name}">${ic(sched ? "clock" : "check")}${sched ? `${name} · ${shortDate(p.publish_at)}` : `On ${name}`}</a>`;
  }).join("")}</div>`;
}
async function retryPost(job, c, pid) {
  const p = (c.posts || []).find((x) => x.id === pid); if (!p) return;
  const future = p.publish_at && new Date(p.publish_at) > new Date(Date.now() + 180000);
  try {
    await postJSON(`/api/jobs/${job.id}/clips/${c.index}/publish`, { platforms: [p.platform], title: p.title, description: p.description, hashtags: p.hashtags, privacy: p.privacy, made_for_kids: p.made_for_kids, publish_at: future ? p.publish_at : null });
    toast("Trying the upload again", "info"); bus.dispatchEvent(new Event("posted"));
  } catch (e) { toast(e.message, "err", 6000); }
}
/* which platforms can take this clip right now, and why not */
function platformState(conn, id, clips) {
  const yt = conn.yt || {}, mt = conn.meta || {};
  const longest = Math.max(...clips.map((c) => c.end - c.start));
  if (id === "yt") return yt.connected ? { ok: true, who: yt.channel?.title, pic: yt.channel?.thumb } : { ok: false, why: yt.configured ? "Not connected" : "Needs setup" };
  if (id === "ig") {
    if (!mt.connected) return { ok: false, why: mt.configured ? "Not connected" : "Needs setup" };
    if (!mt.ig) return { ok: false, why: "No Instagram linked to your Page" };
    if (longest > 900) return { ok: false, why: "Clips must be 15 min or shorter" };
    return { ok: true, who: "@" + mt.ig.username, pic: mt.ig.picture };
  }
  if (id === "fb") {
    if (!mt.connected || !mt.page) return { ok: false, why: mt.configured ? "Not connected" : "Needs setup" };
    if (longest > 90) return { ok: false, why: "Facebook Reels must be 90 s or shorter" };
    return { ok: true, who: mt.page.name, pic: mt.page.picture };
  }
  return { ok: false, why: "Coming soon", soon: true };
}

async function openPublish(job, clips) {
  if (!clips.length) return toast("Nothing ready to publish yet", "info");
  const conn = App.conn || (await loadConn()) || {};
  const c = clips[0], multi = clips.length > 1;
  const states = Object.fromEntries(PLATFORMS.map((p) => [p.id, platformState(conn, p.id, clips)]));
  const sel = new Set(PLATFORMS.filter((p) => states[p.id].ok).map((p) => p.id));
  const st = { when: "now" };
  const avatar = (s, p) => s.pic ? `<img src="${esc(s.pic)}" alt="" style="width:28px;height:28px;border-radius:9px;background:var(--s3)" onerror="this.style.visibility='hidden'">` : platIco(p, true);
  const row = (p) => {
    const s = states[p.id];
    return `<div class="pub-plat">${s.ok ? avatar(s, p) : platIco(p, true)}<div class="grow"><b class="small">${p.name}</b><div class="tiny faint">${esc(s.ok ? s.who || "Connected" : s.why)}</div></div>
      ${s.ok ? toggleHTML("pub-" + p.id, true) : s.soon ? '<span class="badge soon">SOON</span>' : /Not connected|Needs setup/.test(s.why) ? '<a class="btn sm" href="#/connections">Connect</a>' : ""}</div>`;
  };
  const any = Object.values(states).some((s) => s.ok);
  const m = openModal({
    title: multi ? `Publish ${clips.length} clips` : "Publish clip", wide: true, icon: `<span class="plat-ico sm" style="background:var(--grad)">${ic("send")}</span>`,
    body: `
      ${any ? `<div class="note" style="margin-bottom:18px">${ic("info")}<span><b>YouTube</b> may keep uploads <b>Private</b> until Google reviews your app (switch them to Public in YouTube Studio). Instagram and Facebook posts go live publicly.</span></div>`
        : `<div class="note warn" style="margin-bottom:18px">${ic("info")}<span><b>Connect an account first</b> on the Connections page. Meanwhile you can download the clip and copy the caption.</span></div>`}
      <div class="two" style="grid-template-columns:1.05fr 1fr">
        <div class="stack">
          <div class="field"><div class="label">Post to</div>${PLATFORMS.map(row).join("")}</div>
          <div class="field"><div class="label">When</div><div id="whenSeg">${segHTML([["now", "Post now", "send"], ["later", "Schedule", "calendar"]], "now", "full")}</div>
            <input class="input hidden" type="datetime-local" id="pubWhen" min="${nowLocalISO(5)}" value="${nowLocalISO(60)}">
            <span class="tiny faint hidden" id="whenNote">YouTube schedules it on its side. Instagram and Facebook posts are sent by Clipora at that time, so the site must be running then.</span></div>
        </div>
        <div class="stack">
          ${multi ? `<div class="note">${ic("layers")}<span>Each clip is posted with its own title, caption and hashtags. Edit them per clip in the editor.</span></div>` : `
          <div class="field"><div class="label">Title <span class="tiny faint">YouTube only</span><span class="counter" id="ctTitle"></span></div><input class="input" id="pubTitle" maxlength="100" value="${esc(c.title || "")}"></div>
          <div class="field"><div class="label">Caption / description <span class="counter" id="ctDesc"></span></div><textarea class="textarea" id="pubDesc">${esc(c.description || "")}</textarea></div>
          <div class="field"><div class="label">Hashtags <span class="tiny faint">#Shorts is added for YouTube</span></div><input class="input" id="pubTags" value="${esc((c.hashtags || []).join(" "))}"></div>`}
          <div class="row" style="align-items:flex-end"><div class="field grow"><div class="label">YouTube visibility</div><select class="select" id="pubPriv"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></div>
            <div class="field"><div class="label">Made for kids</div><div style="padding-bottom:9px">${toggleHTML("pubKids", false)}</div></div></div>
        </div></div>`,
    foot: `${multi ? "" : `<button class="btn ghost" data-p="copy">${ic("copy", "sm")}Copy caption</button><a class="btn ghost" href="${esc(c.url)}&download=1" download="${esc(c.download_name)}">${ic("download", "sm")}Download</a>`}
      <button class="btn primary" data-p="go" id="pubGo">${ic("send", "sm")}${multi ? `Publish ${clips.length}` : "Publish"}</button>`,
  });
  const box = m.box;
  const drawGo = () => { const b = $("#pubGo", box); b.disabled = !sel.size; };
  PLATFORMS.forEach((p) => { const t = $("#pub-" + p.id, box); if (t) bindToggle(t, (on) => { on ? sel.add(p.id) : sel.delete(p.id); drawGo(); }); });
  bindToggle($("#pubKids", box));
  segBind($("#whenSeg .seg", box), (w) => {
    st.when = w;
    $("#pubWhen", box).classList.toggle("hidden", w !== "later"); $("#whenNote", box).classList.toggle("hidden", w !== "later");
    $("#pubPriv", box).disabled = w === "later";
  });
  if (!multi) {
    const count = () => {
      const t = $("#pubTitle", box).value.length, d = ($("#pubDesc", box).value + " " + $("#pubTags", box).value).trim().length;
      const max = sel.has("ig") ? 2200 : 4800;
      $("#ctTitle", box).textContent = `${t}/100`; $("#ctTitle", box).classList.toggle("over", t > 100);
      $("#ctDesc", box).textContent = `${d}/${max}`; $("#ctDesc", box).classList.toggle("over", d > max);
    };
    ["#pubTitle", "#pubDesc", "#pubTags"].forEach((s) => $(s, box).addEventListener("input", count)); count();
    box.addEventListener("click", (e) => { if (e.target.closest(".toggle")) count(); });
  }
  drawGo();
  const cur = () => ({ title: $("#pubTitle", box).value, description: $("#pubDesc", box).value, hashtags: $("#pubTags", box).value.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : "#" + t)) });
  box.addEventListener("click", async (e) => {
    const p = e.target.closest("[data-p]")?.dataset.p;
    if (p === "copy") copyCaption({ ...c, ...cur() });
    if (p !== "go" || !sel.size) return;
    let publish_at = null;
    if (st.when === "later") {
      const v = $("#pubWhen", box).value;
      if (!v || new Date(v) < new Date(Date.now() + 3 * 60000)) return toast("Pick a time at least a few minutes from now", "err");
      publish_at = new Date(v).toISOString();
    }
    const base = { platforms: [...sel], privacy: $("#pubPriv", box).value, made_for_kids: isOn($("#pubKids", box)), publish_at };
    const btn = $("#pubGo", box); btn.disabled = true; btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></span>Starting…`;
    let ok = 0;
    for (const clip of clips) {
      try { await postJSON(`/api/jobs/${job.id}/clips/${clip.index}/publish`, multi ? base : { ...base, ...cur() }); ok++; }
      catch (err) { toast(`Clip ${clip.index}: ${err.message}`, "err", 7000); }
    }
    if (ok) {
      m.close();
      const names = [...sel].map((x) => PNAME[x]).join(", ");
      toast(publish_at ? `Scheduled ${ok} clip${ok === 1 ? "" : "s"} for ${names}` : `Uploading ${ok} clip${ok === 1 ? "" : "s"} to ${names}…`, "info", 4500);
      bus.dispatchEvent(new Event("posted")); refreshJobs();
    } else { btn.disabled = false; btn.innerHTML = `${ic("send", "sm")}Publish`; }
  });
}

/* ======================= CALENDAR ======================= */
Pages.calendar = function () {
  setActiveNav("calendar"); setCrumbs([{ label: "Publish", href: "#/calendar" }, { label: "Calendar" }]);
  const S = scope();
  const st = { view: store.get("cal-view", "month"), at: new Date() };
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${ic("calendar", "xs")}Publishing</div><h1>Content calendar</h1><p class="sub">Scheduled posts and the clips you made, day by day.</p></div>
      <div class="row wrap"><div id="calSeg">${segHTML([["week", "Week"], ["month", "Month"]], st.view)}</div><button class="btn primary" id="calNew">${ic("plus", "sm")}Schedule clip</button></div></div>
    <div class="card pad"><div class="between" style="margin-bottom:16px"><div><h2 id="calTitle"></h2><p class="small faint" style="margin:4px 0 0" id="calSub"></p></div>
      <div class="row"><button class="btn sm ghost" id="calToday">Today</button><button class="icon-btn sm" id="calPrev" aria-label="Previous">${ic("left", "sm")}</button><button class="icon-btn sm" id="calNext" aria-label="Next">${ic("right", "sm")}</button></div></div>
      <div id="calGrid"></div></div>
    <div class="card pad" style="margin-top:18px"><div class="between"><div><h2>Publishing queue</h2><p class="small faint" style="margin:4px 0 0">Uploads, scheduled posts and what went live</p></div><span class="badge" id="qCount"></span></div>
      <div id="queueBox"></div></div>`;
  const draw = () => {
    const at = st.at, today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    let start;
    if (st.view === "month") {
      const first = new Date(at.getFullYear(), at.getMonth(), 1);
      start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
      for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
      $("#calTitle").textContent = at.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    } else {
      start = new Date(at); start.setHours(0, 0, 0, 0); start.setDate(at.getDate() - ((at.getDay() + 6) % 7));
      for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
      $("#calTitle").textContent = `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    const byDay = {};
    App.jobs.filter((j) => j.clips_done).forEach((j) => { const k = new Date(j.created * 1000).toDateString(); (byDay[k] = byDay[k] || []).push(j); });
    const made = days.reduce((a, d) => a + (byDay[d.toDateString()] || []).reduce((x, j) => x + j.clips_done, 0), 0);
    const posts = App.jobs.flatMap((j) => (j.posts || []).map((p) => ({ ...p, job: j })));
    const postDay = (p) => new Date(p.publish_at || (p.done_at || p.created) * 1000).toDateString();
    const byPost = {};
    posts.forEach((p) => { (byPost[postDay(p)] = byPost[postDay(p)] || []).push(p); });
    const sched = posts.filter((p) => p.publish_at && new Date(p.publish_at) > new Date() && p.status !== "error").length;
    $("#calSub").textContent = `${made} clip${made === 1 ? "" : "s"} made in this view · ${sched} scheduled`;
    drawQueue(posts);
    const heads = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((h) => `<div class="dh">${h}</div>`).join("");
    $("#calGrid").innerHTML = `<div class="cal ${st.view}">${heads}${days.map((d) => {
      const evs = byDay[d.toDateString()] || [];
      return `<div class="d ${st.view === "month" && d.getMonth() !== at.getMonth() ? "out" : ""} ${d.getTime() === today.getTime() ? "today" : ""}"><span class="n">${d.getDate()}</span>
        ${(byPost[d.toDateString()] || []).slice(0, st.view === "week" ? 8 : 3).map((p) => `<a class="ev" href="#/p/${esc(p.job.id)}" title="${esc(p.clip_title || "")}" style="${p.status === "error" ? "background:rgba(241,109,130,.1);color:var(--err)" : p.publish_at && new Date(p.publish_at) > new Date() ? "" : "background:rgba(86,214,154,.1);color:var(--ok)"}">${ic(p.platform || "yt", "xs")}${p.publish_at ? new Date(p.publish_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + " · " : ""}${esc(p.clip_title || "Clip")}</a>`).join("")}
        ${evs.slice(0, st.view === "week" ? 8 : 2).map((j) => `<a class="ev" href="#/p/${esc(j.id)}" title="${esc(j.title)}" style="background:transparent;border:1px dashed var(--line-2);color:var(--text-3)">${ic("scissors", "xs")}${j.clips_done} made · ${esc(j.title)}</a>`).join("")}
        ${evs.length > 2 && st.view === "month" ? `<div class="tiny faint" style="margin-top:4px">+${evs.length - 2} more</div>` : ""}</div>`;
    }).join("")}</div>`;
  };
  function drawQueue(posts) {
    const list = [...posts].sort((a, b) => (b.publish_at ? Date.parse(b.publish_at) / 1000 : b.created) - (a.publish_at ? Date.parse(a.publish_at) / 1000 : a.created)).slice(0, 30);
    $("#qCount").textContent = `${posts.filter((p) => p.publish_at && new Date(p.publish_at) > new Date() && p.status !== "error").length} scheduled`;
    const label = (p) => p.status === "error" ? `<span class="badge err" title="${esc(p.error || "")}">Failed</span>`
      : p.status === "scheduled" ? `<span class="badge live">${ic("clock")}Scheduled</span>`
      : p.status === "waiting" ? `<span class="badge warn" title="${esc(p.error || "")}">${ic("clock")}Waiting for quota</span>`
      : p.status !== "done" ? `<span class="badge live">Uploading ${Math.round((p.progress || 0) * 100)}%</span>`
        : p.publish_at && new Date(p.publish_at) > new Date() ? `<span class="badge live">${ic("clock")}Scheduled</span>` : `<span class="badge ok">${ic("check")}Live${p.privacy && p.privacy !== "public" ? ` · ${esc(p.privacy)}` : ""}</span>`;
    $("#queueBox").innerHTML = list.length ? `<div style="overflow:auto;margin-top:10px"><table class="table"><thead><tr><th>Clip</th><th>Platform</th><th>When</th><th>Status</th><th></th></tr></thead><tbody>${list.map((p) => `<tr data-h="#/p/${esc(p.job.id)}">
        <td><b>${esc(p.clip_title || "Clip")}</b><div class="tiny faint">${esc(p.job.title).slice(0, 50)}</div></td>
        <td><span class="row" style="gap:8px">${platIco(pById(p.platform), true)}${PNAME[p.platform] || p.platform}</span></td>
        <td>${new Date(p.publish_at || (p.done_at || p.created) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td>${label(p)}</td><td style="text-align:right">${p.url ? `<a class="btn sm ghost" href="${esc(p.url)}" target="_blank" rel="noopener">Open ${ic("right", "sm")}</a>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty" style="padding:30px 10px 10px"><div class="ico">${ic("send", "lg")}</div><h3>Nothing posted yet</h3><p>${App.conn?.yt?.connected || App.conn?.meta?.connected ? "Open a project, pick a clip and press Publish. Choose Schedule to pick a time." : "Connect an account first, then press Publish on any clip."}</p>${App.conn?.yt?.connected || App.conn?.meta?.connected ? "" : `<a class="btn" href="#/connections">${ic("link", "sm")}Connections</a>`}</div>`;
  }
  $("#queueBox").addEventListener("click", (e) => { if (e.target.closest("a")) return; const r = e.target.closest("tr[data-h]"); if (r) location.hash = r.dataset.h; });
  segBind($("#calSeg .seg"), (x) => { st.view = x; store.set("cal-view", x); draw(); });
  $("#calPrev").onclick = () => { st.view === "month" ? st.at.setMonth(st.at.getMonth() - 1, 1) : st.at.setDate(st.at.getDate() - 7); draw(); };
  $("#calNext").onclick = () => { st.view === "month" ? st.at.setMonth(st.at.getMonth() + 1, 1) : st.at.setDate(st.at.getDate() + 7); draw(); };
  $("#calToday").onclick = () => { st.at = new Date(); draw(); };
  $("#calNew").onclick = () => {
    const ready = App.jobs.filter((j) => j.clips_done);
    if (!ready.length) return toast("Make some clips first", "info");
    location.hash = `#/p/${ready[0].id}`; toast("Pick a clip and press Publish", "info");
  };
  draw();
  S.on(bus, "jobs", draw);
  return () => S.done();
};

/* ======================= CONNECTIONS ======================= */
Pages.connections = function () {
  setActiveNav("connections"); setCrumbs([{ label: "Publish", href: "#/calendar" }, { label: "Connections" }]);
  const S = scope();
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${ic("link", "xs")}Distribution</div><h1>Connected accounts</h1><p class="sub">Link your channels to publish and schedule straight from Clipora.</p></div></div>
    <div class="conn-grid" id="connGrid"><div class="card conn skeleton" style="height:240px"></div><div class="card conn skeleton" style="height:240px"></div></div>`;
  const q = App.query;
  if (q.get("yt") === "ok") toast("YouTube connected");
  if (q.get("meta") === "ok") toast("Instagram & Facebook connected");
  if (q.get("yt_error")) toast(q.get("yt_error"), "err", 8000);
  if (q.get("meta_error")) toast(q.get("meta_error"), "err", 8000);
  if (q.toString()) history.replaceState(null, "", "#/connections");

  const img = (src, fallback) => src ? `<img src="${esc(src)}" alt="" style="width:40px;height:40px;border-radius:12px;background:var(--s3)" onerror="this.style.visibility='hidden'">` : fallback;
  const li = (icon, html) => `<li>${ic(icon)}<span>${html}</span></li>`;
  const card = (top, badge, items, actions, extra = "") => `<div class="card conn"><div class="top">${top}${badge}</div>${extra}<ul>${items.join("")}</ul><div class="row wrap">${actions}</div></div>`;
  const head = (pic, title, sub) => `${pic}<div class="grow"><h3>${title}</h3><div class="small faint">${sub}</div></div>`;

  function ytCard(yt) {
    const P = pById("yt");
    if (!yt.configured) return card(head(platIco(P), "YouTube", "YouTube Shorts"), '<span class="badge warn">Needs setup</span>',
      [li("key", "Add <code>YOUTUBE_CLIENT_ID</code> and <code>YOUTUBE_CLIENT_SECRET</code> to your secrets / clipora.env."), li("refresh", "Then re-run the launcher."),
       li("link", `Redirect URI for Google Cloud: <code style="word-break:break-all">${esc(yt.redirect_uri || "")}</code>`)], `<button class="btn grow" disabled>${ic("link", "sm")}Connect YouTube</button>`);
    if (!yt.connected) return card(head(platIco(P), "YouTube", "YouTube Shorts"), '<span class="badge warn">Not connected</span>',
      [li("check", "Sign in with the Google account that owns your channel. If it has several channels, Google asks which one."),
       li("info", "Google shows “unverified app”: click <b>Advanced → Go to Clipora</b>. It's your own app.")],
      `<button class="btn primary grow" data-c="yt-connect">${ic("link", "sm")}Connect YouTube</button>`, yt.error ? `<div class="note warn">${ic("alert")}<span>${esc(yt.error)}</span></div>` : "");
    const ch = yt.channel || {};
    return card(head(img(ch.thumb, platIco(P)), esc(ch.title || "YouTube"), `${ch.subs != null ? `${Number(ch.subs).toLocaleString()} subscribers · ` : ""}YouTube Shorts`), `<span class="badge ok">${ic("check")}Connected</span>`,
      [li("info", "Testing mode: Google ends the connection every 7 days. Just press Connect again."),
       li("info", "Uploads may stay <b>Private</b> until Google reviews the app. Switch them to Public in YouTube Studio."),
       yt.from_secret ? li("key", "Using the <code>YOUTUBE_REFRESH_TOKEN</code> secret.") : li("key", `Kaggle forgets this connection when the session ends. <a href="#" data-c="yt-token" style="color:var(--violet)">Save it as a secret</a>.`)],
      `${ch.url ? `<a class="btn grow" href="${esc(ch.url)}" target="_blank" rel="noopener">${ic("globe", "sm")}Open channel</a>` : ""}<button class="btn ghost" data-c="yt-disconnect">${ic("logout", "sm")}Disconnect</button>`,
      yt.error ? `<div class="note warn">${ic("alert")}<span>${esc(yt.error)}</span></div>` : "");
  }
  function metaCards(mt) {
    const IG = pById("ig"), FB = pById("fb");
    if (!mt.configured) {
      const setup = [li("key", "Add <code>META_APP_ID</code>, <code>META_APP_SECRET</code> and <code>META_CONFIG_ID</code> to your clipora.env / secrets."), li("refresh", "Then re-run the launcher.")];
      return card(head(platIco(IG), "Instagram", "Instagram Reels"), '<span class="badge warn">Needs setup</span>', setup, `<button class="btn grow" disabled>${ic("link", "sm")}Connect</button>`)
        + card(head(platIco(FB), "Facebook", "Facebook Page Reels"), '<span class="badge warn">Needs setup</span>', setup, `<button class="btn grow" disabled>${ic("link", "sm")}Connect</button>`);
    }
    const err = mt.error ? `<div class="note warn">${ic("alert")}<span>${esc(mt.error)}</span></div>` : "";
    const cfgWarn = !mt.has_config ? `<div class="note warn">${ic("info")}<span><code>META_CONFIG_ID</code> is missing. Facebook Login for Business usually needs it: create a Configuration in your Meta app and add its ID.</span></div>` : "";
    if (!mt.connected) {
      const items = [li("check", "One Facebook login connects both Instagram and Facebook."), li("check", "On Facebook's screen, tick your <b>Page</b> and your <b>Instagram</b> account."), li("info", "Instagram must be a Business or Creator account linked to your Page.")];
      const btn = `<button class="btn primary grow" data-c="meta-connect">${ic("link", "sm")}Connect with Facebook</button>`;
      return card(head(platIco(IG), "Instagram", "Instagram Reels"), '<span class="badge warn">Not connected</span>', items, btn, err + cfgWarn)
        + card(head(platIco(FB), "Facebook", "Facebook Page Reels"), '<span class="badge warn">Not connected</span>', items, btn, err);
    }
    const ig = mt.ig, page = mt.page;
    const pagePick = mt.pages.length > 1 ? `<div class="field"><div class="label">Post to Page</div><select class="select" id="pagePick">${mt.pages.map((p) => `<option value="${esc(p.id)}" ${page && p.id === page.id ? "selected" : ""}>${esc(p.name)}${p.ig ? ` (@${esc(p.ig)})` : ""}</option>`).join("")}</select></div>` : "";
    const tokenLi = mt.from_secret ? li("key", "Using the <code>META_TOKEN</code> secret.") : li("key", `Kaggle forgets this when the session ends. <a href="#" data-c="meta-token" style="color:var(--violet)">Save it as a secret</a> (lasts about 60 days).`);
    const igCard = ig
      ? card(head(img(ig.picture, platIco(IG)), "@" + esc(ig.username || "instagram"), `${ig.followers != null ? `${Number(ig.followers).toLocaleString()} followers · ` : ""}Instagram Reels`), `<span class="badge ok">${ic("check")}Connected</span>`,
        [li("info", "Reels go live publicly. Up to about 50 posts a day."), li("info", "Scheduled posts are sent by Clipora at that time, so keep the site running."), tokenLi],
        `<a class="btn grow" href="https://www.instagram.com/${esc(ig.username || "")}" target="_blank" rel="noopener">${ic("globe", "sm")}Open profile</a><button class="btn ghost" data-c="meta-refresh" title="Reload Pages and accounts">${ic("refresh", "sm")}</button><button class="btn ghost" data-c="meta-disconnect">${ic("logout", "sm")}Disconnect</button>`, err)
      : card(head(platIco(IG), "Instagram", "Instagram Reels"), '<span class="badge warn">Not linked</span>',
        [li("alert", "Facebook is connected, but no Instagram account is linked to this Page."), li("check", "Facebook Page → Settings → <b>Linked accounts</b> → connect your Business/Creator Instagram."), li("refresh", "Then press Connect again and tick the Instagram account.")],
        `<button class="btn primary grow" data-c="meta-connect">${ic("link", "sm")}Connect again</button><button class="btn ghost" data-c="meta-refresh">${ic("refresh", "sm")}Check again</button>`, err);
    const fbCard = page
      ? card(head(img(page.picture, platIco(FB)), esc(page.name), "Facebook Page Reels"), `<span class="badge ok">${ic("check")}Connected</span>`,
        [li("info", "Reels must be 90 seconds or shorter (Facebook's rule)."), li("info", "Posts go to the Page, not your personal profile."), tokenLi],
        `<a class="btn grow" href="https://www.facebook.com/${esc(page.id)}" target="_blank" rel="noopener">${ic("globe", "sm")}Open Page</a><button class="btn ghost" data-c="meta-disconnect">${ic("logout", "sm")}Disconnect</button>`, pagePick)
      : card(head(platIco(FB), "Facebook", "Facebook Page Reels"), '<span class="badge warn">No Page</span>',
        [li("alert", "No Facebook Page was shared with Clipora."), li("check", "Press Connect again and tick your Page on Facebook's screen.")],
        `<button class="btn primary grow" data-c="meta-connect">${ic("link", "sm")}Connect again</button>`, err);
    return igCard + fbCard;
  }
  function draw() {
    const c = App.conn || {};
    const TT = pById("tt");
    $("#connGrid").innerHTML = ytCard(c.yt || {}) + metaCards(c.meta || {}) + `
      <div class="card conn"><div class="top">${platIco(TT)}<div class="grow"><h3>TikTok</h3><div class="small faint">TikTok</div></div><span class="badge soon">COMING SOON</span></div>
        <ul>${TT.notes.map((n) => li("check", esc(n))).join("")}</ul><button class="btn ghost grow" disabled>${ic("link", "sm")}Needs your own domain first</button></div>`;
    const pp = $("#pagePick");
    if (pp) pp.onchange = async () => { try { await postJSON("/api/connect/meta/page", { page_id: pp.value }); await loadConn(); toast("Page switched"); } catch (e) { toast(e.message, "err"); } };
  }

  async function connect(kind) {
    const label = kind === "yt" ? "YouTube" : "Instagram & Facebook";
    const who = kind === "yt" ? "Google" : "Facebook";
    let start;
    try { start = await postJSON(`/api/connect/${kind === "yt" ? "youtube" : "meta"}/start`, {}); } catch (e) { return toast(e.message, "err", 7000); }
    const tips = kind === "yt"
      ? `Pick the account that owns your channel (and the right channel if Google asks). On “Google hasn't verified this app”, click <b>Advanced → Go to Clipora (unsafe)</b>, then <b>Continue</b>.`
      : `Log in to the Facebook account that manages your Page. When asked, choose <b>your Page</b> and <b>your Instagram account</b>, keep all permissions on, then <b>Continue / Save</b>.`;
    const m = openModal({
      title: `Connect ${label}`, icon: platIco(pById(kind === "yt" ? "yt" : "ig"), true),
      body: `<div class="stack">
        <div class="setting" style="align-items:flex-start;padding-top:0"><div><div class="t">1. Sign in with ${who}</div><div class="d">${tips}</div></div></div>
        <a class="btn primary" href="${esc(start.url)}" target="_blank" rel="noopener">${ic("link", "sm")}Open ${who} sign-in</a>
        <div class="setting" style="align-items:flex-start"><div><div class="t">2. Copy the address you land on</div><div class="d">Afterwards ${who} opens a page starting with <code>${esc(start.redirect_uri.split("/api")[0])}</code>. It may say “This site can't be reached”, which is normal. Copy the <b>whole address</b> from the address bar and paste it here.</div></div></div>
        <textarea class="textarea" id="cnPaste" placeholder="${esc(start.redirect_uri)}?code=…&state=…" style="min-height:70px;font-family:var(--mono);font-size:12px"></textarea>
        <span class="form-err" id="cnErr"></span></div>`,
      foot: `<button class="btn ghost" data-x2>Cancel</button><button class="btn primary" id="cnFinish">${ic("check", "sm")}Finish connecting</button>`,
    });
    $("[data-x2]", m.box).onclick = () => m.close();
    const isOnNow = (c) => kind === "yt" ? c?.yt?.connected : c?.meta?.connected;
    const was = isOnNow(App.conn);
    const poll = setInterval(async () => { if (!m.el.isConnected) return clearInterval(poll); const c = await loadConn(); if (!was && isOnNow(c)) { clearInterval(poll); m.close(); toast(`${label} connected`); draw(); } }, 3000);
    $("#cnFinish", m.box).onclick = async () => {
      const pasted = $("#cnPaste", m.box).value.trim();
      $("#cnErr", m.box).textContent = "";
      if (!pasted) { $("#cnErr", m.box).textContent = "Paste the address from step 2 first."; return; }
      const b = $("#cnFinish", m.box); b.disabled = true;
      try { await postJSON(`/api/connect/${kind === "yt" ? "youtube" : "meta"}/finish`, { pasted }); clearInterval(poll); m.close(); await loadConn(); draw(); toast(`${label} connected`); }
      catch (e) { $("#cnErr", m.box).textContent = e.message; b.disabled = false; }
    };
  }
  async function showToken(kind) {
    const isYt = kind === "yt";
    let t;
    try { const r = await api(`/api/connect/${isYt ? "youtube" : "meta"}/token`); t = isYt ? r.refresh_token : r.token; } catch (e) { return toast(e.message, "err"); }
    const name = isYt ? "YOUTUBE_REFRESH_TOKEN" : "META_TOKEN";
    const m = openModal({
      title: "Stay connected next session",
      body: `<p class="muted" style="margin:0 0 12px;line-height:1.6">Kaggle and Colab wipe the server when the session ends. Add this to your <code>clipora.env</code> as <code>${name}=…</code> (or as a secret with that name) and Clipora reconnects automatically.${isYt ? "" : " Facebook tokens last about 60 days; after that, connect again and save the new one."}</p>
        <div class="note warn" style="margin-bottom:12px">${ic("lock")}<span>This works like a password for posting to your account. Keep it only in your private clipora-keys dataset or secrets, and never share it.</span></div>
        <textarea class="textarea" readonly style="font-family:var(--mono);font-size:12px;min-height:84px">${esc(t)}</textarea>`,
      foot: `<button class="btn primary" id="tokCopy">${ic("copy", "sm")}Copy</button>`,
    });
    $("#tokCopy", m.box).onclick = async () => { try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { $("textarea", m.box).select(); } };
  }
  S.on(v, "click", async (e) => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    e.preventDefault();
    const a = b.dataset.c;
    if (a === "yt-connect") connect("yt");
    if (a === "meta-connect") connect("meta");
    if (a === "yt-token") showToken("yt");
    if (a === "meta-token") showToken("meta");
    if (a === "meta-refresh") { try { await postJSON("/api/connect/meta/refresh", {}); await loadConn(); draw(); toast("Accounts reloaded"); } catch (err) { toast(err.message, "err", 6000); } }
    if (a === "yt-disconnect" || a === "meta-disconnect") {
      const yt = a === "yt-disconnect";
      if (!(await confirmBox({ title: `Disconnect ${yt ? "YouTube" : "Instagram & Facebook"}?`, text: `Clipora will stop being able to post${yt ? "" : " to Instagram and Facebook (they share one login)"}. Posts already published stay up.`, ok: "Disconnect", danger: true }))) return;
      try { await postJSON(`/api/connect/${yt ? "youtube" : "meta"}/disconnect`, {}); await loadConn(); draw(); toast("Disconnected"); } catch (err) { toast(err.message, "err"); }
    }
  });
  S.on(bus, "conn", draw);
  draw(); loadConn();
  return () => S.done();
};

/* ======================= ANALYTICS ======================= */
Pages.analytics = function () {
  setActiveNav("analytics"); setCrumbs([{ label: "Studio", href: "#/" }, { label: "Analytics" }]);
  const S = scope();
  const st = { range: store.get("an-range", 14) };
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${ic("chart", "xs")}Performance</div><h1>Analytics</h1><p class="sub">How much you're making, and how strong the moments are.</p></div>
      <div id="anSeg">${segHTML([[7, "7 days"], [14, "14 days"], [30, "30 days"]], st.range)}</div></div>
    <div class="stats" id="anStats"></div>
    <div class="two" style="margin-top:16px">
      <div class="card pad"><div class="between"><div><h2>Clips made</h2><p class="small faint" style="margin:4px 0 0">Per day</p></div><span class="badge live" id="anTotal"></span></div><div class="chart-box" id="anChart" style="margin-top:14px"></div></div>
      <div class="card pad"><h2>Virality spread</h2><p class="small faint" style="margin:4px 0 14px">AI scores of all your clips</p><div class="stack" id="anDist"></div></div></div>
    <div class="two" style="margin-top:16px">
      <div class="card pad"><div class="between" style="margin-bottom:6px"><h2>Top clips</h2><span class="faint small">by AI score</span></div><div style="overflow:auto"><table class="table" id="anTop"></table></div></div>
      <div class="card pad"><div class="between"><div><h2>Social performance</h2><p class="small faint" style="margin:4px 0 0">Live views, likes and comments from YouTube, Instagram and Facebook</p></div><button class="icon-btn sm" id="ytRefresh" aria-label="Refresh">${ic("refresh", "sm")}</button></div>
        <div id="ytBox"><div class="skeleton" style="height:120px;border-radius:14px;margin-top:14px"></div></div></div></div>`;
  async function drawYT() {
    const box = $("#ytBox"); if (!box) return;
    const ytOn = App.conn?.yt?.connected, metaOn = App.conn?.meta?.connected;
    if (!ytOn && !metaOn) {
      box.innerHTML = `<div class="empty" style="padding:26px 6px 6px"><div class="row" style="justify-content:center;gap:8px;margin-bottom:16px">${PLATFORMS.slice(0, 3).map((p) => platIco(p, true)).join("")}</div><h3>No platform data yet</h3><p>Connect an account and publish a clip. Its real views, likes and comments show up here.</p><a class="btn sm" href="#/connections">${ic("link", "sm")}Connections</a></div>`;
      return;
    }
    const errs = [], r = { videos: [], totals: { views: 0, likes: 0, comments: 0 } };
    const add = (x, plat) => { x.videos.forEach((vd) => r.videos.push({ platform: plat, ...vd })); ["views", "likes", "comments"].forEach((k) => (r.totals[k] += x.totals[k] || 0)); };
    await Promise.all([
      ytOn && api("/api/analytics/youtube").then((x) => add(x, "yt")).catch((e) => errs.push("YouTube: " + e.message)),
      metaOn && api("/api/analytics/meta").then((x) => add(x, null)).catch((e) => errs.push("Instagram/Facebook: " + e.message)),
    ]);
    const errHTML = errs.map((e) => `<div class="note warn" style="margin-top:12px">${ic("alert")}<span>${esc(e)}</span></div>`).join("");
    if (!r.videos.length && errs.length) { box.innerHTML = errHTML; return; }
    if (!r.videos.length) { box.innerHTML = `<div class="empty" style="padding:26px 6px 6px"><div class="ico">${ic("yt", "lg")}</div><h3>Nothing published yet</h3><p>Publish a clip from any project and its numbers appear here.</p></div>`; return; }
    const t = r.totals, n = (x) => Number(x).toLocaleString();
    box.innerHTML = errHTML + `<div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px">
        ${[["Views", t.views, "eye"], ["Likes", t.likes, "flame"], ["Comments", t.comments, "type"]].map(([k, val, i]) => `<div class="card stat" style="padding:14px;box-shadow:none"><div class="k">${k}<i>${ic(i, "sm")}</i></div><div class="v" style="font-size:22px">${n(val)}</div></div>`).join("")}</div>
      <div style="overflow:auto;margin-top:12px"><table class="table"><thead><tr><th>Video</th><th>Views</th><th>Likes</th><th></th></tr></thead><tbody>
        ${[...r.videos].sort((a, b) => b.views - a.views).slice(0, 8).map((x) => `<tr data-h="#/p/${esc(x.job_id)}"><td><span class="row" style="gap:8px">${platIco(pById(x.platform || "yt"), true)}<b>${esc(x.title || x.clip_title || "")}</b>${x.privacy && x.privacy !== "public" ? ` <span class="badge warn">${esc(x.privacy)}</span>` : ""}</span></td><td class="num">${n(x.views)}</td><td class="num">${n(x.likes)}</td><td style="text-align:right"><a class="icon-btn sm" href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="Open the post">${ic("right", "sm")}</a></td></tr>`).join("")}</tbody></table></div>`;
  }
  $("#ytBox").addEventListener("click", (e) => { if (e.target.closest("a")) return; const r2 = e.target.closest("tr[data-h]"); if (r2) location.hash = r2.dataset.h; });
  $("#ytRefresh").onclick = drawYT;
  drawYT();
  const draw = () => {
    const J = App.jobs, done = J.filter((j) => j.status === "done");
    const scores = J.flatMap((j) => j.scores || []).filter((x) => x != null);
    const clips = J.reduce((a, j) => a + (j.clips_done || 0), 0);
    const mins = done.reduce((a, j) => a + (j.duration || 0), 0) / 60;
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const hot = scores.filter((s) => s >= 80).length;
    $("#anStats").innerHTML = [
      ["Clips made", clips, "scissors", `${J.length} projects`], ["Video processed", mins >= 60 ? `${(mins / 60).toFixed(1)} h` : `${Math.round(mins)} min`, "clock", "Source footage"],
      ["Avg. virality", avg ?? "—", "flame", "Across all clips"], ["High scorers", hot, "zap", "Clips scoring 80+"],
    ].map(([k, val, i, f]) => `<div class="card stat"><div class="k">${k}<i>${ic(i, "sm")}</i></div><div class="v">${val}</div><div class="f">${f}</div></div>`).join("");
    // per-day bars
    const n = st.range, today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: n }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() - (n - 1 - i)); return d; });
    const vals = days.map((d) => J.filter((j) => new Date(j.created * 1000).toDateString() === d.toDateString()).reduce((a, j) => a + (j.clips_done || 0), 0));
    $("#anTotal").textContent = `${vals.reduce((a, b) => a + b, 0)} in ${n} days`;
    const max = Math.max(4, ...vals), W = 600, H = 200, bw = W / n;
    const ticks = [0, .5, 1].map((f) => Math.round(max * f));
    $("#anChart").innerHTML = `<svg viewBox="0 0 ${W} ${H + 24}" preserveAspectRatio="none" role="img" aria-label="Clips made per day">
      <defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b58aff"/><stop offset="1" stop-color="#8b5cf6" stop-opacity=".35"/></linearGradient></defs>
      ${ticks.map((t) => `<line x1="0" x2="${W}" y1="${H - (t / max) * H}" y2="${H - (t / max) * H}" stroke="var(--line)" stroke-dasharray="3 5"/>`).join("")}
      ${vals.map((x, i) => { const h = (x / max) * H; return `<rect data-i="${i}" x="${i * bw + bw * .2}" y="${H - Math.max(h, x ? 3 : 1.5)}" width="${bw * .6}" height="${Math.max(h, x ? 3 : 1.5)}" rx="${Math.min(6, bw * .2)}" fill="${x ? "url(#bg1)" : "var(--s3)"}"/>`; }).join("")}
      ${days.map((d, i) => (n <= 14 || i % 3 === 0) ? `<text x="${i * bw + bw / 2}" y="${H + 17}" text-anchor="middle" font-size="11" fill="var(--text-3)">${n <= 7 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.getDate()}</text>` : "").join("")}
    </svg><div class="tip hidden"></div>`;
    const svg = $("#anChart svg"), tip = $("#anChart .tip");
    svg.onmousemove = (e) => {
      const r = svg.getBoundingClientRect(), i = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
      tip.classList.remove("hidden");
      tip.style.left = ((i + .5) / n) * r.width + "px"; tip.style.top = (H - (vals[i] / max) * H) / (H + 24) * r.height + "px";
      tip.innerHTML = `<b>${vals[i]}</b> clip${vals[i] === 1 ? "" : "s"} · ${days[i].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    };
    svg.onmouseleave = () => tip.classList.add("hidden");
    // distribution
    const buckets = [["90+", 90, 101, "var(--ok)"], ["80–89", 80, 90, "#7fdcae"], ["70–79", 70, 80, "var(--warn)"], ["60–69", 60, 70, "#f0a35e"], ["Below 60", 0, 60, "var(--text-3)"]];
    const tot = Math.max(1, scores.length);
    $("#anDist").innerHTML = scores.length ? buckets.map(([l, a, b, col]) => { const c = scores.filter((s) => s >= a && s < b).length; return `<div><div class="between small"><span class="muted">${l}</span><b class="num">${c}</b></div><div class="progress" style="margin-top:7px"><span style="width:${(c / tot) * 100}%;background:${col};animation:none;box-shadow:none"></span></div></div>`; }).join("")
      : `<div class="empty" style="padding:20px"><p style="margin:0">Scores appear after your first project.</p></div>`;
    const top = J.flatMap((j) => (j.best || []).map((b) => ({ ...b, job: j }))).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8);
    $("#anTop").innerHTML = top.length ? `<thead><tr><th>Clip</th><th>Project</th><th>Length</th><th>Score</th></tr></thead><tbody>${top.map((t) => `<tr data-h="#/p/${esc(t.job.id)}/edit/${t.index}"><td><b>${esc(t.title)}</b></td><td>${esc(t.job.title).slice(0, 40)}</td><td class="mono">${fmtDur(t.len)}</td><td><span class="score ${scoreClass(t.score)}" style="cursor:inherit">${t.score}</span></td></tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="faint">No clips yet</td></tr></tbody>`;
  };
  $("#anTop").addEventListener("click", (e) => { const r = e.target.closest("[data-h]"); if (r) location.hash = r.dataset.h; });
  segBind($("#anSeg .seg"), (x) => { st.range = +x; store.set("an-range", +x); draw(); });
  draw();
  S.on(bus, "jobs", draw);
  return () => S.done();
};

/* ======================= SETTINGS ======================= */
Pages.settings = function () {
  setActiveNav("settings"); setCrumbs([{ label: "Studio", href: "#/" }, { label: "Settings" }]);
  const S = scope();
  const s = App.status || {};
  const d = defaults();
  const SECS = [["general", "Appearance", "sun"], ["ai", "AI providers", "sparkles"], ["defaults", "Project defaults", "layers"], ["brand", "Brand kit", "palette"], ["youtube", "YouTube access", "cookie"], ["storage", "Storage", "hdd"], ["account", "Server & account", "server"]];
  const v = $("#view");
  v.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${ic("settings", "xs")}Your studio</div><h1>Settings</h1><p class="sub">AI providers, defaults, brand, storage and access.</p></div></div>
    <div class="set-layout"><nav class="set-nav" id="setNav">${SECS.map(([k, l, i], n) => `<a href="#/settings" data-s="${k}" class="${n ? "" : "on"}">${ic(i, "sm")}${l}</a>`).join("")}</nav>
    <div>
      <section class="card pad set-sec" id="s-general"><div class="card-h"><div><h2>Appearance</h2><p>Pick the look that suits you. Saved in this browser.</p></div></div>
        <div id="themeSeg">${segHTML([["dark", "Dark", "moon"], ["light", "Light", "sun"]], document.documentElement.dataset.theme)}</div></section>

      <section class="card pad set-sec" id="s-ai"><div class="card-h"><div><h2>AI providers</h2><p>Clipora rotates between free AI providers. When one hits its limit, the next takes over.</p></div><span class="badge live" id="aiCount"></span></div>
        <div id="provList"></div>
        <div class="note" style="margin-top:12px">${ic("key")}<span>Add keys as <b>Kaggle Secrets</b> (Add-ons → Secrets) or <b>Colab Secrets</b> (🔑 icon) with the names shown, then restart the launcher. Keys never appear in the website.</span></div></section>

      <section class="card pad set-sec" id="s-defaults"><div class="card-h"><div><h2>Project defaults</h2><p>Used every time you start a new project.</p></div></div>
        <div class="stack">
          <div class="two" style="grid-template-columns:1fr 1fr;gap:14px">
            <div class="field"><div class="label">Clips per video <span class="range-val" id="dnOut">${d.num_clips || "Auto"}</span></div><input type="range" min="0" max="100" value="${d.num_clips}" id="dn" aria-label="Clips per video (0 = Auto)"></div>
            <div class="field"><div class="label">Clip length (seconds)</div><div class="row"><input class="input" type="number" id="dmin" value="${d.min_sec}" min="5" max="180"><span class="faint">to</span><input class="input" type="number" id="dmax" value="${d.max_sec}" min="10" max="300"></div></div>
            <div class="field"><div class="label">Caption style</div><select class="select" id="dstyle">${CAPTION_STYLES.map((x) => `<option value="${x.id}" ${x.id === d.caption_style ? "selected" : ""}>${x.name}</option>`).join("")}</select></div>
            <div class="field"><div class="label">Layout</div><select class="select" id="dlayout">${LAYOUTS.filter((l) => !l.soon).map((l) => `<option value="${l.id}" ${l.id === d.reframe ? "selected" : ""}>${l.name}</option>`).join("")}</select></div>
            <div class="field"><div class="label">Language</div><select class="select" id="dlang"><option value="">Auto-detect</option>${Object.entries(LANGS).map(([k, n]) => `<option value="${k}" ${d.language === k ? "selected" : ""}>${n}</option>`).join("")}</select></div>
            <div class="field"><div class="label">Aspect ratio</div><div id="daspect">${segHTML([["9:16", "9:16"], ["1:1", "1:1"], ["16:9", "16:9"]], d.aspect || "9:16", "full")}</div></div>
          </div>
          <div>
            <div class="setting"><div><div class="t">Uppercase captions</div></div>${toggleHTML("dup", d.uppercase)}</div>
            <div class="setting"><div><div class="t">Hook title at the start</div></div>${toggleHTML("dhook", d.show_hook)}</div>
            <div class="setting"><div><div class="t">Remove filler words</div><div class="d">Cuts “um”, “uh”, “erm”</div></div>${toggleHTML("dfill", d.remove_fillers)}</div>
            <div class="setting"><div><div class="t">Remove silences</div><div class="d">Cuts pauses longer than about a second</div></div>${toggleHTML("dsil", d.remove_silences)}</div>
            <div class="setting"><div><div class="t">Progress bar</div></div>${toggleHTML("dbar", d.progress_bar)}</div>
            <div class="setting"><div><div class="t">Logo watermark</div><div class="d">Needs a logo in Brand kit</div></div>${toggleHTML("dwm", d.watermark)}</div>
          </div>
          <div class="row"><button class="btn primary" id="saveDefaults">${ic("check", "sm")}Save defaults</button><span class="faint small" id="defMsg"></span></div>
        </div></section>

      <section class="card pad set-sec" id="s-brand"><div class="card-h"><div><h2>Brand kit</h2><p>Your logo can be stamped on every clip as a watermark.</p></div></div>
        <div class="row" style="gap:18px;align-items:center;flex-wrap:wrap">
          <div class="logo-box" id="logoBox"></div>
          <div class="stack grow" style="gap:10px;min-width:220px">
            <div class="row wrap"><label class="btn">${ic("upload", "sm")}Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" class="sr" id="logoIn"></label><button class="btn ghost" id="logoDel">${ic("trash", "sm")}Remove</button></div>
            <span class="tiny faint">PNG with a transparent background looks best. Max 8 MB.</span></div></div>
        <div class="divider"></div>
        <div class="field" style="max-width:420px"><div class="label">Studio name</div><div class="row"><input class="input" id="brandName" maxlength="60" value="${esc(s.settings?.brand?.name || "")}" placeholder="My studio"><button class="btn" id="saveBrand">Save</button></div></div></section>

      <section class="card pad set-sec" id="s-youtube"><div class="card-h"><div><h2>YouTube access</h2><p>YouTube blocks many cloud servers. A cookies file from a spare Google account fixes most download errors, including age-restricted videos (the account must be 18+).</p></div><span id="ckBadge"></span></div>
        <div class="row wrap"><label class="btn primary">${ic("upload", "sm")}Upload cookies.txt<input type="file" accept=".txt,text/plain" class="sr" id="ckIn"></label><button class="btn ghost" id="ckDel">${ic("trash", "sm")}Remove</button></div>
        <div class="note" style="margin-top:14px">${ic("info")}<span>Export with the “Get cookies.txt LOCALLY” browser extension while logged in to youtube.com. Use a <b>spare</b> account, and keep the file private. Cookies expire, so upload a fresh file if downloads start failing again.</span></div></section>

      <section class="card pad set-sec" id="s-storage"><div class="card-h"><div><h2>Storage</h2><p>Projects keep their source video and clips on the server disk.</p></div><button class="btn sm ghost" id="stRefresh">${ic("refresh", "sm")}Refresh</button></div>
        <div id="stBox"><div class="skeleton" style="height:10px;border-radius:99px"></div></div></section>

      <section class="card pad set-sec" id="s-account"><div class="card-h"><div><h2>Server & account</h2><p>Where Clipora is running right now.</p></div></div>
        <div id="srvBox"></div></section>
    </div></div>`;

  /* nav */
  const nav = $("#setNav");
  nav.addEventListener("click", (e) => { const a = e.target.closest("[data-s]"); if (!a) return; e.preventDefault(); $("#s-" + a.dataset.s).scrollIntoView({ behavior: "smooth", block: "start" }); });
  const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) $$("a", nav).forEach((a) => a.classList.toggle("on", "s-" + a.dataset.s === en.target.id)); }), { rootMargin: "-20% 0px -70% 0px" });
  $$(".set-sec").forEach((x) => io.observe(x)); S.add(() => io.disconnect());

  segBind($("#themeSeg .seg"), setTheme);
  S.on(bus, "theme", () => $$("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === document.documentElement.dataset.theme)));

  /* providers */
  const drawProv = () => {
    const P = App.status?.providers || [];
    $("#aiCount").textContent = `${P.filter((p) => p.has_key).length} of ${P.length} active`;
    const label = { ready: '<span class="badge ok">Ready</span>', cooldown: '<span class="badge warn">Rate limited</span>', rejected: '<span class="badge err">Key rejected</span>', no_key: '<span class="badge">No key</span>' };
    $("#provList").innerHTML = P.map((p) => `<div class="prov"><span class="pi">${esc(p.name[0])}</span><div class="grow"><b style="text-transform:capitalize">${esc(p.name)}</b>
        <div class="tiny faint">${p.state === "cooldown" ? `Cooling down · ready in ~${fmtDur(p.cooldown_s)}` : p.has_key ? `${p.models != null ? p.models + " models · " : ""}${p.answers ? p.answers + " answers this session" : "Waiting for first use"}` : `Secret name: <code>${esc(p.secret)}</code>`}</div></div>${label[p.state] || ""}</div>`).join("")
      + `<div class="prov"><span class="pi">${ic("cpu", "sm")}</span><div class="grow"><b>Fallbacks</b><div class="tiny faint">Local Qwen model on the GPU, then a rule-based picker. Clipping never stops.</div></div><span class="badge ok">Always on</span></div>`;
  };
  drawProv(); S.on(bus, "status", drawProv);

  /* defaults */
  const dd = { ...d };
  bindRange($("#dn"), (n) => { dd.num_clips = n; $("#dnOut").textContent = n || "Auto"; });
  segBind($("#daspect .seg"), (a) => (dd.aspect = a));
  [["dup", "uppercase"], ["dhook", "show_hook"], ["dfill", "remove_fillers"], ["dsil", "remove_silences"], ["dbar", "progress_bar"], ["dwm", "watermark"]].forEach(([id, k]) => bindToggle($("#" + id), (x) => (dd[k] = x)));
  $("#saveDefaults").onclick = async () => {
    Object.assign(dd, { min_sec: +$("#dmin").value, max_sec: +$("#dmax").value, caption_style: $("#dstyle").value, reframe: $("#dlayout").value, language: $("#dlang").value || null });
    if (!(dd.max_sec >= dd.min_sec + 5)) return toast("Max length must be at least 5 seconds more than min", "err");
    try { await postJSON("/api/settings", { defaults: dd }, "PUT"); await refreshStatus(); toast("Defaults saved"); $("#defMsg").textContent = "Saved — new projects will use these."; }
    catch (e) { toast(e.message, "err"); }
  };

  /* brand */
  let logoShown = null;
  const drawLogo = (force) => {
    const has = !!App.status?.logo;
    if (has === logoShown && force !== true) return;
    logoShown = has;
    $("#logoBox").innerHTML = has ? `<img src="/brand/logo.png?t=${Date.now()}" alt="Brand logo">` : `<span class="faint">${ic("image", "lg")}</span>`;
    $("#logoDel").disabled = !has;
  };
  drawLogo(); S.on(bus, "status", drawLogo);
  $("#logoIn").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try { await api("/api/brand/logo", { method: "POST", body: fd }); await refreshStatus(); drawLogo(true); toast("Logo uploaded"); }
    catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  };
  $("#logoDel").onclick = async () => { try { await api("/api/brand/logo", { method: "DELETE" }); await refreshStatus(); drawLogo(); toast("Logo removed"); } catch (err) { toast(err.message, "err"); } };
  $("#saveBrand").onclick = async () => {
    try { await postJSON("/api/settings", { brand: { name: $("#brandName").value } }, "PUT"); await refreshStatus(); toast("Saved"); } catch (e) { toast(e.message, "err"); }
  };

  /* cookies */
  const drawCk = () => {
    const has = App.status?.cookies;
    $("#ckBadge").innerHTML = has ? `<span class="badge ok">${ic("check")}Cookies added</span>` : '<span class="badge">Not added</span>';
    $("#ckDel").disabled = !has;
  };
  drawCk(); S.on(bus, "status", drawCk);
  $("#ckIn").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try { await api("/api/cookies", { method: "POST", body: fd }); await refreshStatus(); toast("Cookies saved"); } catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  };
  $("#ckDel").onclick = async () => {
    if (!(await confirmBox({ title: "Remove cookies?", text: "YouTube downloads may start failing again on this server.", ok: "Remove", danger: true }))) return;
    try { await api("/api/cookies", { method: "DELETE" }); await refreshStatus(); toast("Cookies removed"); } catch (err) { toast(err.message, "err"); }
  };

  /* storage */
  async function drawStorage() {
    let x;
    try { x = await api("/api/storage"); } catch (e) { $("#stBox").innerHTML = `<p class="faint">${esc(e.message)}</p>`; return; }
    const used = x.disk_total - x.disk_free, other = Math.max(0, used - x.projects_bytes - x.cache_bytes);
    const pct = (b) => (b / x.disk_total) * 100;
    $("#stBox").innerHTML = `
      <div class="between small"><b>${fmtBytes(x.projects_bytes)} in projects</b><span class="faint">${fmtBytes(x.disk_free)} free of ${fmtBytes(x.disk_total)}</span></div>
      <div class="meter" style="margin-top:10px"><i style="width:${pct(x.projects_bytes)}%;background:var(--accent)"></i><i style="width:${pct(x.cache_bytes)}%;background:var(--cyan)"></i><i style="width:${pct(other)}%;background:var(--s4)"></i></div>
      <div class="row wrap tiny faint" style="margin-top:8px;gap:14px"><span class="row" style="gap:6px"><i class="dot" style="background:var(--accent);box-shadow:none"></i>Projects</span><span class="row" style="gap:6px"><i class="dot" style="background:var(--cyan);box-shadow:none"></i>Models & cache ${fmtBytes(x.cache_bytes)}</span><span class="row" style="gap:6px"><i class="dot" style="background:var(--s4);box-shadow:none"></i>Other</span></div>
      <div class="divider"></div>
      <div class="row wrap"><span class="small">Delete finished projects older than</span><select class="select" id="cleanDays" style="width:auto;min-height:34px"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="0">any age</option></select>
        <button class="btn danger sm" id="cleanBtn">${ic("trash", "sm")}Clean up</button></div>
      ${x.projects.length ? `<div style="overflow:auto;margin-top:14px"><table class="table"><thead><tr><th>Project</th><th>Status</th><th>Size</th><th></th></tr></thead><tbody>${x.projects.sort((a, b) => b.bytes - a.bytes).map((p) => `<tr data-id="${esc(p.id)}"><td><b>${esc(p.title).slice(0, 60)}</b><div class="tiny faint">${ago(p.created)}</div></td><td>${statusBadge(p)}</td><td class="mono">${fmtBytes(p.bytes)}</td><td style="text-align:right"><button class="icon-btn sm" data-del="${esc(p.id)}" aria-label="Delete project" ${p.status === "running" ? "disabled" : ""}>${ic("trash", "sm")}</button></td></tr>`).join("")}</tbody></table></div>` : ""}`;
    $("#cleanBtn").onclick = async () => {
      const days = +$("#cleanDays").value;
      if (!(await confirmBox({ title: "Clean up old projects?", text: `Finished and failed projects ${days ? `older than ${days} day${days === 1 ? "" : "s"}` : "of any age"} will be permanently deleted with their clips. Running projects are kept.`, ok: "Delete them", danger: true }))) return;
      try { const r = await postJSON("/api/storage/clean", { older_than_days: days }); toast(`Removed ${r.removed.length} project${r.removed.length === 1 ? "" : "s"} · freed ${fmtBytes(r.freed_bytes)}`); refreshJobs(); drawStorage(); }
      catch (e) { toast(e.message, "err"); }
    };
  }
  $("#stBox").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]"); if (b) { e.stopPropagation(); } else { const r = e.target.closest("tr[data-id]"); if (r) location.hash = `#/p/${r.dataset.id}`; return; }
    if (!(await confirmBox({ title: "Delete this project?", text: "Its source video and clips will be deleted. This can't be undone.", ok: "Delete", danger: true }))) return;
    try { await api(`/api/jobs/${b.dataset.del}`, { method: "DELETE" }); toast("Project deleted"); refreshJobs(); drawStorage(); } catch (err) { toast(err.message, "err"); }
  });
  $("#stRefresh").onclick = drawStorage;
  drawStorage();

  /* server */
  const drawSrv = () => {
    const x = App.status || {};
    $("#srvBox").innerHTML = `
      <div class="stat-line"><span class="k">${ic(x.gpu ? "zap" : "cpu")}Hardware</span><span class="v">${x.gpu ? "GPU (fast)" : "CPU only (slow)"}</span></div>
      <div class="stat-line"><span class="k">${ic("hdd")}Free disk</span><span class="v">${x.disk_free_gb} GB</span></div>
      <div class="stat-line"><span class="k">${ic("layers")}Queue</span><span class="v">${x.queue} waiting</span></div>
      <div class="stat-line"><span class="k">${ic("lock")}Password</span><span class="v">${App.me?.auth_required ? '<span class="badge ok">Protected</span>' : '<span class="badge warn">Off — set APP_PASSWORD</span>'}</span></div>
      ${App.me?.auth_required ? `<div style="margin-top:14px"><button class="btn danger" id="logout">${ic("logout", "sm")}Log out</button></div>` : ""}`;
    const lo = $("#logout"); if (lo) lo.onclick = async () => { await postJSON("/api/logout", {}); location.reload(); };
  };
  drawSrv(); S.on(bus, "status", drawSrv);
  refreshStatus();
  return () => S.done();
};
