#!/usr/bin/env python3
"""WatchSync resolver sidecar.

A tiny internal HTTP service that turns a page URL (Vimeo, Twitch, Dailymotion,
Reddit, …) into the best *separate* video + audio stream URLs using yt-dlp as a
library. It is reached only by the WatchSync server over the internal Docker
network; it is never exposed at the edge.

Unlike the old single-muxed-URL contract, the server now mux/transcodes these
streams into HLS with ffmpeg, so we hand back the highest-quality video-only and
audio-only formats separately (which fixes the long-standing "video-only" gap
for split sources like Reddit). We also return the per-stream HTTP request
headers yt-dlp would use — googlevideo/CDN URLs commonly 403 unless ffmpeg
replays the User-Agent / Referer / Cookie, so the server passes these to ffmpeg.

Endpoints:
  GET /healthz          -> {"ok": true}
  GET /subtitles/list?url=...          -> {"tracks": [{"lang","name","kind"}]}
  GET /subtitles/get?url=...&lang=...  -> the subtitle track as WebVTT text
  GET /resolve?url=...   -> {
      "video_url": "...",
      "audio_url": "..." | null,   # null when the source is already muxed/HLS
      "video_headers": { ... },
      "audio_headers": { ... },
      "title": "...",
      "is_live": bool,
      "kind": "separate" | "muxed" | "hls"
    }
    502 {"error": "..."} on failure.
"""

import ipaddress
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yt_dlp

PORT = int(os.environ.get("PORT", "8080"))
TIMEOUT = int(os.environ.get("RESOLVE_TIMEOUT", "20"))

# yt-dlp fetches whatever URL it is handed — from inside the Docker network,
# where the reverse proxy, Portainer, etc. live. Unless the deployer opts in
# (e.g. to play media off a LAN Jellyfin/NAS), refuse URLs whose host resolves
# to a private/internal address. Redirects after this check are out of scope.
ALLOW_PRIVATE_URLS = os.environ.get("ALLOW_PRIVATE_URLS", "").strip().lower() in ("1", "true", "yes")

_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def _ip_is_internal(ip):
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (ip.version == 4 and ip in _CGNAT)
    )


def url_host_allowed(url):
    """False unless every address the URL's host resolves to is public.
    Fails closed on parse/DNS errors (yt-dlp would fail there anyway)."""
    if ALLOW_PRIVATE_URLS:
        return True
    host = urllib.parse.urlparse(url).hostname
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    addrs = [info[4][0] for info in infos]
    if not addrs:
        return False
    return not any(_ip_is_internal(ipaddress.ip_address(a)) for a in addrs)

# bestvideo+bestaudio, falling back to the best combined/HLS stream. Because the
# server muxes downstream, the split pair is now the *preferred* outcome — we no
# longer need a single browser-playable file. `requested_formats` is populated by
# the format selector during extract_info even with download=False.
YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "socket_timeout": TIMEOUT,
    "format": "bv*+ba/b",
}

# Request headers we must NOT forward to ffmpeg: hop-by-hop or length/range
# headers ffmpeg manages itself (forwarding them breaks the fetch).
_SKIP_HEADERS = {"accept-encoding", "range", "host", "connection", "content-length"}


def _headers(fmt, info):
    """Merge info-level + format-level request headers, dropping unsafe ones."""
    merged = {}
    merged.update(info.get("http_headers") or {})
    merged.update(fmt.get("http_headers") or {})
    out = {}
    for key, value in merged.items():
        if str(key).lower() in _SKIP_HEADERS:
            continue
        out[str(key)] = str(value)
    return out


def _is_hls(fmt):
    proto = fmt.get("protocol") or ""
    return "m3u8" in proto or ".m3u8" in (fmt.get("url") or "").lower()


def _first_with_url(info):
    """Last-resort single stream: the top-level url or the first format URL."""
    if info.get("url"):
        return info
    for fmt in info.get("formats") or []:
        if fmt.get("url"):
            return fmt
    return None


def resolve(url):
    with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
    # A playlist slipping through despite noplaylist: take the first entry.
    if info.get("entries"):
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise ValueError("no entries")
        info = entries[0]

    title = (info.get("title") or url).strip()[:200]
    is_live = bool(info.get("is_live"))

    # Case 1 — a clean separate video+audio pair (the ideal path).
    req = info.get("requested_formats")
    if req and len(req) >= 2:
        video, audio = req[0], req[1]
        # yt-dlp orders [video, audio]; guard against a swapped pair anyway.
        if (video.get("vcodec") or "none") == "none":
            video, audio = audio, video
        if video.get("url") and audio.get("url"):
            return {
                "video_url": video["url"],
                "audio_url": audio["url"],
                "video_headers": _headers(video, info),
                "audio_headers": _headers(audio, info),
                "title": title,
                "is_live": is_live,
                "kind": "separate",
            }

    # Case 2 — a single combined stream (already-muxed progressive, or HLS such
    # as Twitch live). The server feeds it to ffmpeg as one input.
    single = _first_with_url(info if not req else (req[0] if req else info)) or _first_with_url(info)
    if not single or not single.get("url"):
        raise ValueError("no playable format found")
    direct = single["url"]
    is_hls = _is_hls(single)
    # Prefer the HLS *master* playlist when yt-dlp exposes one — ffmpeg/hls.js
    # then pick the variant, and per-variant tokens (e.g. Twitch) stay valid.
    manifest = info.get("manifest_url") or single.get("manifest_url")
    if is_hls and manifest and ".m3u8" in manifest.lower():
        direct = manifest

    return {
        "video_url": direct,
        "audio_url": None,
        "video_headers": _headers(single, info),
        "audio_headers": {},
        "title": title,
        "is_live": is_live,
        "kind": "hls" if is_hls else "muxed",
    }


# ---------------------------------------------------------------------------
# Subtitles.
#
# YouTube's *embedded* player is served a reduced caption dataset (no
# `translationLanguages` — only web/mweb clients get it), so the site's iframe
# shows fewer subtitle languages than youtube.com. These endpoints restore the
# full menu app-side: yt-dlp extracts from the watch page and therefore sees
# every manual track plus every auto-translate target; the client fetches the
# chosen track as WebVTT and renders it as an overlay on top of the player.
# ---------------------------------------------------------------------------

SUBS_CACHE_TTL = int(os.environ.get("SUBS_CACHE_TTL", "900"))
SUBS_CACHE_MAX = 40
MAX_SUB_BYTES = 3 * 1024 * 1024
SUB_FETCH_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# yt-dlp only constructs the (large) auto-translate dictionary when an
# automatic-caption download is requested, hence writeautomaticsub. Skipping
# the HLS/DASH manifests keeps extraction fast — we never touch formats here.
SUBS_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "socket_timeout": TIMEOUT,
    "writeautomaticsub": True,
    "subtitleslangs": ["all"],
    "extractor_args": {"youtube": {"skip": ["hls", "dash"]}},
}

# With a PO-token provider (the watchsync-bgutil sidecar), extract subtitles as
# the *web* client and attach a "subs" PO token to every caption URL. YouTube
# rejects auto-translate (tlang=) caption requests without such attestation, so
# this is what lets viewers' browsers fetch translated tracks directly. The web
# client can't produce formats without a JS runtime — irrelevant here, we only
# want captions (ignore_no_formats_error). Other extraction paths (/resolve)
# keep their own options and are unaffected.
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "").strip().rstrip("/")
if POT_PROVIDER_URL:
    SUBS_YDL_OPTS["ignore_no_formats_error"] = True
    SUBS_YDL_OPTS["extractor_args"] = {
        "youtube": {"skip": ["hls", "dash"], "fetch_pot": ["always"],
                    "player_client": ["web"]},
        "youtubepot-bgutilhttp": {"base_url": [POT_PROVIDER_URL]},
    }

_subs_cache = {}  # url -> (monotonic timestamp, {lang: {name, kind, url, rank}})
_subs_lock = threading.Lock()


def _vtt_url(entries):
    for entry in entries or []:
        if entry.get("ext") == "vtt" and entry.get("url"):
            return entry["url"]
    return None


def _timedtext_params(track_url):
    """(tlang, source lang, is_asr) from a YouTube timedtext URL's query. All
    None/False for other hosts, which classifies their tracks as plain 'auto'."""
    query = urllib.parse.parse_qs(urllib.parse.urlparse(track_url).query)

    def first(key):
        values = query.get(key) or []
        return values[0] if values else None

    return first("tlang"), first("lang"), first("kind") == "asr"


def _base_lang(code):
    return (code or "").split("-")[0].lower()


def subtitle_tracks(url):
    """One best track per language: {lang: {name, kind, url, rank}}, cached.

    Rank (lower wins): 0 uploaded track, 1 auto-generated original, then
    auto-translations preferred from the video's own language, else from
    English, else any source.
    """
    now = time.monotonic()
    with _subs_lock:
        hit = _subs_cache.get(url)
        if hit and now - hit[0] < SUBS_CACHE_TTL:
            return hit[1]

    with yt_dlp.YoutubeDL(SUBS_YDL_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("entries"):
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise ValueError("no entries")
        info = entries[0]

    orig_lang = _base_lang(info.get("language"))
    tracks = {}

    def put(lang, name, kind, track_url, rank):
        if not lang or not track_url:
            return
        current = tracks.get(lang)
        if current is None or rank < current["rank"]:
            tracks[lang] = {"name": name or lang, "kind": kind,
                            "url": track_url, "rank": rank}

    for lang, fmts in (info.get("subtitles") or {}).items():
        track_url = _vtt_url(fmts)
        if track_url:
            put(lang, fmts[0].get("name"), "manual", track_url, 0)

    # automatic_captions keys mix plain codes, "<lang>-orig" and
    # "<target>-<source>" pairs; both halves may themselves contain dashes, so
    # the timedtext query params are the only reliable way to classify a track.
    for key, fmts in (info.get("automatic_captions") or {}).items():
        track_url = _vtt_url(fmts)
        if not track_url:
            continue
        name = (fmts[0].get("name") or key).split(" from ")[0]
        tlang, source, _is_asr = _timedtext_params(track_url)
        if tlang:
            # For translations of an uploaded track, yt-dlp appends the source
            # to the target in tlang ("de-en" = German from English); strip it
            # to recover the real target code. ASR translations keep tlang pure.
            target = tlang
            if source and target.lower().endswith("-" + source.lower()):
                target = target[: -len(source) - 1]
            rank = 2 if _base_lang(source) == orig_lang and orig_lang else \
                   3 if _base_lang(source) == "en" else 4
            put(target, name, "translated", track_url, rank)
        else:
            put(key[:-5] if key.endswith("-orig") else key, name, "auto", track_url, 1)

    with _subs_lock:
        if len(_subs_cache) >= SUBS_CACHE_MAX:
            _subs_cache.pop(next(iter(_subs_cache)))
        _subs_cache[url] = (now, tracks)
    return tracks


def list_subtitles(url):
    tracks = subtitle_tracks(url)
    # `url` is included so the browser can fetch the track directly: Google's
    # timedtext endpoint sends permissive CORS headers, and auto-translate
    # (tlang=) requests 429 from datacenter IPs like ours while working from
    # residential viewer IPs. /subtitles/get remains the fallback path.
    listed = [{"lang": lang, "name": t["name"], "kind": t["kind"], "url": t["url"]}
              for lang, t in tracks.items()]
    listed.sort(key=lambda t: (t["kind"] != "manual", t["lang"]))
    return {"tracks": listed}


# Fetched VTT bodies, keyed (media url, lang). YouTube rate-limits translated
# (tlang=) caption requests to roughly one per ~15-20s per IP, so every body we
# never re-fetch is a token saved for the next language someone picks.
BODY_CACHE_TTL = 3600
BODY_CACHE_MAX = 60
_body_cache = {}
_body_lock = threading.Lock()

# Attempt schedule for 429s: the tlang token bucket refills within ~20s, so a
# couple of spaced retries almost always succeed while staying inside the
# server's proxy timeout. Non-429 errors fail immediately.
RETRY_DELAYS = (6, 12)


def fetch_subtitle(url, lang):
    """Return (vtt bytes) for one language, or raise LookupError/ValueError."""
    now = time.monotonic()
    with _body_lock:
        hit = _body_cache.get((url, lang))
        if hit and now - hit[0] < BODY_CACHE_TTL:
            return hit[1]

    track = subtitle_tracks(url).get(lang)
    if not track:
        raise LookupError("no subtitles for language %r" % lang)

    headers = {"User-Agent": SUB_FETCH_UA, "Referer": "https://www.youtube.com/"}
    body = None
    for attempt, delay in enumerate((0,) + RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(track["url"], headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read(MAX_SUB_BYTES + 1)
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == len(RETRY_DELAYS):
                raise
    if len(body) > MAX_SUB_BYTES:
        raise ValueError("subtitle track too large")

    with _body_lock:
        if len(_body_cache) >= BODY_CACHE_MAX:
            _body_cache.pop(next(iter(_body_cache)))
        _body_cache[(url, lang)] = (now, body)
    return body


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_raw(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (http.server API)
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        url = (qs.get("url") or [""])[0]
        if parsed.path == "/healthz":
            return self._send(200, {"ok": True})
        if parsed.path in ("/resolve", "/subtitles/list", "/subtitles/get"):
            if not (url.startswith("http://") or url.startswith("https://")):
                return self._send(400, {"error": "invalid url"})
            if not url_host_allowed(url):
                return self._send(400, {"error": "url host not allowed"})
        if parsed.path == "/resolve":
            try:
                return self._send(200, resolve(url))
            except Exception as exc:  # noqa: BLE001 (report any extractor failure)
                return self._send(502, {"error": str(exc)[:300]})
        if parsed.path == "/subtitles/list":
            try:
                return self._send(200, list_subtitles(url))
            except Exception as exc:  # noqa: BLE001
                return self._send(502, {"error": str(exc)[:300]})
        if parsed.path == "/subtitles/get":
            lang = (qs.get("lang") or [""])[0]
            if not lang or len(lang) > 20:
                return self._send(400, {"error": "invalid lang"})
            try:
                body = fetch_subtitle(url, lang)
                return self._send_raw(200, body, "text/vtt; charset=utf-8")
            except LookupError as exc:
                return self._send(404, {"error": str(exc)[:300]})
            except Exception as exc:  # noqa: BLE001
                return self._send(502, {"error": str(exc)[:300]})
        return self._send(404, {"error": "not found"})

    def log_message(self, *_args):
        pass  # keep stdout quiet; failures are returned in the response body


if __name__ == "__main__":
    print(f"watchsync-resolver listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
