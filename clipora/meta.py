"""Instagram + Facebook (Meta): Facebook Login for Business, Page/Instagram accounts, Reels upload, stats.

Secrets: META_APP_ID, META_APP_SECRET, META_CONFIG_ID (Facebook Login for Business configuration),
optional META_TOKEN (long-lived user token, to stay connected across Kaggle sessions), optional PUBLIC_URL.
"""
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlencode

import requests

from . import config
from .utils import get_secret
from . import youtube


def parse_pasted(text):
    """Same "paste the address you land on" flow as YouTube."""
    try:
        return youtube.parse_pasted(text)
    except youtube.YouTubeError as e:
        raise MetaError(str(e).replace("Google", "Facebook"))

VERSION = os.environ.get("META_GRAPH_VERSION", "v23.0")
GRAPH = os.environ.get("META_GRAPH_URL", "https://graph.facebook.com") + "/" + VERSION
DIALOG = os.environ.get("META_DIALOG_URL", "https://www.facebook.com") + f"/{VERSION}/dialog/oauth"
CALLBACK_PATH = "/api/connect/meta/callback"
STORE = config.DATA / "connections" / "meta.json"
SCOPES = ("pages_show_list,pages_read_engagement,pages_manage_posts,read_insights,"
          "instagram_basic,instagram_content_publish,instagram_manage_insights,business_management")

_lock = threading.RLock()
_states = {}


class MetaError(RuntimeError):
    pass


def app():
    return get_secret("META_APP_ID"), get_secret("META_APP_SECRET"), get_secret("META_CONFIG_ID")


def redirect_uri():
    base = (get_secret("PUBLIC_URL") or "").strip().rstrip("/")
    return (base or "http://localhost:8000") + CALLBACK_PATH


def _load():
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(d):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
    tmp.replace(STORE)


def _json(r):
    try:
        return r.json()
    except ValueError:
        return {}


IG_SUBCODES = {  # Instagram publishing errors (error_subcode) → plain words
    2207042: "Instagram's 24-hour posting limit is reached. Try again tomorrow.",
    2207051: "Instagram blocked this post as possible spam (too many posts too fast, or reposted content). "
             "Wait a few hours, post fewer clips, and avoid reposting other creators' videos.",
    2207050: "The Instagram account is restricted or inactive. Open the Instagram app and check for warnings.",
    2207026: "Instagram doesn't accept this video format. Re-render the clip and try again.",
    2207008: "Instagram's upload expired before publishing. Press Retry.",
    2207001: "Instagram had a server error. Press Retry in a few minutes.",
    2207003: "Instagram timed out fetching the video. Press Retry.",
    2207032: "Instagram couldn't create the post. Press Retry in a few minutes.",
}


def _err(r):
    j = _json(r)
    e = j.get("error") or {}
    dbg = j.get("debug_info") or {}  # the upload server (rupload) reports errors this way
    msg = (e.get("error_user_msg") or e.get("message") or dbg.get("message")
           or (r.text[:300] if r.text else f"HTTP {r.status_code}"))
    title = e.get("error_user_title")
    code, sub = e.get("code"), e.get("error_subcode")
    if sub in IG_SUBCODES:
        return f"{IG_SUBCODES[sub]} (Meta: {msg})"
    if code == 190:
        return "Facebook ended the connection (token expired or password changed). Press Connect again."
    if code in (10, 200) or "permission" in str(msg).lower():
        return (f"Facebook says a permission is missing: {msg}. In your Meta app, make sure the Configuration has "
                f"all the permissions, then Disconnect and Connect again.")
    if code in (4, 17, 32, 613) or sub == 2207042:
        return "Meta's posting limit was reached (Instagram allows about 50 posts a day). Try again later."
    kind = f" [{dbg.get('type')}]" if dbg.get("type") else ""
    return f"Meta error {code or r.status_code}{'/' + str(sub) if sub else ''}{kind}: {title + ' — ' if title else ''}{msg}"


def _get(path, token, **params):
    r = requests.get(f"{GRAPH}/{path.lstrip('/')}", params={**params, "access_token": token}, timeout=60)
    if r.status_code != 200:
        raise MetaError(_err(r))
    return r.json()


def _post(path, token, **params):
    r = requests.post(f"{GRAPH}/{path.lstrip('/')}", data={**params, "access_token": token}, timeout=120)
    if r.status_code != 200:
        raise MetaError(_err(r))
    return r.json()


# ---------------- sign-in ----------------
def auth_url():
    aid, asec, cfg = app()
    if not aid or not asec:
        raise MetaError("Add META_APP_ID and META_APP_SECRET (and META_CONFIG_ID) to your secrets / clipora.env, "
                        "then restart the launcher.")
    state = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        for k in [k for k, t in _states.items() if now - t > 1800]:
            _states.pop(k, None)
        _states[state] = now
    q = {"client_id": aid, "redirect_uri": redirect_uri(), "state": state, "response_type": "code"}
    if cfg:  # Facebook Login for Business uses a saved configuration instead of a scope list
        q["config_id"] = cfg
    else:
        q["scope"] = SCOPES
    return DIALOG + "?" + urlencode(q)


def finish(code, state):
    if not code:
        raise MetaError("No code found. Copy the whole address from the browser bar after approving.")
    with _lock:
        if state is not None:
            if state not in _states:
                raise MetaError("This sign-in link is old or was already used. Press Connect again.")
            _states.pop(state, None)
    aid, asec, _ = app()
    r = requests.get(f"{GRAPH}/oauth/access_token", params={
        "client_id": aid, "client_secret": asec, "redirect_uri": redirect_uri(), "code": code}, timeout=30)
    if r.status_code != 200:
        raise MetaError("Facebook refused the sign-in: " + _err(r))
    short = r.json()["access_token"]
    r = requests.get(f"{GRAPH}/oauth/access_token", params={
        "grant_type": "fb_exchange_token", "client_id": aid, "client_secret": asec, "fb_exchange_token": short},
        timeout=30)
    tok = r.json() if r.status_code == 200 else {"access_token": short, "expires_in": 3600}
    d = _load()
    d.update(user_token=tok["access_token"], expires_at=time.time() + int(tok.get("expires_in") or 60 * 86400),
             connected_at=time.time(), error=None)
    _save(d)
    refresh_accounts()
    return status()


def _user_token():
    d = _load()
    return d.get("user_token") or get_secret("META_TOKEN")


def refresh_accounts():
    """Pages the user manages, each with its own (non-expiring) Page token and linked Instagram account."""
    tok = _user_token()
    if not tok:
        raise MetaError("Instagram/Facebook isn't connected. Open Connections and press Connect.")
    data = _get("me/accounts", tok, limit=50, fields="id,name,access_token,picture{url},"
                "instagram_business_account{id,username,profile_picture_url,followers_count,media_count}")
    pages = []
    for p in data.get("data", []):
        ig = p.get("instagram_business_account")
        pages.append({"id": p["id"], "name": p.get("name"), "token": p.get("access_token"),
                      "picture": ((p.get("picture") or {}).get("data") or {}).get("url"),
                      "ig": {"id": ig["id"], "username": ig.get("username"), "picture": ig.get("profile_picture_url"),
                             "followers": ig.get("followers_count"), "posts": ig.get("media_count")} if ig else None})
    with _lock:
        d = _load()
        d["pages"] = pages
        if not pages:
            d["error"] = ("No Facebook Page was shared with Clipora. Press Connect again and tick your Page "
                          "(and Instagram account) on Facebook's screen.")
        if d.get("page_id") not in [p["id"] for p in pages]:
            withig = [p for p in pages if p["ig"]]
            d["page_id"] = (withig or pages or [{"id": None}])[0]["id"]
        d["accounts_at"] = time.time()
        _save(d)
    return pages


def _page():
    d = _load()
    if not d.get("pages") and _user_token():
        refresh_accounts()
        d = _load()
    return next((p for p in d.get("pages", []) if p["id"] == d.get("page_id")), None)


def select_page(page_id):
    d = _load()
    if page_id not in [p["id"] for p in d.get("pages", [])]:
        raise MetaError("That Page isn't connected.")
    d["page_id"] = page_id
    _save(d)
    return status()


def status():
    aid, asec, cfg = app()
    d = _load()
    page = next((p for p in d.get("pages", []) if p["id"] == d.get("page_id")), None)
    clean = lambda p: {k: v for k, v in p.items() if k != "token"} if p else None  # never send tokens to the browser
    return {"configured": bool(aid and asec), "has_config": bool(cfg), "connected": bool(_user_token()),
            "redirect_uri": redirect_uri(), "error": d.get("error"), "expires_at": d.get("expires_at"),
            "page": clean(page), "ig": page.get("ig") if page else None,
            "pages": [{"id": p["id"], "name": p["name"], "ig": (p.get("ig") or {}).get("username")}
                      for p in d.get("pages", [])],
            "from_secret": bool(not d.get("user_token") and get_secret("META_TOKEN"))}


def token_for_backup():
    return _load().get("user_token")


def disconnect():
    tok = _user_token()
    if tok:
        try:
            requests.delete(f"{GRAPH}/me/permissions", params={"access_token": tok}, timeout=15)
        except requests.RequestException:
            pass
    STORE.unlink(missing_ok=True)


# ---------------- upload ----------------
def _rupload(url, token, path, progress=None):
    """Meta's resumable upload host: send the file, resume from the reported offset after a hiccup."""
    size = Path(path).stat().st_size
    offset, fails = 0, 0
    while True:
        try:
            with open(path, "rb") as fh:
                fh.seek(offset)
                r = requests.post(url, data=fh, timeout=600, headers={
                    "Authorization": f"OAuth {token}", "offset": str(offset), "file_size": str(size)})
            if r.status_code == 200 and (_json(r).get("success") or _json(r).get("id")):
                if progress:
                    progress(0.9)
                return
            if r.status_code < 500 and r.status_code not in (408, 429):
                raise MetaError(_err(r))
        except requests.RequestException:
            pass
        fails += 1
        if fails > 4:
            raise MetaError("Upload to Meta kept failing (network). Try again.")
        time.sleep(min(20, 2 ** fails))
        try:  # ask how much arrived, then resume from there
            q = requests.get(url, headers={"Authorization": f"OAuth {token}"}, timeout=30)
            offset = int(_json(q).get("offset", offset) or 0)
        except (requests.RequestException, ValueError):
            pass


def upload_instagram(path, caption, progress=None):
    """Publish a Reel to the connected Instagram account. Returns (media_id, permalink)."""
    page = _page()
    if not page or not page.get("ig"):
        raise MetaError("No Instagram account is linked to your Facebook Page. Link it in the Page's settings "
                        "(Linked accounts → Instagram), then press Connect again.")
    tok, ig = page["token"], page["ig"]["id"]
    try:  # Instagram allows a limited number of API posts per 24 hours: check before uploading
        lim = (_get(f"{ig}/content_publishing_limit", tok, fields="quota_usage,config").get("data") or [{}])[0]
        used, total = lim.get("quota_usage"), (lim.get("config") or {}).get("quota_total")
        if used is not None and total and used >= total:
            raise MetaError(f"Instagram's 24-hour posting limit is reached ({used}/{total}). Try again tomorrow.")
    except MetaError as e:
        if "posting limit" in str(e):
            raise
    c = _post(f"{ig}/media", tok, media_type="REELS", upload_type="resumable", caption=caption[:2200],
              share_to_feed="true")
    _rupload(c["uri"], tok, path, progress)
    for _ in range(120):  # Instagram processes the video before it can be published (usually < 1 minute)
        st = _get(c["id"], tok, fields="status_code,status")
        if st.get("status_code") == "FINISHED":
            break
        if st.get("status_code") in ("ERROR", "EXPIRED"):
            detail = st.get("status") or st.get("status_code")
            m = re.search(r"2207\d{3}", str(detail))
            if m and int(m.group(0)) in IG_SUBCODES:
                raise MetaError(f"{IG_SUBCODES[int(m.group(0))]} (Instagram: {detail})")
            raise MetaError(f"Instagram couldn't process the video: {detail}")
        time.sleep(5)
    else:
        raise MetaError("Instagram took too long to process the video. Try again.")
    media = _post(f"{ig}/media_publish", tok, creation_id=c["id"])["id"]
    link = None
    try:
        link = _get(media, tok, fields="permalink").get("permalink")
    except MetaError:
        pass
    if progress:
        progress(1.0)
    return media, link or f"https://www.instagram.com/{page['ig'].get('username') or ''}"


def upload_facebook(path, description, progress=None):
    """Publish a Reel to the selected Facebook Page. Returns (video_id, url)."""
    page = _page()
    if not page:
        raise MetaError("No Facebook Page is connected. Press Connect and tick your Page on Facebook's screen.")
    tok, pid = page["token"], page["id"]
    start = _post(f"{pid}/video_reels", tok, upload_phase="start")
    vid = start["video_id"]
    _rupload(start.get("upload_url") or f"https://rupload.facebook.com/video-upload/{VERSION}/{vid}", tok, path,
             progress)
    _post(f"{pid}/video_reels", tok, upload_phase="finish", video_id=vid, video_state="PUBLISHED",
          description=description[:5000])
    if progress:
        progress(1.0)
    return vid, f"https://www.facebook.com/reel/{vid}"


# ---------------- stats ----------------
def media_stats(ig_ids=(), fb_ids=()):
    """Likes / comments / views of published Reels. Missing numbers stay 0 (Meta changes metric names often)."""
    page = _page()
    if not page:
        raise MetaError("Instagram/Facebook isn't connected.")
    tok, out = page["token"], {}
    for mid in dict.fromkeys(i for i in ig_ids if i):
        try:
            m = _get(mid, tok, fields="like_count,comments_count,permalink")
        except MetaError:
            continue  # deleted on Instagram
        views = 0
        try:
            ins = _get(f"{mid}/insights", tok, metric="views")
            views = int(((ins.get("data") or [{}])[0].get("values") or [{}])[0].get("value") or 0)
        except (MetaError, ValueError, IndexError, TypeError):
            pass
        out[mid] = {"views": views, "likes": int(m.get("like_count") or 0),
                    "comments": int(m.get("comments_count") or 0), "url": m.get("permalink")}
    for vid in dict.fromkeys(i for i in fb_ids if i):
        try:
            m = _get(vid, tok, fields="likes.summary(true).limit(0),comments.summary(true).limit(0),views")
        except MetaError:
            continue
        out[vid] = {"views": int(m.get("views") or 0),
                    "likes": int(((m.get("likes") or {}).get("summary") or {}).get("total_count") or 0),
                    "comments": int(((m.get("comments") or {}).get("summary") or {}).get("total_count") or 0)}
    return out
