"""Point every link in the repo (README badges, docs, launcher) at your GitHub account.

    python tools/set_github_user.py YOUR_GITHUB_USERNAME            # repo named "clipora"
    python tools/set_github_user.py YOUR_GITHUB_USERNAME my-repo    # different repo name
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = {".md", ".py", ".yml", ".ipynb", ".example", ".html", ".txt"}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    user, repo = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "clipora")
    pat = re.compile(r"github\.com/[A-Za-z0-9-]+/clipora|githubusercontent\.com/[A-Za-z0-9-]+/clipora|"
                     r"github/[A-Za-z0-9-]+/clipora")
    changed = 0
    for f in ROOT.rglob("*"):
        if not f.is_file() or f.suffix not in TEXT or ".git" in f.parts or f.name == Path(__file__).name:
            continue
        s = f.read_text(encoding="utf-8")
        new = pat.sub(lambda m: m.group(0).rsplit("/", 2)[0] + f"/{user}/{repo}", s)
        if new != s:
            f.write_text(new, encoding="utf-8")
            changed += 1
            print("updated", f.relative_to(ROOT))
    nb_src = ROOT / "notebooks" / "launcher_source.py"
    subprocess.run([sys.executable, str(ROOT / "tools" / "build_notebook.py"), str(nb_src),
                    str(ROOT / "notebooks" / "Clipora_Launcher.ipynb")], check=True)
    print(f"Done: {changed} files now point to github.com/{user}/{repo}")


if __name__ == "__main__":
    main()
