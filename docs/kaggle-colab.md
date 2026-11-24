# Run Clipora free on Kaggle or Colab

Kaggle gives every verified account **about 30 GPU hours a week for free** (2× NVIDIA T4), which is the best free
option for Clipora. Colab's free T4 also works but sessions are shorter.

## Kaggle (recommended)

1. **Open the launcher:** click
   [![Open in Kaggle](https://kaggle.com/static/images/open-in-kaggle.svg)](https://kaggle.com/kernels/welcome?src=https://github.com/haadjunejo/clipora/blob/main/notebooks/Clipora_Launcher.ipynb)
   and sign in. Kaggle creates your own copy of the notebook.
2. **Turn on the GPU and internet:** right panel → *Session options* → **Accelerator: GPU T4 ×2** and
   **Internet: On**. Internet requires a phone-verified Kaggle account (*Settings → Phone verification*).
3. **Add your keys** — pick one way:
   - **Secrets:** *Add-ons → Secrets → Add secret*, then **tick each secret for this notebook**.
   - **A private file:** copy [`clipora.env.example`](../clipora.env.example) to `clipora.env`, fill it in, and upload it
     as a **Private** dataset (*Add Input → Upload → New Dataset*). Put your YouTube `cookies.txt` in the same dataset.

   At minimum set `APP_PASSWORD` (the website is public, so it must have a password). Add free AI keys from
   [Groq](https://console.groq.com/keys) and [Google AI Studio](https://aistudio.google.com/app/apikey) for the best
   clip picking.
4. **Run All.** After ~3 minutes the last cell prints:
   ```
   🌍  PUBLIC LINK:  https://something-random.trycloudflare.com
   ```
   Open it, log in with your `APP_PASSWORD`, and make clips. Keep the notebook running while you use the site.

### Good to know
- **The link changes every session**, and **the server is wiped when the session ends** — download or publish your clips first.
- Sessions stop after about 12 hours, or earlier if the browser tab is idle for a long time.
- New notebook copies don't inherit secrets or datasets: tick the secrets and add the dataset again.
- If Kaggle answers *"too many requests (429)"* for secrets, wait an hour or use the `clipora.env` file.

## Google Colab

1. [![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/haadjunejo/clipora/blob/main/notebooks/Clipora_Launcher.ipynb)
2. *Runtime → Change runtime type → **T4 GPU***.
3. Add secrets with the 🔑 icon (turn on *Notebook access* for each), or drag `clipora.env` into the 📁 Files panel.
4. *Runtime → Run all* and open the public link.

## Run your own changes
The launcher downloads Clipora from GitHub. To run a modified copy instead, upload your folder (or a zip of it) as a
dataset / into Colab Files — the launcher uses an uploaded copy first. Or change `REPO_URL` in the first cell to your fork.
