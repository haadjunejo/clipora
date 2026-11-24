# Troubleshooting

### "Sign in to confirm you're not a bot" / 403 when using a YouTube link
YouTube blocks many cloud servers. Export a `cookies.txt` with the
[Get cookies.txt LOCALLY](https://chromewebstore.google.com/search/get%20cookies.txt%20locally) extension from a
**spare** Google account (open an Incognito window, log in to youtube.com, export, close the window), then upload it
in **Settings → YouTube access**, or put it next to `clipora.env` in your private Kaggle dataset.
For age-restricted videos the account must be 18+. Cookies expire after a few weeks — export fresh ones.
Or download the video yourself and use **Upload video**.

### The launcher finds no secrets
- Kaggle: secrets must be **ticked for each notebook** (*Add-ons → Secrets*). New notebook copies start without them.
- *"too many requests (429)"*: Kaggle temporarily blocks secret reads. Wait about an hour or use a `clipora.env` file.
- The `clipora.env` dataset must be **attached** to the notebook (*Add Input*).

### Transcription is very slow
You're on CPU. Turn on the GPU (Kaggle: *GPU T4 ×2*). On your own CPU machine set `WHISPER_MODEL=small`.

### "No speech found"
The video is music-only, silent, or in a language the auto-detection missed. Pick the language under
*Layout & advanced options*.

### The vertical crop cuts off the action
Open the clip in the editor → **Layout**: use **Split (streams)** for gameplay with a facecam, **Blur fill** to keep
the whole frame, or **Center crop** and drag the preview to choose the area. Then **Re-render**.

### A publish failed
Click the red **"… failed · Why?"** badge on the clip — it shows the platform's exact message.
See [youtube.md](youtube.md) and [instagram-facebook.md](instagram-facebook.md) for the common ones.

### The site shows an old version after updating
Do a hard refresh (Ctrl+Shift+R). Clipora tells browsers to re-check its files, but very old tabs may still hold a copy.
