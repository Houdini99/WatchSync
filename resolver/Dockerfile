FROM python:3.12-slim

# yt-dlp moves fast as sites change, so these are PINNED and bumped
# deliberately rather than floating.
#
# The previous `pip install --upgrade yt-dlp` with a comment saying "rebuild
# periodically to keep extractors working" did not do that: Docker caches a RUN
# layer on the command string, which never changed, so every rebuild reused the
# cached layer and yt-dlp was never actually upgraded. Extractors rotted
# silently. Pinning makes the version visible in the diff and makes a bump a
# real cache miss.
#
# YTDLP_VERSION and POT_PLUGIN_VERSION must be bumped together with the
# brainicism/bgutil-ytdlp-pot-provider image tag in docker-compose.yml --
# upstream requires the plugin and the provider server to match, and they used
# to float independently, which breaks PO tokens silently.
#
# To update:  docker build --build-arg YTDLP_VERSION=<new> ./resolver
ARG YTDLP_VERSION=2025.9.5
ARG POT_PLUGIN_VERSION=1.2.2

# No ffmpeg is needed: we only extract stream URLs, never download or merge.
# That also keeps yt-dlp's post-processor exec surface out of the image.
RUN pip install --no-cache-dir \
      "yt-dlp==${YTDLP_VERSION}" \
      "bgutil-ytdlp-pot-provider==${POT_PLUGIN_VERSION}"

WORKDIR /app
# Root-owned, app-readable: the runtime user has no business writing its own
# source. (The old `chown -R app /app` made it writable.)
COPY app.py .
RUN useradd --system --uid 10002 app
USER app

ENV PORT=8080 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

# Honour $PORT rather than hardcoding 8080 — setting PORT used to leave the
# container permanently unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz')"

CMD ["python", "app.py"]
