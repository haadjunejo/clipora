/* Clipora core: helpers, icons, API, toasts, modals, popovers. Plain JS, no build step. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- formatting ---------- */
const fmtDur = (t) => {
  t = Math.max(0, Math.round(+t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};
const fmtTC = (t) => { // 1:05.3
  t = Math.max(0, +t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};
const parseTC = (v) => {
  v = String(v).trim();
  if (!v) return NaN;
  if (v.includes(":")) { const p = v.split(":").map(Number); return p.reduce((a, x) => a * 60 + x, 0); }
  return +v;
};
const fmtBytes = (b) => {
  b = +b || 0;
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const ago = (ts) => {
  const d = (Date.now() / 1000 - ts);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const scoreClass = (s) => (s >= 80 ? "hi" : s >= 60 ? "mid" : "lo");
const LANGS = { en: "English", ur: "Urdu", hi: "Hindi", ar: "Arabic", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", tr: "Turkish", id: "Indonesian", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese", it: "Italian", bn: "Bengali", pa: "Punjabi", sd: "Sindhi", fa: "Persian" };

/* ---------- storage (never trusted, never required) ---------- */
const store = {
  get(k, d = null) { try { const v = localStorage.getItem("clipora-" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("clipora-" + k, JSON.stringify(v)); } catch { } },
};

/* ---------- icons (Lucide-style line icons, drawn for this app) ---------- */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7h2a5.6 5.6 0 0 0 5.4-5.6C22 6 17.5 2 12 2z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z"/><path d="M8.5 8.5h.01M16 15.5h.01M12 12h.01M11 17h.01M7 14h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  wand: '<path d="m15 4 5 5L9 20l-5-5z"/><path d="M14 5l5 5M5 2v4M3 4h4M19 15v4M17 17h4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  hdd: '<path d="M22 12H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/><path d="M6 16h.01M10 16h.01"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  checksq: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
  skipb: '<path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/>',
  skipf: '<path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/>',
  vol: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  bracketL: '<path d="M9 4H5v16h4"/><path d="M14 12h6M17 9l3 3-3 3"/>',
  bracketR: '<path d="M15 4h4v16h-4"/><path d="M10 12H4M7 9l-3 3 3 3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.4 1.3 1.5 2.8 2.5 2.8z"/>',
  yt: '<rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor" stroke="none" opacity=".001"/><path d="M10 9v6l5-3z" fill="currentColor" stroke="none"/><rect x="2.5" y="5.5" width="19" height="13" rx="4"/>',
  ig: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>',
  fb: '<path d="M15 3h-2.5A4.5 4.5 0 0 0 8 7.5V10H5.5v4H8v7h4v-7h3l.5-4H12V7.8c0-.5.3-.8.8-.8H15z"/>',
  tt: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.4 2.6 2.2 4.5 5 4.7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>',
};
const ic = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/* ---------- API ---------- */
const bus = new EventTarget();
async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, { credentials: "same-origin", ...opts }); }
  catch { throw new Error("Can't reach the server. Is the notebook still running?"); }
  if (res.status === 401 && path !== "/api/login") { bus.dispatchEvent(new Event("auth")); throw new Error("Please log in"); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}
const postJSON = (path, body, method = "POST") => api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------- toasts ---------- */
function toast(msg, kind = "ok", ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${ic(kind === "err" ? "alert" : kind === "info" ? "info" : "check")}<span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 260); }, ms);
}

/* ---------- modals ---------- */
const layers = [];
function openModal({ title, body = "", foot = "", wide = false, icon = "", onClose } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-h">${icon}<h2>${esc(title)}</h2><button class="icon-btn sm" data-x aria-label="Close">${ic("x", "sm")}</button></div>
      <div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ""}</div>`;
  const m = { el: ov, box: ov.firstElementChild, close() { if (!ov.isConnected) return; ov.remove(); layers.splice(layers.indexOf(m), 1); onClose && onClose(); } };
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) m.close(); });
  $("[data-x]", ov).addEventListener("click", () => m.close());
  $("#layer").appendChild(ov);
  layers.push(m);
  setTimeout(() => { const f = $("input,textarea,select", m.box) || $("[data-x]", m.box); f && f.focus(); }, 30);
  return m;
}
function confirmBox({ title, text, ok = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title, body: `<p class="muted" style="margin:0;line-height:1.6">${text}</p>`,
      foot: `<button class="btn ghost" data-no>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-yes>${esc(ok)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    $("[data-no]", m.box).onclick = () => m.close();
    $("[data-yes]", m.box).onclick = () => { done = true; m.close(); resolve(true); };
  });
}
let popEl = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
function openPop(anchor, html, { width = 230 } = {}) {
  closePop();
  const r = anchor.getBoundingClientRect();
  popEl = document.createElement("div");
  popEl.className = "pop";
  popEl.style.width = width + "px";
  popEl.innerHTML = html;
  document.body.appendChild(popEl);
  const h = popEl.offsetHeight;
  let left = clamp(r.right - width, 8, innerWidth - width - 8);
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  popEl.style.left = left + "px"; popEl.style.top = top + "px";
  return popEl;
}
document.addEventListener("mousedown", (e) => { if (popEl && !popEl.contains(e.target)) closePop(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (popEl) return closePop();
  if (layers.length) layers[layers.length - 1].close();
});

/* ---------- small UI builders ---------- */
const toggleHTML = (id, on, disabled = false) => `<button type="button" class="toggle" role="switch" id="${id}" aria-checked="${!!on}" ${disabled ? "disabled" : ""}></button>`;
function bindToggle(el, fn) {
  el.addEventListener("click", () => {
    if (el.disabled) return;
    const v = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", v);
    fn && fn(v);
  });
}
const isOn = (el) => el && el.getAttribute("aria-checked") === "true";
function paintRange(r) { r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%"); }
function bindRange(r, fn) { paintRange(r); r.addEventListener("input", () => { paintRange(r); fn && fn(+r.value); }); }
function segBind(root, fn) {
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]"); if (!b || b.disabled) return;
    $$("button", root).forEach((x) => x.classList.toggle("on", x === b));
    fn(b.dataset.v);
  });
}
const segHTML = (opts, val, cls = "") => `<div class="seg ${cls}">${opts.map(([v, l, i]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(val) ? "on" : ""}">${i ? ic(i, "sm") : ""}${esc(l)}</button>`).join("")}</div>`;

/* ---------- caption style catalogue (mirrors clipora/render.py) ---------- */
const CAPTION_STYLES = [
  { id: "bold_yellow", name: "Bold Pop", hi: "#FFE500", text: "#FFFFFF" },
  { id: "karaoke", name: "Karaoke", hi: "#B58AFF", text: "#FFFFFF" },
  { id: "boxed", name: "Boxed", hi: "#88FF00", text: "#FFFFFF" },
  { id: "neon", name: "Neon", hi: "#3CF0FF", text: "#FFFFFF" },
  { id: "minimal", name: "Minimal", hi: null, text: "#FFFFFF" },
  { id: "none", name: "No captions", hi: null, text: "#FFFFFF" },
];
const styleById = (id) => CAPTION_STYLES.find((s) => s.id === id) || CAPTION_STYLES[0];
function styleThumb(st) {
  if (st.id === "none") return `<div class="scr" style="place-items:center;padding:0"><span style="font-size:10px;color:rgba(255,255,255,.55);font-weight:600">Off</span></div>`;
  const words = st.id === "karaoke" ? `<span style="color:${st.hi}">THIS IS</span> HOW` : st.id === "minimal" ? "this is how" : `THIS <span style="color:${st.hi}">IS</span> HOW`;
  return `<div class="scr" style="container-type:inline-size"><div class="cap st-${st.id}" style="position:static;transform:none;font-size:${st.id === "bold_yellow" ? 15 : 12}cqw">${st.id === "boxed" ? `<span class="line">${words}</span>` : words}</div></div>`;
}
const LAYOUTS = [
  { id: "face", name: "Face track", icon: '<i style="inset:0;background:linear-gradient(180deg,transparent 30%,currentColor 30% 62%,transparent 62%);opacity:.25"></i><i style="left:9px;top:12px;width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor"></i><i style="left:6px;top:24px;width:16px;height:10px;border-radius:8px 8px 0 0;border:1.5px solid currentColor;border-bottom:0"></i>' },
  { id: "blur", name: "Blur fill", icon: '<i style="inset:0;background:currentColor;opacity:.18;filter:blur(2px)"></i><i style="left:0;right:0;top:14px;height:15px;border-top:1.5px solid currentColor;border-bottom:1.5px solid currentColor;background:currentColor;opacity:.35"></i>' },
  { id: "center", name: "Center crop", icon: '<i style="left:7px;right:7px;top:0;bottom:0;border-left:1.5px dashed currentColor;border-right:1.5px dashed currentColor"></i>' },
  { id: "split", name: "Split (streams)", icon: '<i style="left:0;right:0;top:20px;border-top:1.5px solid currentColor"></i>' },
];
const layoutCardsHTML = (val) => LAYOUTS.map((l) => `<button type="button" class="layout-card ${l.id === val ? "on" : ""}" data-v="${l.id}" ${l.soon ? "disabled" : ""}>
    <span class="lp">${l.icon}</span>${esc(l.name)}${l.soon ? '<span class="badge soon">SOON</span>' : ""}</button>`).join("");

/* ---------- platforms (publishing integrations are not connected yet) ---------- */
const PLATFORMS = [
  { id: "yt", name: "YouTube Shorts", short: "YouTube", titleMax: 100, textMax: 5000, notes: ["Signs in with Google (OAuth) and uploads through the YouTube Data API.", "Until Google reviews the app, uploads may be limited to private videos.", "Shorts must be vertical and up to 3 minutes long."] },
  { id: "ig", name: "Instagram Reels", short: "Instagram", titleMax: 0, textMax: 2200, notes: ["Needs an Instagram Business or Creator account.", "That account must be linked to your Facebook Page.", "Up to about 50 posts a day (Meta's rule)."] },
  { id: "fb", name: "Facebook Reels", short: "Facebook", titleMax: 255, textMax: 63206, notes: ["Posts Reels to a Facebook Page you manage.", "Reels must be 90 seconds or shorter.", "Uses the same Facebook login as Instagram."] },
  { id: "tt", name: "TikTok", short: "TikTok", titleMax: 0, textMax: 2200, soon: true, notes: ["TikTok requires an HTTPS website you own, plus privacy and terms pages.", "Before TikTok approves the app, posts can only be private or drafts.", "Coming after the permanent server and link are set up."] },
];
const platIco = (p, sm = false) => `<span class="plat-ico ${p.id} ${sm ? "sm" : ""}">${ic(p.id)}</span>`;
