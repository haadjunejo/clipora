/* Clipora shell: navigation, router, live status, theme, command palette, login, boot. */
"use strict";

const App = { status: null, jobs: [], me: null, cleanup: null, route: null, guard: null, prevStatus: {} };

const NAV = [
  { href: "#/", key: "home", label: "Home", icon: "home" },
  { href: "#/projects", key: "projects", label: "Projects", icon: "film", count: true },
  { href: "#/analytics", key: "analytics", label: "Analytics", icon: "chart" },
];
const NAV2 = [
  { href: "#/calendar", key: "calendar", label: "Calendar", icon: "calendar" },
  { href: "#/connections", key: "connections", label: "Connections", icon: "link", pill: "SETUP", pillId: "connPill" },
  { href: "#/settings", key: "settings", label: "Settings", icon: "settings" },
];

function renderNav() {
  const item = (n) => `<a href="${n.href}" data-key="${n.key}">${ic(n.icon)}${esc(n.label)}${n.count ? `<span class="count" id="navCount">${App.jobs.length || ""}</span>` : ""}${n.pill ? `<span class="pill" id="${n.pillId || ""}">${n.pill}</span>` : ""}</a>`;
  $("#sideNav").innerHTML = NAV.map(item).join("");
  $("#sideNav2").innerHTML = NAV2.map(item).join("");
  $("#bottomNav").innerHTML = [
    { href: "#/", key: "home", label: "Home", icon: "home" },
    { href: "#/projects", key: "projects", label: "Projects", icon: "film" },
    { href: "#/", key: "new", label: "", icon: "plus", fab: true },
    { href: "#/calendar", key: "calendar", label: "Calendar", icon: "calendar" },
    { href: "#/settings", key: "settings", label: "Settings", icon: "settings" },
  ].map((n) => `<a href="${n.href}" data-key="${n.key}" class="${n.fab ? "fab" : ""}" ${n.fab ? 'aria-label="New project" data-new' : ""}>${ic(n.icon)}${n.label ? esc(n.label) : ""}</a>`).join("");
  $("#menuBtn").innerHTML = ic("menu");
  $("#paletteBtn").innerHTML = `${ic("search", "sm")}<span>Search or jump to…</span><span class="kbd">Ctrl K</span>`;
  $("#newBtn").innerHTML = `${ic("plus", "sm")}New project`;
}
function setActiveNav(key) {
  $$(".nav a, #bottomNav a:not(.fab)").forEach((a) => a.classList.toggle("active", a.dataset.key === key));
}
function setCrumbs(parts) {
  $("#crumbs").innerHTML = parts.map((p, i) => {
    const last = i === parts.length - 1;
    const sep = i ? ic("right") : "";
    return sep + (last ? `<b>${esc(p.label)}</b>` : `<a href="${p.href}" class="${i === 0 ? "hide-xs" : ""}">${esc(p.label)}</a>`);
  }).join("");
  document.title = (parts.length ? parts[parts.length - 1].label + " · " : "") + "Clipora";
}

/* ---------- theme ---------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  try { localStorage.setItem("clipora-theme", t); } catch { }
  $('meta[name="theme-color"]').content = t === "light" ? "#f6f5fa" : "#0b0b11";
  const icon = ic(t === "light" ? "moon" : "sun", "sm");
  $("#themeBtn").innerHTML = icon; $("#themeBtn2").innerHTML = icon;
  bus.dispatchEvent(new Event("theme"));
}
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

/* ---------- live status ---------- */
async function refreshStatus() {
  try { App.status = await api("/api/status"); } catch { return; }
  const s = App.status;
  const ai = s.providers.filter((p) => p.has_key).length;
  const running = App.jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  $("#serverCard").innerHTML = `
    <div class="row1"><span class="row"><i class="dot ${running ? "live" : ""}"></i>${running ? "Working…" : "Studio online"}</span>
      <span class="faint tiny">${s.disk_free_gb} GB free</span></div>
    <div class="meta">
      <span class="chip" title="${s.gpu ? "GPU available — fast transcription" : "No GPU — transcription will be slow"}">${ic(s.gpu ? "zap" : "cpu")}${s.gpu ? "GPU" : "CPU only"}</span>
      <span class="chip" title="AI providers with a key">${ic("sparkles")}${ai ? `${ai} AI` : "Local AI"}</span>
      <span class="chip" title="Projects waiting">${ic("layers")}Queue ${s.queue}</span>
    </div>`;
  $("#topStatus").innerHTML = `<i class="dot ${running ? "live" : s.gpu ? "" : "warn"}"></i>${running ? `${running} processing` : s.gpu ? "GPU ready" : "CPU mode"}`;
  const name = (s.settings.brand && s.settings.brand.name) || "My studio";
  $("#studioName").textContent = name;
  $("#avatar").textContent = name.trim()[0]?.toUpperCase() || "C";
  bus.dispatchEvent(new Event("status"));
}
async function refreshJobs() {
  try { App.jobs = await api("/api/jobs"); } catch { return; }
  const c = $("#navCount"); if (c) c.textContent = App.jobs.length || "";
  // tell the user when something finishes in the background
  for (const j of App.jobs) {
    const before = App.prevStatus[j.id];
    if (before && before !== j.status && (before === "running" || before === "queued")) {
      if (j.status === "done") toast(`“${j.title}” is ready — ${j.clips_done} clips`, "ok", 5000);
      if (j.status === "error") toast(`“${j.title}” failed`, "err", 5000);
    }
    App.prevStatus[j.id] = j.status;
  }
  bus.dispatchEvent(new Event("jobs"));
}

/* ---------- connected accounts ---------- */
async function loadConn() {
  try { App.conn = await api("/api/connections"); } catch { return App.conn; }
  const pill = $("#connPill");
  if (pill) {
    const yt = App.conn.yt || {}, mt = App.conn.meta || {};
    const live = [yt.connected, mt.connected && mt.ig, mt.connected && mt.page].filter(Boolean).length;
    pill.textContent = live ? `LIVE ${live}` : yt.configured || mt.configured ? "CONNECT" : "SETUP";
    pill.style.cssText = live ? "background:rgba(86,214,154,.12);color:var(--ok)" : "";
  }
  bus.dispatchEvent(new Event("conn"));
  return App.conn;
}

/* ---------- router ---------- */
const ROUTES = [
  [/^#?\/?$/, () => Pages.home()],
  [/^#\/projects$/, () => Pages.projects()],
  [/^#\/p\/([\w-]+)\/edit\/(\d+)$/, (m) => Editor.open(m[1], +m[2])],
  [/^#\/p\/([\w-]+)$/, (m) => Pages.project(m[1])],
  [/^#\/calendar$/, () => Pages.calendar()],
  [/^#\/connections$/, () => Pages.connections()],
  [/^#\/analytics$/, () => Pages.analytics()],
  [/^#\/settings$/, () => Pages.settings()],
];
async function route() {
  const full = location.hash || "#/";
  const [hash, qs] = full.split("?");
  App.query = new URLSearchParams(qs || "");
  if (App.guard && App.route !== full) {
    const ok = await App.guard();
    if (!ok) { history.replaceState(null, "", App.route); return; }
  }
  App.guard = null;
  if (App.cleanup) { try { App.cleanup(); } catch (e) { console.error(e); } }
  App.cleanup = null;
  App.route = full;
  closePop();
  while (layers.length) layers[layers.length - 1].close();
  $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("open");
  const view = $("#view");
  view.className = "view";
  view.innerHTML = "";
  window.scrollTo(0, 0);
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) { App.cleanup = fn(m) || null; return; }
  }
  view.innerHTML = `<div class="empty card">${'<div class="ico">' + ic("alert") + "</div>"}<h3>Page not found</h3><p>That link doesn't go anywhere.</p><a class="btn primary" href="#/">Go home</a></div>`;
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if (App.guard && Editor.isDirty && Editor.isDirty()) { e.preventDefault(); e.returnValue = ""; } });

/* ---------- command palette ---------- */
function openPalette() {
  if ($(".palette")) return;
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="palette" role="dialog" aria-label="Search"><div class="in">${ic("search")}<input placeholder="Search projects or type a command…" aria-label="Search"><span class="kbd">Esc</span></div><div class="list"></div></div>`;
  const m = { el: ov, close() { ov.remove(); layers.splice(layers.indexOf(m), 1); } };
  layers.push(m);
  $("#layer").appendChild(ov);
  const input = $("input", ov), list = $(".list", ov);
  let items = [], idx = 0;
  const cmds = [
    { label: "New project", icon: "plus", run: () => { location.hash = "#/"; setTimeout(() => $("#urlInput")?.focus(), 80); } },
    { label: "All projects", icon: "film", run: () => (location.hash = "#/projects") },
    { label: "Analytics", icon: "chart", run: () => (location.hash = "#/analytics") },
    { label: "Content calendar", icon: "calendar", run: () => (location.hash = "#/calendar") },
    { label: "Connections", icon: "link", run: () => (location.hash = "#/connections") },
    { label: "Settings", icon: "settings", run: () => (location.hash = "#/settings") },
    { label: "Toggle light / dark", icon: "sun", run: toggleTheme },
  ];
  function draw() {
    const q = input.value.trim().toLowerCase();
    const projs = App.jobs.filter((j) => !q || (j.title || "").toLowerCase().includes(q)).slice(0, 8)
      .map((j) => ({ label: j.title, icon: "film", right: j.status === "done" ? `${j.clips_done} clips` : j.status, run: () => (location.hash = `#/p/${j.id}`) }));
    const cs = cmds.filter((c) => !q || c.label.toLowerCase().includes(q));
    items = [...cs, ...projs]; idx = clamp(idx, 0, Math.max(0, items.length - 1));
    let html = "";
    if (cs.length) html += `<div class="grp-l">Go to</div>` + cs.map((c, i) => row(c, i)).join("");
    if (projs.length) html += `<div class="grp-l">Projects</div>` + projs.map((c, i) => row(c, i + cs.length)).join("");
    list.innerHTML = html || `<div class="empty" style="padding:28px"><p style="margin:0">Nothing matches “${esc(q)}”.</p></div>`;
  }
  const row = (c, i) => `<button class="it ${i === idx ? "on" : ""}" data-i="${i}">${ic(c.icon)}<span>${esc(c.label)}</span>${c.right ? `<span class="r">${esc(c.right)}</span>` : ""}</button>`;
  const go = (i) => { const it = items[i]; if (!it) return; m.close(); it.run(); };
  input.addEventListener("input", () => { idx = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { idx = (idx + 1) % Math.max(1, items.length); draw(); e.preventDefault(); }
    if (e.key === "ArrowUp") { idx = (idx - 1 + items.length) % Math.max(1, items.length); draw(); e.preventDefault(); }
    if (e.key === "Enter") go(idx);
  });
  list.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) go(+b.dataset.i); });
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) m.close(); });
  draw(); input.focus();
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
});

/* ---------- login ---------- */
function showLogin() {
  if ($(".login")) return;
  const el = document.createElement("div");
  el.className = "login";
  el.innerHTML = `<div class="card box">
      <svg class="mark" viewBox="0 0 40 40"><use href="#logo-mark"/></svg>
      <div class="eyebrow">Private AI video studio</div>
      <h1 style="margin-top:10px">Welcome back.</h1>
      <p class="sub">Enter your studio password to open Clipora.</p>
      <form>
        <div class="field"><label class="label" for="pw">Studio password</label>
          <input class="input" id="pw" type="password" autocomplete="current-password" placeholder="••••••••" required></div>
        <div class="form-err" id="pwErr" role="alert"></div>
        <button class="btn primary lg block">${ic("lock", "sm")}Unlock studio</button>
      </form>
      <p class="tiny faint" style="margin-top:18px">Single-user workspace · Your videos stay on your server</p></div>`;
  document.body.appendChild(el);
  $("#boot")?.remove();
  $("#pw", el).focus();
  $("form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#pwErr", el).textContent = "";
    const btn = $("button", el); btn.disabled = true;
    try {
      await postJSON("/api/login", { password: $("#pw", el).value });
      el.remove(); start();
    } catch (err) { $("#pwErr", el).textContent = err.message; $("#pw", el).select(); }
    finally { btn.disabled = false; }
  });
}
bus.addEventListener("auth", showLogin);

/* ---------- boot ---------- */
let started = false;
async function start() {
  if (started) return route();
  started = true;
  await Promise.all([refreshStatus(), refreshJobs(), loadConn()]);
  route();
  setInterval(refreshJobs, 6000);
  setInterval(refreshStatus, 15000);
}
async function boot() {
  renderNav();
  setTheme(document.documentElement.dataset.theme || "dark");
  $("#themeBtn").onclick = toggleTheme; $("#themeBtn2").onclick = toggleTheme;
  $("#paletteBtn").onclick = openPalette;
  $("#menuBtn").onclick = () => { $("#sidebar").classList.add("open"); $("#scrim").classList.add("open"); };
  $("#scrim").onclick = () => { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("open"); };
  $("#bottomNav").addEventListener("click", (e) => {
    if (e.target.closest("[data-new]")) setTimeout(() => $("#urlInput")?.focus(), 120);
  });
  try { App.me = await api("/api/me"); }
  catch (e) {
    $("#boot").innerHTML = `<div class="empty"><div class="ico">${ic("alert")}</div><h3>Can't reach Clipora</h3><p>${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  if (App.me.auth_required && !App.me.logged_in) return showLogin();
  await start();
  const b = $("#boot"); if (b) { b.style.opacity = 0; setTimeout(() => b.remove(), 350); }
}
boot();
