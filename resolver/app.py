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
from collections import OrderedDict
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

# Logging. Previously this service printed exactly one line for its whole
# lifetime: log_message was stubbed out and yt-dlp ran with quiet/no_warnings,
# so `docker logs watchsync-resolver` was permanently empty -- no access log,
# no extraction failures, nothing. README told operators to debug resolver
# problems from the server's logs, which only ever see "resolver returned 502".
# Keep it cheap and unbuffered; RESOLVER_LOG=0 restores silence.
LOG_ENABLED = os.environ.get("RESOLVER_LOG", "1").strip().lower() not in ("0", "false", "no")


def log(msg):
    if LOG_ENABLED:
        print("%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg), flush=True)


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
    """False unless the URL is http(s) and every address its host resolves to
    is public. Fails closed on parse/DNS errors (yt-dlp would fail there
    anyway). The scheme check runs even under ALLOW_PRIVATE_URLS: that flag is
    about reaching a LAN Jellyfin/NAS, never about handing `file:`/`ftp:` to a
    fetcher."""
    parts = urllib.parse.urlparse(url)
    if parts.scheme not in ("http", "https"):
        return False
    if ALLOW_PRIVATE_URLS:
        return True
    host = parts.hostname
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


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-runs the SSRF gate on every hop.

    urllib follows redirects transparently, so validating only the URL we were
    handed is no gate at all: `http://attacker/x.vtt` -> `302` ->
    `http://watchsync-server:3000/...` needs no DNS trickery. Every Location is
    re-checked here, which also re-resolves the host (so a rebind must win the
    race on each hop rather than just once).
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not url_host_allowed(newurl):
            raise urllib.error.HTTPError(
                newurl, code, "redirect to a disallowed host", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Opener used for every fetch of a URL we did not receive directly from the
# caller (subtitle tracks come out of yt-dlp's extraction of a user-pasted
# page, so they are attacker-influenced and get the same treatment).
_SAFE_OPENER = urllib.request.build_opener(_SafeRedirectHandler)

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


def _has_audio(fmt):
    """True unless the format explicitly declares no audio track.

    HLS master playlists often leave acodec unset/'unknown' while their
    variants do carry audio, so only an explicit "none" counts as silent.
    """
    return (fmt.get("acodec") or "unknown") != "none"


def _first_playable_with_audio(info):
    """The first single stream that is not explicitly video-only."""
    if info.get("url") and _has_audio(info):
        return info
    for fmt in info.get("formats") or []:
        if fmt.get("url") and _has_audio(fmt):
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
    #
    # This deliberately does NOT fall back to req[0]. When Case 1 found a pair
    # but one half had no url, req[0] is the VIDEO-ONLY format, and returning
    # it as kind:"muxed" with audio_url:None yields silent playback -- exactly
    # the "video-only" regression this module's docstring says the split
    # contract fixed. Prefer a format that actually carries audio, and only
    # accept a silent one when nothing else exists.
    single = _first_playable_with_audio(info) or _first_with_url(info)
    if not single or not single.get("url"):
        raise ValueError("no playable format found")
    if not _has_audio(single):
        log("resolve: only a video-only format available for %s" % url)
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

# OrderedDict, not dict: eviction pops the oldest INSERTION, and refreshing an
# existing key does not move it. With a plain dict the hottest URL -- refreshed
# every SUBS_CACHE_TTL, still first in insertion order -- was the first one
# evicted, so the hit rate collapsed under exactly the load a cache is for.
# move_to_end on every hit and every write makes this a real LRU.
_subs_cache = OrderedDict()  # url -> (monotonic ts, {lang: {name, kind, url, rank}})
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
            _subs_cache.move_to_end(url)
            return hit[1]
        if hit:
            del _subs_cache[url]  # expired: drop it rather than shadow it

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
        _subs_cache[url] = (now, tracks)
        _subs_cache.move_to_end(url)
        while len(_subs_cache) > SUBS_CACHE_MAX:
            _subs_cache.popitem(last=False)
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
# Also cap by BYTES, not just entry count: 60 entries x MAX_SUB_BYTES (3 MiB)
# is 180 MiB of subtitle bodies held in a container that has no memory limit.
BODY_CACHE_MAX_BYTES = int(os.environ.get("BODY_CACHE_MAX_BYTES", str(24 * 1024 * 1024)))
_body_cache = OrderedDict()
_body_bytes = 0
_body_lock = threading.Lock()

# Attempt schedule for 429s: the tlang token bucket refills within ~20s, so a
# couple of spaced retries almost always succeed while staying inside the
# server's proxy timeout. Non-429 errors fail immediately.
RETRY_DELAYS = (6, 12)


def fetch_subtitle(url, lang):
    """Return (vtt bytes) for one language, or raise LookupError/ValueError."""
    now = time.monotonic()
    key = (url, lang)
    with _body_lock:
        hit = _body_cache.get(key)
        if hit and now - hit[0] < BODY_CACHE_TTL:
            _body_cache.move_to_end(key)
            return hit[1]

    track = subtitle_tracks(url).get(lang)
    if not track:
        raise LookupError("no subtitles for language %r" % lang)

    # The track URL comes out of yt-dlp's extraction of a user-pasted page, so
    # it is attacker-influenced and gets the same SSRF gate as the page URL —
    # without this, a crafted page pointing a caption track at an internal
    # service turns this endpoint into a read-SSRF that returns the response
    # body verbatim to the browser.
    if not url_host_allowed(track["url"]):
        raise ValueError("subtitle track host is not allowed")

    headers = {"User-Agent": SUB_FETCH_UA, "Referer": "https://www.youtube.com/"}
    body = None
    for attempt, delay in enumerate((0,) + RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(track["url"], headers=headers)
            with _SAFE_OPENER.open(req, timeout=15) as resp:
                body = resp.read(MAX_SUB_BYTES + 1)
            break
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == len(RETRY_DELAYS):
                raise
    if len(body) > MAX_SUB_BYTES:
        raise ValueError("subtitle track too large")

    with _body_lock:
        global _body_bytes
        old_entry = _body_cache.pop(key, None)
        if old_entry:
            _body_bytes -= len(old_entry[1])
        _body_cache[key] = (now, body)
        _body_bytes += len(body)
        while _body_cache and (
            len(_body_cache) > BODY_CACHE_MAX or _body_bytes > BODY_CACHE_MAX_BYTES
        ):
            _, evicted = _body_cache.popitem(last=False)
            _body_bytes -= len(evicted[1])
    return body


# Bound concurrent extractions. ThreadingHTTPServer's mixin has no
# max_children, so every accepted connection used to spawn a thread running a
# full yt-dlp extraction -- CPU-heavy JS/regex/JSON parsing, i.e. real GIL
# contention rather than idle I/O wait. Nothing capped the thread count, and
# the listen backlog is only 5, so a burst both thrashed the interpreter and
# started refusing connections.
MAX_CONCURRENT = int(os.environ.get("RESOLVER_MAX_CONCURRENT", "4"))
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
# How long a request may wait for a slot before we shed it. Shorter than the
# Rust caller's timeout so it gets a real 503 instead of a dead connection.
SLOT_WAIT = float(os.environ.get("RESOLVER_SLOT_WAIT", "20"))


class Handler(BaseHTTPRequestHandler):
    # BaseHTTPRequestHandler.timeout is None by default, so socketserver never
    # calls settimeout() and a client that opens a connection and sends nothing
    # pins a thread forever. Any peer on the shared Docker network could have
    # exhausted the pool this way.
    timeout = 30

    # NOTE: protocol_version is deliberately left at HTTP/1.0. Keep-alive would
    # let the Rust client's connection pool avoid a handshake per call, but this
    # server is thread-per-connection: a kept-alive idle connection holds a
    # thread for the full `timeout` above, which works directly against the
    # concurrency cap. Revisit together with a real worker-pool server.

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

    def _fail(self, code, exc, what):
        """Log the real error, return a non-leaky one.

        yt-dlp's messages routinely embed the internal PO-token hostname, this
        container's egress IP, extractor internals, cookie/config paths, and
        the full pasted URL -- including any user:pass@ credentials. The Rust
        server forwards our JSON body verbatim, so all of that used to reach
        the browser of any anonymous visitor. Detail goes to the log; the
        client gets the class of failure and nothing else.
        """
        log("%s failed: %s: %s" % (what, type(exc).__name__, exc))
        return self._send(code, {"error": "%s failed" % what})

    def do_GET(self):  # noqa: N802 (http.server API)
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        url = (qs.get("url") or [""])[0]
        # Health must never queue behind extractions -- it is what the
        # container healthcheck polls.
        if parsed.path == "/healthz":
            return self._send(200, {"ok": True})
        # Everything below runs yt-dlp. Shed load rather than pile up threads.
        if not _slots.acquire(timeout=SLOT_WAIT):
            log("busy: no extraction slot within %ss for %s" % (SLOT_WAIT, parsed.path))
            return self._send(503, {"error": "resolver busy"})
        try:
            return self._dispatch(parsed, qs, url)
        finally:
            _slots.release()

    def _dispatch(self, parsed, qs, url):
        if parsed.path in ("/resolve", "/subtitles/list", "/subtitles/get"):
            if not (url.startswith("http://") or url.startswith("https://")):
                return self._send(400, {"error": "invalid url"})
            if not url_host_allowed(url):
                return self._send(400, {"error": "url host not allowed"})
        if parsed.path == "/resolve":
            try:
                return self._send(200, resolve(url))
            except Exception as exc:  # noqa: BLE001 (report any extractor failure)
                return self._fail(502, exc, "resolve")
        if parsed.path == "/subtitles/list":
            try:
                return self._send(200, list_subtitles(url))
            except Exception as exc:  # noqa: BLE001
                return self._fail(502, exc, "subtitle listing")
        if parsed.path == "/subtitles/get":
            lang = (qs.get("lang") or [""])[0]
            if not lang or len(lang) > 20:
                return self._send(400, {"error": "invalid lang"})
            try:
                body = fetch_subtitle(url, lang)
                return self._send_raw(200, body, "text/vtt; charset=utf-8")
            except LookupError:
                # Safe to be specific: this one carries only the language code
                # the caller already sent us.
                return self._send(404, {"error": "no subtitles for that language"})
            except Exception as exc:  # noqa: BLE001
                return self._fail(502, exc, "subtitle fetch")
        return self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        # Single-line access log. Errors are still returned in the response
        # body, but they must also be visible to an operator reading
        # `docker logs`, which used to show nothing at all.
        log("%s %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    print(f"watchsync-resolver listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
