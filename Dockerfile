# Clipora on any machine with an NVIDIA GPU (RunPod, Vast.ai, a cloud VM, your own PC with Docker + NVIDIA toolkit)
#   docker build -t clipora .
#   docker run --gpus all -p 8000:8000 --env-file clipora.env -v $PWD/data:/app/data clipora
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 CLIPORA_DATA=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# JavaScript runtime that yt-dlp needs for YouTube
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y && ln -s /root/.deno/bin/deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt \
    && pip3 install --no-cache-dir torch transformers accelerate
COPY . .

EXPOSE 8000
CMD ["python3", "run_server.py", "--port", "8000"]
