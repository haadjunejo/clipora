import os
import sys
import tempfile
from pathlib import Path

# isolated data folder and no keys, before any clipora module is imported
os.environ["CLIPORA_DATA"] = tempfile.mkdtemp(prefix="clipora-test-")
os.environ["CLIPORA_SECRETS_LOADED"] = "1"
for k in list(os.environ):
    if k.endswith("_API_KEY") or k.startswith(("YOUTUBE_", "META_")) or k == "APP_PASSWORD":
        os.environ.pop(k)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
