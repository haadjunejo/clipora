"""YouTube: Google sign-in (OAuth), token refresh, resumable upload, channel + video stats.

Secrets: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET (from Google Cloud → Clients),
optional YOUTUBE_REFRESH_TOKEN (stay connected across Kaggle sessions), optional PUBLIC_URL (your domain).
"""
import json
import os
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests

from . import config
from .utils import get_secret

# overridable so the flow can be tested against a fake Google server
AUTH_URL = os.environ.get("YT_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth")
TOKEN_URL = os.environ.get("YT_TOKEN_URL", "https://oauth2.googleapis.com/token")
REVOKE_URL = os.environ.get("YT_REVOKE_URL", "https://oauth2.googleapis.com/revoke")
API = os.environ.get("YT_API_URL", "https://www.googleapis.com/youtube/v3")
UPLOAD_API = os.environ.get("YT_UPLOAD_URL", "https://www.googleapis.com/upload/youtube/v3")
SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
CALLBACK_PATH = "/api/connect/youtube/callback"
STORE = config.DATA / "connections" / "youtube.json"
CHUNK = int(os.environ.get("YT_CHUNK_BYTES", 8 * 1024 * 1024))

_lock = threading.RLock()
_states = {}  # state -> created time (CSRF protection for the sign-in round trip)


class YouTubeError(RuntimeError):
    pass


def client():
    return get_secret("YOUTUBE_CLIENT_ID"), get_secret("YOUTUBE_CLIENT_SECRET")


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


def _refresh_token():
    d = _load()
    return d.get("refresh_token") or get_secret("YOUTUBE_REFRESH_TOKEN")


# ---------------- sign-in ----------------
def auth_url():
    cid, csec = client()
    if not cid or not csec:
        raise YouTubeError("Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to your Kaggle/Colab secrets, "
                           "then restart the launcher.")
    state = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        for k in [k for k, t in _states.items() if now - t > 1800]:
            _states.pop(k, None)
        _states[state] = now
    return AUTH_URL + "?" + urlencode({
        "client_id": cid, "redirect_uri": redirect_uri(), "response_type": "code", "scope": SCOPES,
        "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true", "state": state,
    })


def parse_pasted(text):
    """Accept the full address Google redirected to (or just the code)."""
    text = (text or "").strip()
    if "code=" in text or "error=" in text:
        q = parse_qs(urlparse(text if "://" in text else "http://x/?" + text.split("?", 1)[-1]).query)
        if q.get("error"):
            raise YouTubeError(f"Google said: {q['error'][0]} — try connecting again.")
        return (q.get("code") or [""])[0], (q.get("state") or [""])[0]
    return text, None


def finish(code, state):
    """Swap the one-time code for tokens and remember the channel."""
    if not code:
        raise YouTubeError("No code found — copy the whole address from the browser bar after approving.")
    with _lock:
        if state is not None:
            if state not in _states:
                raise YouTubeError("This sign-in link is old or was already used — press Connect again.")
            _states.pop(state, None)
    cid, csec = client()
    r = requests.post(TOKEN_URL, data={"code": code, "client_id": cid, "client_secret": csec,
                                       "redirect_uri": redirect_uri(), "grant_type": "authorization_code"},
                      timeout=30)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200:
        msg = j.get("error_description") or j.get("error") or r.text[:200]
        if "redirect_uri" in str(msg):
            msg += f" — add {redirect_uri()} as an Authorized redirect URI in Google Cloud → Clients."
        raise YouTubeError(f"Google refused the sign-in: {msg}")
    d = _load()
    d.update(access_token=j["access_token"], expires_at=time.time() + int(j.get("expires_in", 3600)) - 60,
             connected_at=time.time(), error=None)
    if j.get("refresh_token"):
        d["refresh_token"] = j["refresh_token"]
    if not d.get("refresh_token"):
        raise YouTubeError("Google didn't give a long-term token. Remove Clipora at myaccount.google.com/permissions "
                           "and connect again.")
    _save(d)
    channel(force=True)
    return status()


def access_token():
    with _lock:
        d = _load()
        if d.get("access_token") and d.get("expires_at", 0) > time.time():
            return d["access_token"]
        rt = _refresh_token()
        if not rt:
            raise YouTubeError("YouTube isn't connected. Open Connections and press Connect YouTube.")
        cid, csec = client()
        r = requests.post(TOKEN_URL, data={"refresh_token": rt, "client_id": cid, "client_secret": csec,
                                           "grant_type": "refresh_token"}, timeout=30)
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code != 200:
            if j.get("error") == "invalid_grant":
                d.update(access_token=None, refresh_token=None,
                         error="Google ended the connection (apps in Testing mode reconnect every 7 days). "
                               "Press Connect YouTube again.")
                _save(d)
                raise YouTubeError(d["error"])
            raise YouTubeError(f"Couldn't refresh the YouTube login: {j.get('error_description') or r.text[:200]}")
        d.update(access_token=j["access_token"], expires_at=time.time() + int(j.get("expires_in", 3600)) - 60,
                 error=None)
        if not d.get("refresh_token"):
            d["refresh_token"] = rt
        _save(d)
        return d["access_token"]


def _api(method, url, headers=None, **kw):
    """Authorised request with one automatic retry after a token refresh."""
    for attempt in range(2):
        h = dict(headers or {})
        h["Authorization"] = "Bearer " + access_token()
        r = requests.request(method, url, headers=h, timeout=60, **kw)
        if r.status_code == 401 and attempt == 0:
            with _lock:  # token was revoked or expired early: force a refresh and try once more
                d = _load()
                d["access_token"] = None
                _save(d)
            continue
        return r
    return r


def _err(r):
    try:
        e = r.json()["error"]
        reason = (e.get("errors") or [{}])[0].get("reason", "")
        msg = e.get("message", "")
    except Exception:
        reason, msg = "", r.text[:300]
    if reason in ("quotaExceeded", "dailyLimitExceeded"):
        return "YouTube's free daily limit is used up (about 6 uploads a day). Try again tomorrow."
    if reason == "uploadLimitExceeded":
        return "Your channel hit YouTube's upload limit for now. Try again later."
    if reason in ("youtubeSignupRequired", "channelNotFound"):
        return "This Google account has no YouTube channel yet. Create one on youtube.com first."
    if r.status_code == 403 and "insufficient" in msg.lower():
        return "Clipora doesn't have upload permission. Disconnect and connect again, allowing all permissions."
    return f"YouTube error {r.status_code}: {msg or reason}"


def channel(force=False):
    d = _load()
    if not force and d.get("channel") and time.time() - d.get("channel_at", 0) < 600:
        return d["channel"]
    r = _api("GET", f"{API}/channels", params={"part": "snippet,statistics", "mine": "true"})
    if r.status_code != 200:
        raise YouTubeError(_err(r))
    items = r.json().get("items") or []
    if not items:
        raise YouTubeError("This Google account has no YouTube channel yet. Create one on youtube.com first.")
    it = items[0]
    ch = {"id": it["id"], "title": it["snippet"]["title"],
          "thumb": ((it["snippet"].get("thumbnails") or {}).get("default") or {}).get("url"),
          "subs": it.get("statistics", {}).get("subscriberCount"),
          "videos": it.get("statistics", {}).get("videoCount"), "url": f"https://www.youtube.com/channel/{it['id']}"}
    d = _load()
    d.update(channel=ch, channel_at=time.time())
    _save(d)
    return ch


def status():
    cid, csec = client()
    d = _load()
    out = {"configured": bool(cid and csec), "connected": bool(_refresh_token()), "redirect_uri": redirect_uri(),
           "channel": d.get("channel"), "error": d.get("error"), "connected_at": d.get("connected_at"),
           "from_secret": bool(not d.get("refresh_token") and get_secret("YOUTUBE_REFRESH_TOKEN"))}
    return out


def refresh_token_for_backup():
    return _load().get("refresh_token")


def disconnect():
    rt = _refresh_token()
    if rt:
        try:
            requests.post(REVOKE_URL, params={"token": rt}, timeout=15)
        except requests.RequestException:
            pass
    STORE.unlink(missing_ok=True)


# ---------------- upload ----------------
def upload(path, title, description="", tags=(), privacy="private", made_for_kids=False, publish_at=None,
           category="22", progress=None):
    """Resumable upload. Returns the video id."""
    path = Path(path)
    size = path.stat().st_size
    status_ = {"privacyStatus": privacy, "selfDeclaredMadeForKids": bool(made_for_kids)}
    if publish_at:  # YouTube publishes it at this time (must start as private)
        status_.update(privacyStatus="private", publishAt=publish_at)
    body = {"snippet": {"title": (title or "Clip")[:100], "description": (description or "")[:5000],
                        "tags": [t.lstrip("#")[:30] for t in tags if t][:15], "categoryId": category},
            "status": status_}
    r = _api("POST", f"{UPLOAD_API}/videos", params={"uploadType": "resumable", "part": "snippet,status"},
             json=body, headers={"X-Upload-Content-Length": str(size), "X-Upload-Content-Type": "video/mp4"})
    if r.status_code not in (200, 201) or not r.headers.get("Location"):
        raise YouTubeError(_err(r))
    session = r.headers["Location"]
    sent, fails = 0, 0
    with open(path, "rb") as fh:
        while True:
            fh.seek(sent)
            chunk = fh.read(CHUNK)
            end = sent + len(chunk) - 1
            try:
                r = requests.put(session, data=chunk, timeout=300, headers={
                    "Authorization": "Bearer " + access_token(), "Content-Type": "video/mp4",
                    "Content-Range": f"bytes {sent}-{end}/{size}"})
            except requests.RequestException:
                r = None
            if r is not None and r.status_code in (200, 201):
                if progress:
                    progress(1.0)
                return r.json()["id"]
            if r is not None and r.status_code == 308:
                rng = r.headers.get("Range")  # e.g. "bytes=0-8388607"
                sent = int(rng.split("-")[-1]) + 1 if rng else 0
                fails = 0
                if progress:
                    progress(sent / size)
                continue
            if r is not None and r.status_code < 500 and r.status_code not in (408, 429):
                raise YouTubeError(_err(r))
            fails += 1  # network hiccup or 5xx: ask YouTube how much it has, then resume
            if fails > 6:
                raise YouTubeError("Upload kept failing (network). Try again.")
            time.sleep(min(30, 2 ** fails))
            try:
                q = requests.put(session, timeout=60, headers={"Authorization": "Bearer " + access_token(),
                                                              "Content-Range": f"bytes */{size}"})
                if q.status_code in (200, 201):
                    return q.json()["id"]
                if q.status_code == 308:
                    rng = q.headers.get("Range")
                    sent = int(rng.split("-")[-1]) + 1 if rng else 0
            except requests.RequestException:
                pass


def video_stats(ids):
    """Views / likes / comments / privacy for published videos (1 quota unit per 50 videos)."""
    out = {}
    ids = [i for i in dict.fromkeys(ids) if i]
    for k in range(0, len(ids), 50):
        r = _api("GET", f"{API}/videos", params={"part": "statistics,status,snippet", "id": ",".join(ids[k:k + 50])})
        if r.status_code != 200:
            raise YouTubeError(_err(r))
        for it in r.json().get("items", []):
            s = it.get("statistics", {})
            out[it["id"]] = {"views": int(s.get("viewCount", 0)), "likes": int(s.get("likeCount", 0)),
                             "comments": int(s.get("commentCount", 0)),
                             "privacy": it.get("status", {}).get("privacyStatus"),
                             "upload_status": it.get("status", {}).get("uploadStatus"),
                             "title": it.get("snippet", {}).get("title")}
    return out
