# Run Clipora on your own computer or server

## Requirements
- Python **3.10+**
- **FFmpeg** on the PATH (`ffmpeg -version` should work)
- Recommended: an **NVIDIA GPU** with CUDA 12 for fast transcription (it also runs on CPU, slowly)
- Recommended for YouTube links: [Deno](https://deno.com) on the PATH (yt-dlp uses it for YouTube)

## Install and start
```bash
git clone https://github.com/haadjunejo/clipora.git
cd clipora
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp clipora.env.example clipora.env                    # then edit it (at least APP_PASSWORD + an AI key)
python run_server.py                                  # → http://localhost:8000
```
Options: `--port 9000`, `--host 127.0.0.1`, and `--tunnel` for a free public https link
(Cloudflare quick tunnel, Linux).

On a CPU-only machine use a smaller Whisper model for reasonable speed:
```
WHISPER_MODEL=small
```

## Docker (NVIDIA GPU)
```bash
docker build -t clipora .
docker run --gpus all -p 8000:8000 --env-file clipora.env -v "$PWD/data:/app/data" clipora
```
Needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/).
Works on GPU clouds such as RunPod or Vast.ai — mount a persistent volume at `/app/data`.

## Settings
Everything is configured with environment variables or `clipora.env`:

| Variable | Default | What it does |
|---|---|---|
| `APP_PASSWORD` | *(none)* | Password for the website. **Set it whenever the site is reachable by others.** |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | *(none)* | AI providers for clip picking; Clipora rotates between them. |
| `USE_LOCAL_LLM` | `1` | Fall back to a local Qwen model on the GPU when the APIs are busy. |
| `CLIPORA_DATA` | `./data` | Where projects, clips and models are stored. |
| `WHISPER_MODEL` | `large-v3` | Speech model for normal videos. |
| `WHISPER_LONG_MODEL` | `large-v3-turbo` | Faster model for long streams. |
| `LONG_VIDEO_SEC` | `5400` | Long-stream mode starts at this length (seconds). |
| `MAX_UPLOAD_MB` | `40000` | Largest upload accepted. |
| `PUBLIC_URL` | *(none)* | Your domain, so YouTube/Facebook sign-in returns to the site automatically. |
| `YOUTUBE_*`, `META_*` | *(none)* | Publishing — see [youtube.md](youtube.md) and [instagram-facebook.md](instagram-facebook.md). |
