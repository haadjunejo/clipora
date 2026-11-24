# Contributing to Clipora

Thanks for helping! Bug reports, ideas, docs fixes and pull requests are all welcome.

## Ground rules
- Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Never commit keys, tokens, cookies or `clipora.env`.** `.gitignore` covers them; double-check `git status`.
- Keep the front end **build-free** (plain HTML/CSS/JS in `web/`) so anyone can run it anywhere.
- Prefer small, focused pull requests with a clear description and screenshots for UI changes.

## Set up a dev environment
```bash
git clone https://github.com/haadjunejo/clipora.git && cd clipora
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt pytest
cp clipora.env.example clipora.env                      # optional for local use
WHISPER_MODEL=tiny python run_server.py                 # fast on CPU while developing
```

## Before you open a pull request
```bash
pytest -q                                   # unit tests (no GPU, no network)
node --check web/js/*.js                    # front-end syntax
python tools/build_notebook.py notebooks/launcher_source.py notebooks/Clipora_Launcher.ipynb   # if you changed the launcher
```

## Project map
| Folder | What lives there |
|---|---|
| `clipora/` | The engine: download, transcribe, AI picking, rendering, jobs, publishing |
| `server/app.py` | FastAPI app: REST API, login, media, static site |
| `web/` | The website (`js/core.js` helpers, `js/pages.js` pages, `js/editor.js` editor) |
| `notebooks/` | Kaggle/Colab launcher (`launcher_source.py` is the source, the `.ipynb` is generated) |
| `docs/` | Guides and screenshots |
| `tests/` | Unit tests |

## Good first issues
- More caption styles and fonts (Urdu/Hindi/Arabic scripts need fonts that cover them)
- TikTok publishing (needs a hosted domain + TikTok app review)
- Background music with auto-ducking, B-roll, zoom on emphasis
- Translations of the interface
