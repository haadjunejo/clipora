"""The web API, without GPU or network."""
from fastapi.testclient import TestClient

from server.app import app

client = TestClient(app)


def test_site_and_status():
    assert client.get("/").status_code == 200
    me = client.get("/api/me").json()
    assert me == {"auth_required": False, "logged_in": True}
    st = client.get("/api/status").json()
    assert "providers" in st and "caption_styles" in st and st["queue"] == 0


def test_settings_roundtrip():
    r = client.put("/api/settings", json={"defaults": {"num_clips": 12, "caption_style": "neon"}, "brand": {"name": "Test"}})
    assert r.status_code == 200
    s = client.get("/api/settings").json()
    assert s["defaults"]["num_clips"] == 12 and s["defaults"]["caption_style"] == "neon" and s["brand"]["name"] == "Test"


def test_bad_requests_are_explained():
    assert "error" in client.post("/api/jobs", data={"url": "not a link"}).json()
    r = client.post("/api/uploads/" + "ab" * 12, data={"index": 0, "size": 10 ** 15}, files={"chunk": ("c", b"x")})
    assert r.status_code == 413 and "too big" in r.json()["error"].lower()
    assert client.get("/api/jobs/does-not-exist").status_code == 404


def test_connections_not_configured():
    c = client.get("/api/connections").json()
    assert c["yt"]["configured"] is False and c["meta"]["configured"] is False


def test_site_files_are_revalidated():
    assert client.get("/js/app.js").headers.get("cache-control") == "no-cache"
