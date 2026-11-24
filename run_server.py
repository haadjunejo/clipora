"""Start the Clipora website.

    python run_server.py                 # http://localhost:8000
    python run_server.py --tunnel        # also get a free public https link (Cloudflare quick tunnel)
    python run_server.py --port 9000

Keys and settings come from environment variables, Kaggle/Colab secrets, or a `clipora.env` file
next to this script (copy `clipora.env.example`). Set APP_PASSWORD to protect the site with a password.
"""
import argparse
import os
import re
import stat
import subprocess
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"


def start_tunnel(port):
    from clipora import config
    from clipora.utils import download_file
    exe = config.CACHE / "cloudflared"
    download_file(CLOUDFLARED_URL, exe)
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    p = subprocess.Popen([str(exe), "tunnel", "--no-autoupdate", "--url", f"http://localhost:{port}"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def watch():
        for line in p.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m:
                (config.DATA / "public_url.txt").write_text(m.group(0))
                print("\n" + "=" * 60 + f"\n🌍  PUBLIC LINK:  {m.group(0)}\n" + "=" * 60 + "\n", flush=True)
    threading.Thread(target=watch, daemon=True).start()
    return p


def import_cookies():
    """Use a cookies.txt already uploaded to Kaggle (dataset) or Colab (Files panel), if the site has none."""
    import glob
    import shutil
    from clipora import config
    if config.COOKIES_FILE.exists():
        return
    for pat in ("/kaggle/input/**/*cookies*.txt", "/content/*cookies*.txt", "/content/drive/MyDrive/*cookies*.txt"):
        for hit in glob.glob(pat, recursive=True):
            try:
                text = open(hit, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if "youtube.com" in text or "# Netscape" in text:
                shutil.copy(hit, config.COOKIES_FILE)
                print(f"🍪 Using YouTube cookies from {hit}")
                return


SECRET_NAMES = ("APP_PASSWORD", "GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY",
                "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
                "YOUTUBE_REFRESH_TOKEN", "PUBLIC_URL", "META_APP_ID", "META_APP_SECRET", "META_CONFIG_ID", "META_TOKEN")


def load_env_file(path):
    """KEY=value lines (like clipora.env.example). Real environment variables win."""
    path = Path(path)
    if not path.exists():
        return 0
    n = 0
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v and not os.environ.get(k):
            os.environ[k] = v
            n += 1
    return n


def main():
    loaded = load_env_file(ROOT / "clipora.env")
    if loaded:
        print(f"🔑 Loaded {loaded} settings from clipora.env")
    for stream in (sys.stdout, sys.stderr):  # emoji in logs on any console (Windows uses cp1252)
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--tunnel", action="store_true", help="create a public https link (Linux only)")
    args = ap.parse_args()

    from clipora.utils import get_secret
    # pull keys from Kaggle/Colab secrets into env so the whole app (and child processes) can see them
    for name in SECRET_NAMES:
        v = get_secret(name)
        if v:
            os.environ[name] = v
    if not os.environ.get("APP_PASSWORD"):
        print("⚠️  No APP_PASSWORD set — anyone with the link can use your site." if args.tunnel else
              "ℹ️  No APP_PASSWORD set (fine on your own computer).")

    import_cookies()
    if args.tunnel:
        start_tunnel(args.port)
    import uvicorn
    print(f"Starting Clipora on http://localhost:{args.port}", flush=True)
    uvicorn.run("server.app:app", host=args.host, port=args.port, log_level="warning", timeout_keep_alive=30)


if __name__ == "__main__":
    main()
