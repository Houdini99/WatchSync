FROM python:3.12-slim

# yt-dlp moves fast as sites change — install the latest at build time and
# rebuild this image periodically to keep extractors working. No ffmpeg is
# needed: we only extract stream URLs, never download or merge. The bgutil
# plugin lets yt-dlp attach YouTube PO tokens (from the watchsync-bgutil
# sidecar) to subtitle URLs — required for auto-translated caption tracks.
RUN pip install --no-cache-dir --upgrade yt-dlp bgutil-ytdlp-pot-provider

WORKDIR /app
COPY app.py .
RUN useradd --system --uid 10002 app && chown -R app /app
USER app

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"

CMD ["python", "app.py"]
