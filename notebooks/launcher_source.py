# %% [markdown]
# # 🎬 Clipora — launcher for Kaggle / Colab
#
# This notebook runs **Clipora** (the open-source AI video clipper) on a **free GPU** and gives you a
# **public link** to the website, on your phone or PC. Keep the notebook running while you use the site.
#
# ### One-time setup (5 minutes)
# 1. **Turn on the GPU + internet**
#    - **Kaggle:** right panel → *Session options* → *Accelerator: GPU T4 ×2* and *Internet: On*
#      (internet needs a phone-verified Kaggle account)
#    - **Colab:** *Runtime → Change runtime type → T4 GPU*
# 2. **Add your keys** — either as **Secrets** (Kaggle: *Add-ons → Secrets*, tick each one for this notebook ·
#    Colab: 🔑 icon, turn on *Notebook access*), **or** as a `clipora.env` file in a **private** Kaggle dataset /
#    the Colab Files panel (copy `clipora.env.example` from the repo):
#    - `APP_PASSWORD` ← **a password for your website** (required: the link is public!)
#    - `GROQ_API_KEY`, `GEMINI_API_KEY` ← free AI keys (optional: `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`,
#      `OPENROUTER_API_KEY`). Without any, Clipora uses a built-in rule-based picker.
#    - Optional publishing: `YOUTUBE_CLIENT_ID` + `YOUTUBE_CLIENT_SECRET`, `META_APP_ID` + `META_APP_SECRET` +
#      `META_CONFIG_ID` — see the guides in the repo's `docs/` folder.
# 3. **Run All.** The last cell prints `🌍 PUBLIC LINK: https://....trycloudflare.com` — open it and log in.
#
# ⏱️ Free sessions stop after a while (Kaggle ~12 h, Colab less) and the link changes each time.
# **Download or publish your clips before the session ends** — the server is wiped afterwards.

# %%
# ===== 0. SETTINGS =====
REPO_URL = "https://github.com/haadjunejo/clipora.git"  # change this if you use your own fork
BRANCH = "main"

# %%
# ===== 1. READ YOUR SECRETS (first, before anything is installed) =====
import os, time
IN_KAGGLE = os.path.exists("/kaggle/working")
SECRET_NAMES = ["APP_PASSWORD", "GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY",
                "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "HF_TOKEN", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
                "YOUTUBE_REFRESH_TOKEN", "PUBLIC_URL", "META_APP_ID", "META_APP_SECRET", "META_CONFIG_ID",
                "META_TOKEN"]
secret_errors = {}


def read_secret(name):
    """One request per secret. Kaggle blocks accounts that ask too often (HTTP 429), so no fast retries."""
    try:
        if IN_KAGGLE:
            from kaggle_secrets import UserSecretsClient
            return UserSecretsClient().get_secret(name)
        from google.colab import userdata
        return userdata.get(name)
    except Exception as e:
        code = getattr(e.__cause__, "code", None)
        secret_errors[name] = ("Kaggle says too many requests (429), wait ~1 hour" if code == 429
                               else f"{type(e).__name__}: {str(e)[:160]}")
        return None


for _n in SECRET_NAMES:
    if any("429" in e or "Connection" in e for e in secret_errors.values()):
        break  # the secret service is refusing: stop asking (asking more makes the block longer)
    _v = read_secret(_n)
    if _v:
        os.environ[_n] = _v
        secret_errors.pop(_n, None)

_conn = [n for n, e in secret_errors.items() if "Connection" in e or "429" in e]
if _conn:
    print("⚠️ The secret service refused:", secret_errors[_conn[0]])
    print("   Using a clipora.env file / typed password instead.")

# Backup 1: a private file named clipora.env (lines like  GROQ_API_KEY=...) in a PRIVATE dataset / Colab files
import glob
for _f in (glob.glob("/kaggle/input/**/clipora.env", recursive=True) + glob.glob("/content/clipora.env")
           + glob.glob("/content/drive/MyDrive/clipora.env")):
    _added = []
    for _line in open(_f, encoding="utf-8", errors="ignore"):
        if "=" in _line and not _line.lstrip().startswith("#"):
            _k, _v = _line.split("=", 1)
            _k, _v = _k.strip(), _v.strip().strip('"').strip("'")
            if _k in SECRET_NAMES and _v and not os.environ.get(_k):
                os.environ[_k] = _v
                _added.append(_k)
    if _added:
        print(f"🔑 Loaded {len(_added)} keys from {_f}")
    break

# Backup 2: type the site password by hand (hidden), so the site is never public without one
if not os.environ.get("APP_PASSWORD"):
    try:
        from getpass import getpass
        _pw = getpass("No APP_PASSWORD found. Type a password for your website (hidden), then Enter: ").strip()
        if _pw:
            os.environ["APP_PASSWORD"] = _pw
    except Exception:
        pass

print("Secrets found:", [n for n in SECRET_NAMES if os.environ.get(n)] or "none")
_missing = [n for n in ("APP_PASSWORD", "GROQ_API_KEY", "GEMINI_API_KEY") if not os.environ.get(n)]
if _missing:
    print("   Not found:", ", ".join(_missing), "→ add them as secrets or in clipora.env (see the top of this notebook)")

# %%
# ===== 2. INSTALL (~2 minutes) =====
!pip -q install -U --pre "yt-dlp[default]"
!pip -q install -U faster-whisper fastapi uvicorn python-multipart
!nvidia-smi >/dev/null 2>&1 && pip -q install "nvidia-cublas-cu12" "nvidia-cudnn-cu12==9.*" "nvidia-cuda-runtime-cu12" || true
!command -v ffmpeg >/dev/null || (apt-get -qq update && apt-get -qq install -y ffmpeg >/dev/null)
!command -v deno >/dev/null || [ -x ~/.deno/bin/deno ] || (curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1) || true
import os, shutil
os.environ["PATH"] = os.path.expanduser("~/.deno/bin") + os.pathsep + os.environ["PATH"]
print("Deno:", "✅" if shutil.which("deno") else "❌ missing (YouTube links may fail; uploads still work)")
print("✅ Installed")

# %%
# ===== 3. GET CLIPORA (from GitHub, or from a dataset / zip you uploaded) =====
import subprocess, zipfile
from pathlib import Path

WORK_ROOT = Path("/kaggle/working" if IN_KAGGLE else "/content")
APP_DIR = WORK_ROOT / "clipora"


def find_uploaded():
    """A copy you uploaded yourself (folder or zip) wins over GitHub, e.g. to run your own changes."""
    roots = ["/kaggle/input", "/content", "/content/drive/MyDrive"]
    for r in roots:
        for hit in glob.glob(f"{r}/**/run_server.py", recursive=True):
            if "-data/" not in hit and not hit.startswith(str(APP_DIR)):
                return ("dir", Path(hit).parent)
    for r in roots:
        for pat in ("clipora*.zip", "clipper-web*.zip"):
            for hit in glob.glob(f"{r}/**/{pat}", recursive=True):
                return ("zip", Path(hit))
    return (None, None)


kind, src = find_uploaded()
if APP_DIR.exists():
    shutil.rmtree(APP_DIR)
if kind == "dir":
    shutil.copytree(src, APP_DIR)
elif kind == "zip":
    with zipfile.ZipFile(src) as z:
        z.extractall(WORK_ROOT / "_unzip")
    inner = next(Path(p).parent for p in glob.glob(str(WORK_ROOT / "_unzip/**/run_server.py"), recursive=True))
    shutil.move(str(inner), APP_DIR)
    shutil.rmtree(WORK_ROOT / "_unzip", ignore_errors=True)
else:
    r = subprocess.run(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, str(APP_DIR)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"🛑 Couldn't download Clipora from {REPO_URL} — is Internet turned on?\n{r.stderr[-500:]}")
    src = REPO_URL
print(f"✅ Clipora ready at {APP_DIR} (from {src})")

# %%
# ===== 4. START THE WEBSITE (keep this cell running) =====
import sys

env = dict(os.environ)  # secrets were loaded into the environment by step 1
env["CLIPORA_SECRETS_LOADED"] = "1"  # the website must not ask Kaggle again (avoids the 429 block)
print("AI keys:", [n for n in SECRET_NAMES if n.endswith("_API_KEY") and env.get(n)] or "none (rule-based picker)")
print("YouTube:", "✅ app keys found" if env.get("YOUTUBE_CLIENT_ID") and env.get("YOUTUBE_CLIENT_SECRET")
      else "not set up (optional, see docs/youtube.md)")
print("Instagram/Facebook:", "✅ app keys found" if env.get("META_APP_ID") and env.get("META_APP_SECRET")
      else "not set up (optional, see docs/instagram-facebook.md)")
if not env.get("APP_PASSWORD"):
    raise SystemExit("🛑 Not starting: no APP_PASSWORD, so anyone with the link could use your site and GPU. "
                     "Add it as a secret or in clipora.env, then Run All again.")

subprocess.run("pkill -f run_server.py; pkill -f cloudflared", shell=True)
log_path = WORK_ROOT / "clipora-server.log"
logf = open(log_path, "w")
server = subprocess.Popen([sys.executable, "-u", "run_server.py", "--tunnel"], cwd=APP_DIR, env=env,
                          stdout=logf, stderr=subprocess.STDOUT)
print("Starting server... the public link appears below in ~20 seconds.\n"
      "Stop this cell (■) to shut the website down.\n")
pos = 0
try:
    while True:
        time.sleep(2)
        with open(log_path, errors="ignore") as fh:
            fh.seek(pos)
            new = fh.read()
            pos = fh.tell()
        if new:
            print(new, end="", flush=True)
        if server.poll() is not None:
            print(f"\n❌ Server stopped (exit code {server.returncode}). See the messages above.")
            break
except KeyboardInterrupt:
    print("\nStopping...")
finally:
    if server.poll() is None:
        server.terminate()
    subprocess.run("pkill -f cloudflared", shell=True)
    print("Website stopped.")
