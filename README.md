# WatchSync

A self-hosted "watch together" web app. Create a room, share the link, and watch YouTube videos or direct media files (`.mp4`, `.webm`, `.m3u8`, …) in tight sync with your friends while you chat. No signup required, no tracking. The only third party is YouTube, and a viewer's browser only contacts it once YouTube content is in the room. An **optional** account layer gives people a permanent room URL of their own.

> **v3 — full rewrite.** This is a clean-room rebuild of the original Node/vanilla-JS WatchSync on a modern stack: a **Rust** sync engine (axum + tokio) over native **WebSockets**, and a **React + TypeScript + Vite + Tailwind** client. The room-sync behaviour and feature set are preserved; the implementation is new.

**Contents:** [Features](#features) · [Supported media](#supported-media) · [Install](#install) · [Updating](#updating) · [Configuration](#configuration) · [Accounts](#accounts--custom-room-urls-optional) · [yt-dlp resolver](#yt-dlp-resolver) · [Privacy policy](#privacy-policy-gdpr--dsgvo) · [Troubleshooting](#troubleshooting) · [Development](#development) · [How it works](#how-it-works) · [License](#license)

## Features

- **Instant rooms** — one click creates a shareable URL, no account needed
- **Optional accounts + permanent custom rooms** — register (username + password, no email) to claim room names like `/r/movie-night`: the URL works forever and you're always the host there. Guests lose nothing; see [Accounts & custom rooms](#accounts--custom-room-urls-optional)
- **Tight sync** — server is the source of truth; play, pause, seek, and **playback speed** propagate in real time
- **Synced playback speed** — 0.25×–2× (configurable); the server extrapolates position by rate so speed changes stay in sync
- **Buffer-aware** — if someone's stream stalls, the room auto-pauses and resumes together, and the player shows who it is waiting for
- **Mid-stream join** — late joiners hard-seek to the current position the moment their player is ready
- **Seamless reconnects** — a stable per-browser identity keeps your seat, nickname, color, and host status across drops; a grace window suppresses join/leave spam on flaky wifi
- **Host controls** — first user to create the room is host; can lock player controls for everyone else; can **kick or ban** disruptive users (a ban blocks rejoining the room); can **hand host to someone else**; a persistent host token survives reconnects; host migrates to the longest-present viewer when the host actually leaves
- **Queue** — line up multiple videos, reorder them, jump straight to any of them, auto-advance when one ends
- **YouTube title resolution** — queue/now-playing entries swap from URL to real title via YouTube oEmbed; deep-links with `?t=` / `?start=` start at the right spot
- **Full YouTube subtitles** — the embedded player is served fewer caption languages than youtube.com (no auto-translate catalog), so a CC menu on the player lists *every* language (uploaded + auto-generated + auto-translated) via the resolver and renders the chosen track as an overlay; per-viewer choice, remembered across videos
- **Chat** with persistent in-room history for late joiners, per-user colors, timestamps, auto-linking URLs, **clickable video timestamps** (`look at 12:34` jumps the room there), **typing indicators**, unread badge, optional ping sound, browser tab-title flash
- **Floating emoji reactions** that drift up over the video for everyone
- **Picture-in-Picture** for direct/HLS video, plus a light/dark theme toggle
- **Keyboard shortcuts** — Space/K (play/pause), ←/→ (±5s), J/L (±10s), F (fullscreen), M (mute); `?` lists them in the room
- **Resync button** + live ping indicator in the topbar
- **Persistent room** toggle (host) — prevents the empty-room auto-reap
- **Hardened** — per-seat secret tokens (a public `client_id` can't hijack a seat or host status); rate limits on chat and reactions plus a global flood guard; per-connection throttling of expensive intents (change video, queue add); per-IP limits on room creation, subtitles, and register/login, plus a per-username login limiter; Nginx edge rate limits in front of all of it; HTML/control-character stripping; an SSRF guard on pasted URLs; strict CSP and security headers; containers with dropped capabilities, `no-new-privileges`, and memory/CPU/PID limits; graceful shutdown

## Supported media

| Source | Support | Notes |
|---|---|---|
| YouTube (`youtube.com`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`, `music.youtube.com`) | First-class | IFrame API, title via oEmbed |
| HLS streams (`.m3u8`) | First-class | Remuxed through the server-side HLS proxy; plays via HLS.js |
| Direct video (`.mp4`, `.webm`, `.ogg`, `.mov`, `.mkv`, `.m4v`, …) | First-class | Server-side ffmpeg remux to HLS: video passes through, audio is transcoded to AAC — so MKV's AC-3/DTS audio just works |
| Vimeo, Twitch, Dailymotion, Reddit, etc. | Built-in (best-effort) | Resolved by the bundled **yt-dlp resolver** sidecar (~1800 sites), then muxed server-side — separate video+audio sources (e.g. Reddit) are merged, and CDN auth headers are replayed by ffmpeg. See [yt-dlp resolver](#yt-dlp-resolver) |
| Any other URL | Best-effort | Direct media URLs (known extensions, `.m3u8`) go straight to ffmpeg; anything else is tried via the resolver first. With `RESOLVER_URL` unset the page URL is handed to ffmpeg as-is, which usually fails |
| Netflix, Disney+, etc. | Not possible | DRM-protected; no shared-stream model works for these |

Everything except YouTube plays through a **server-side HLS proxy**: one ffmpeg per room remuxes the source into HLS segments on a RAM-backed volume (`watchsync-streams`), which Nginx serves at `/api/streams/…` with no upstream hop. Viewers never talk to the origin, so CORS, auth headers, and codec quirks are handled once, server-side.

---

## Install

**Requirements**

- A Linux host with Docker and Docker Compose v2 (or Portainer)
- A reverse proxy for HTTPS (Nginx Proxy Manager, Traefik, Caddy, …) — YouTube's IFrame API requires HTTPS in modern browsers
- A Docker network your reverse proxy is attached to. This README calls it `proxy`; only the `watchsync-client` container joins it. If yours has a different name, add `name: <your network>` under `networks: proxy:` at the bottom of [docker-compose.yml](docker-compose.yml)

[docker-compose.yml](docker-compose.yml) has no `build:` sections, so the same file can be pasted into Portainer's web editor. That's why you build the three WatchSync images yourself; the fourth container (`watchsync-bgutil`) is pulled from Docker Hub.

> [!IMPORTANT]
> Before building the client image, put your own name and contact email into the privacy notice — the repository ships placeholders. See [Privacy policy](#privacy-policy-gdpr--dsgvo).

### Option A — Docker Compose

```bash
git clone https://github.com/Houdini99/WatchSync.git
cd WatchSync

cp .env.example .env
$EDITOR .env                                  # set PUBLIC_ORIGIN to your https URL
$EDITOR frontend/src/components/Privacy.tsx   # REQUIRED: your name + contact email

docker network create proxy                   # skip if it already exists

docker build -t watchsync-server:latest   ./backend
docker build -t watchsync-client:latest   ./frontend
docker build -t watchsync-resolver:latest ./resolver

docker compose up -d
docker compose ps                             # wait until all four are "healthy"
```

The containers start one after another, each waiting for the previous one to be healthy (bgutil → resolver → server → client), so the first start takes a couple of minutes. Then [connect your reverse proxy](#connect-your-reverse-proxy).

```bash
docker compose logs -f                        # everything
docker compose logs -f watchsync-server       # just the server
```

### Option B — Portainer

Portainer's web editor can't build images, so build them on the host first.

**1. Get the source, fill in the privacy notice, build the images**

```bash
git clone https://github.com/Houdini99/WatchSync.git
cd WatchSync
$EDITOR frontend/src/components/Privacy.tsx   # REQUIRED: your name + contact email
docker build -t watchsync-server:latest   ./backend
docker build -t watchsync-client:latest   ./frontend
docker build -t watchsync-resolver:latest ./resolver
docker network create proxy                   # skip if it already exists
```

**2. Deploy the stack**

- **Stacks** → **Add stack** → name it `watchsync` (the volume names in this README assume that name)
- **Web editor** → paste [docker-compose.yml](docker-compose.yml)
- **Environment variables** → add `PUBLIC_ORIGIN` = `https://watch.yourdomain.com`, plus any other variable from [Configuration](#configuration)
- **Deploy the stack**, then [connect your reverse proxy](#connect-your-reverse-proxy)

> If you'd rather have `docker compose` build the images for you, add `build: ./backend`, `build: ./frontend`, and `build: ./resolver` to the three services. They're left out so the file stays paste-able into Portainer, where no source tree exists.

### Connect your reverse proxy

Point your proxy host at the **client** container:

- **Forward Hostname / IP:** `watchsync-client`
- **Forward Port:** `80`
- **Scheme:** `http` *(SSL terminates at the proxy, not the container)*
- **Websockets Support:** **ON** *(required for the `/ws` sync channel)*
- Attach an SSL certificate (Let's Encrypt), and set HSTS there if you want it — the client container doesn't

If your reverse proxy runs in Docker, attach it to the `proxy` network:

```bash
docker network connect proxy <your-proxy-container-name>
```

Visit your domain and click **Create a Room**. Open `/privacy` once to check that it shows your details, not the placeholders.

---

## Updating

```bash
cd WatchSync
git pull --autostash        # keeps your Privacy.tsx edits; on a conflict, keep your CONTROLLER values

docker build -t watchsync-server:latest   ./backend
docker build -t watchsync-client:latest   ./frontend
docker build -t watchsync-resolver:latest ./resolver

docker compose up -d        # recreates the containers whose image or config changed
```

**Portainer:** after building, open the stack → **Editor**, paste the new [docker-compose.yml](docker-compose.yml) if it changed, then **Update the stack**. Leave "Re-pull image" off — the three WatchSync images only exist on your host.

The client and server are deployed as a pair (the client's Nginx config proxies to the server under a network alias defined in the compose file), so always update both together.

---

## Configuration

Set variables in `.env` (Docker Compose) or in the stack's **Environment variables** (Portainer). Anything you don't set uses the built-in default. [.env.example](.env.example) lists the variables from the tables below with their defaults (all but the collapsed advanced section). The server and resolver read them at startup, so a change only needs `docker compose up -d` (Portainer: **Update the stack**), no image rebuild.

`PUBLIC_ORIGIN` and `STREAMS_TMPFS_SIZE` are read by [docker-compose.yml](docker-compose.yml) itself; everything else is passed through to the containers. The defaults live in [backend/src/config.rs](backend/src/config.rs) and [resolver/app.py](resolver/app.py).

**Basics**

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_ORIGIN` | `*` | Your public https URL, e.g. `https://watch.example.com`. The compose file passes it to the server as `CORS_ORIGIN`, which controls CORS **and** which origins may open the WebSocket. `*` allows any origin — for testing only. Comma-separate several |
| `LOG_LEVEL` | `info` | Server log verbosity: `trace` / `debug` / `info` / `warn` / `error` (passed to the server as `RUST_LOG`, so full `RUST_LOG` filter syntax works too) |
| `ALLOW_PRIVATE_URLS` | `false` | Allow media URLs that resolve to private/LAN addresses (your Jellyfin, a NAS, …). Leave off on a public instance — pasted URLs are fetched server-side, so this opens an SSRF hole into your Docker network. Applies to both server and resolver |
| `TRUSTED_PROXIES` | private + loopback ranges | Peers whose `X-Real-IP` / `X-Forwarded-For` the server believes when keying per-IP rate limits. The default fits the bundled Nginx. Set it explicitly empty (`TRUSTED_PROXIES=`) to trust nothing — only correct if you expose the server directly |
| `RESOLVER_URL` | `http://watchsync-resolver:8080` | The yt-dlp resolver sidecar, used by the server when preparing a stream and by `/api/subtitles`. Empty → subtitles return 501 and non-direct links are handed to ffmpeg unresolved |

**Streaming** (the server-side HLS proxy)

| Variable | Default | Purpose |
|---|---|---|
| `STREAMS_TMPFS_SIZE` | `2g` | Size of the RAM-backed `watchsync-streams` volume shared by all rooms. A proxied video stays on it in full while its room lives, so size it for your longest/highest-bitrate files. Only applied when the volume is created — see [Troubleshooting](#troubleshooting) to resize |
| `STREAM_MAX_BYTES` | `1073741824` (1 GiB) | Per-room ceiling on ffmpeg's output, so one long, high-bitrate video can't fill the shared volume and break every other room's stream. A stream that hits it ends early |
| `HLS_SEGMENT_SEC` | `4` | Target HLS segment length |
| `STREAM_AUDIO_BITRATE` | `192k` | AAC bitrate for the transcoded audio track |
| `STREAM_READY_TIMEOUT_SEC` | `30` | How long to wait for ffmpeg's first playable playlist before flagging the stream as failed |

**Rooms & sync**

| Variable | Default | Purpose |
|---|---|---|
| `MAX_USERS_PER_ROOM` | `50` | Hard cap on live users per room |
| `MAX_ROOMS` | `5000` | Global room cap (evicts the oldest empty room when full) |
| `MAX_QUEUE_LENGTH` | `200` | Max items in a room's queue |
| `CHAT_HISTORY_LIMIT` | `80` | Messages kept per room and replayed to late joiners |
| `EMPTY_ROOM_TTL_MS` | `300000` (5 min) | Reap empty rooms after this long, unless the host marked the room **Persist** |
| `RECONNECT_GRACE_MS` | `12000` | Hold a dropped user's seat this long before "left" / host migration |
| `HEARTBEAT_MS` | `4000` | Drift-correction broadcast interval |
| `DRIFT_TOLERANCE_SEC` | `1.5` | How far out of sync a viewer may be before the client starts correcting. Moderate drift is closed by a slight speed change; only gaps over 5s seek |
| `ALLOWED_RATES` | `0.25,0.5,0.75,1,1.25,1.5,1.75,2` | Playback speeds offered in the UI (values up to 4); the server rejects any other speed |

**Accounts**

| Variable | Default | Purpose |
|---|---|---|
| `REGISTRATION_ENABLED` | `true` | Allow new signups. Set `false` to close registration — existing accounts keep working |
| `MAX_ROOMS_PER_USER` | `5` | Custom room names one account may hold (anti-squatting) |
| `SESSION_TTL_DAYS` | `30` | Session cookie lifetime; sliding (refreshed on use) |
| `COOKIE_SECURE` | `true` | Mark the session cookie HTTPS-only. Browsers exempt `localhost`, so dev works; set `false` only for a plain-HTTP LAN install |

**Resolver** (`watchsync-resolver`)

| Variable | Default | Purpose |
|---|---|---|
| `POT_PROVIDER_URL` | `http://watchsync-bgutil:4416` | PO-token provider for YouTube caption attestation. Empty → subtitle listing still works, but auto-translated tracks are usually rejected |
| `RESOLVE_TIMEOUT` | `20` | Per-extraction socket timeout, seconds |
| `SUBS_CACHE_TTL` | `900` | How long extracted subtitle-track metadata is cached, seconds |
| `BODY_CACHE_MAX_BYTES` | `25165824` (24 MiB) | Cache for fetched subtitle bodies |
| `RESOLVER_MAX_CONCURRENT` | `4` | Parallel yt-dlp extractions |
| `RESOLVER_SLOT_WAIT` | `20` | How long a request waits for a free slot before the resolver answers 503 "busy", seconds |
| `RESOLVER_LOG` | `1` | Access + failure log to stdout; `0` silences it (the access log contains full media URLs — see [Privacy policy](#privacy-policy-gdpr--dsgvo)) |

<details>
<summary><b>Fixed by the compose file, and advanced server settings</b></summary>

These are set in [docker-compose.yml](docker-compose.yml) or the image and only matter if you run the server outside Docker:

| Variable | Value under Docker | Purpose |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Server bind address and port. Changing the port also means editing both `proxy_pass` lines in [frontend/nginx.conf](frontend/nginx.conf) and the server's healthcheck |
| `DATABASE_PATH` | `/data/watchsync.db` | SQLite file for the account layer, on the `watchsync-data` volume. Running bare, it defaults to `data/watchsync.db` relative to the working directory |
| `STREAMS_DIR` | `/dev/shm/streams` | Where ffmpeg writes per-room HLS. Under Docker it must match the volume mounts in the compose file and the `alias` in `frontend/nginx.conf`, so leave it alone |
| `RESOLVER_URL` (bare) | unset | Without the compose file, the resolver is off unless you set this |

The server also reads these, but the compose file does **not** pass them through. To use one under Docker, add its name as a line (e.g. `- CHAT_MAX_LEN`) to the `environment:` list of `watchsync-server` in [docker-compose.yml](docker-compose.yml):

| Variable | Default | Purpose |
|---|---|---|
| `NICKNAME_MAX_LEN` / `CHAT_MAX_LEN` / `URL_MAX_LEN` | `24` / `500` / `2048` | Input length caps |
| `CHAT_BUCKET_CAP` / `_REFILL` | `5` / `0.5` | Chat messages per connection (burst / per second) |
| `REACTION_BUCKET_CAP` / `_REFILL` | `8` / `2` | Reactions per connection |
| `GLOBAL_BUCKET_CAP` / `_REFILL` | `40` / `20` | All messages per connection (flood guard) |
| `HEAVY_BUCKET_CAP` / `_REFILL` | `6` / `1` | Change-video / queue-add per connection |
| `HTTP_ROOM_BUCKET_CAP` / `_REFILL` | `10` / `0.2` | Room creation per IP |
| `HTTP_RESOLVE_BUCKET_CAP` / `_REFILL` | `15` / `0.5` | Subtitle requests per IP |
| `HTTP_AUTH_BUCKET_CAP` / `_REFILL` | `10` / `0.2` | Register/login per IP |
| `LOGIN_USER_BUCKET_CAP` / `_REFILL` | `10` / `0.1` | Login attempts per username, across all IPs |

</details>

---

## Accounts & custom room URLs (optional)

Everything above works with zero signup — accounts only *add*:

- **Register** (top-right on the landing page): username + password, no email. Passwords are argon2id-hashed; the session is an HttpOnly `SameSite=Lax` cookie whose token is stored server-side only as a SHA-256 hash.
- **Claim a permanent room name** — `/r/movie-night` instead of `/r/x7k2m9qe4w`. Names are 3–32 chars (lowercase letters, digits, hyphens), capped at `MAX_ROOMS_PER_USER` per account, managed from the **My rooms** panel on the landing page (open / copy link / release).
- **Permanent URL, ephemeral state.** The *registration* lives in SQLite forever; the room *state* stays in-memory exactly like an ad-hoc room. When a registered room empties it is reaped as usual (freeing ffmpeg/RAM) — the next visitor to the URL gets a fresh instance under the same name. Share the link once, use it every movie night.
- **The owner is always host.** Joining one of your rooms (signed in) grants you host on the spot — even reclaiming it if host had migrated to someone else while you were away. If you hand host to someone yourself, it stays with them until you next arrive; a reconnect does not take it back. Guests joining before the owner behave exactly like an ad-hoc room (first in hosts) until the owner arrives.
- **Signed-in niceties:** your display name prefills the nickname prompt (and is the server-side default), and your session rides the WebSocket automatically — no tokens to manage across devices.

### Admin tasks

The database is one SQLite file (`watchsync.db`, WAL mode) on the `watchsync-data` volume. Deleting that volume deletes every account and claimed room name. `REGISTRATION_ENABLED=false` freezes signups without touching existing users.

**Back up** — stop the server so the copy is consistent, copy the volume's contents, start it again:

```bash
docker stop watchsync-server
sudo cp -a "$(docker volume inspect -f '{{.Mountpoint}}' watchsync_watchsync-data)" ./watchsync-data-backup
docker start watchsync-server
```

**Reset a password** — there's no email, so the admin deletes the account and the person re-registers. Needs the `sqlite3` CLI on the host; usernames are stored lowercase:

```bash
docker stop watchsync-server
sudo sqlite3 "$(docker volume inspect -f '{{.Mountpoint}}' watchsync_watchsync-data)/watchsync.db" \
  "PRAGMA foreign_keys=ON; DELETE FROM users WHERE username='name';"
docker start watchsync-server
```

Keep the `PRAGMA foreign_keys=ON`: the `sqlite3` CLI doesn't enforce foreign keys by default, and without it the person's sessions and claimed room names stay behind. With it, their room names are released and can be re-claimed after re-registering.

---

## yt-dlp resolver

Plays links from Vimeo, Twitch, Dailymotion, Reddit, and about 1800 other sites. This is **built in**: the stack ships a small `watchsync-resolver` container ([resolver/](resolver/)) — a Python HTTP service that uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) as a library to turn a page URL into direct stream URLs.

**Flow:** the resolver is reached **only by the server**, never by the browser. When a room loads a link that is neither YouTube nor a direct media URL, `stream::prepare_source` calls the resolver over the private Docker network and gets back `{ video_url, audio_url, video_headers, audio_headers, title, is_live, kind }` — separate video and audio streams plus the request headers ffmpeg must replay against signed CDN URLs. ffmpeg then muxes both into the room's HLS output. Direct media URLs (`.mp4`, `.m3u8`, …) short-circuit *before* the resolver; YouTube skips it entirely and plays through the IFrame API.

The browser only ever talks to `/api/subtitles` and `/api/subtitles/track`, which proxy the resolver's caption extraction.

**Keeping it working:** sites change constantly, so bump yt-dlp periodically. The version is pinned in [resolver/Dockerfile](resolver/Dockerfile): edit `ARG YTDLP_VERSION` there and rebuild, or override it for a single build (the next plain build goes back to the pinned version):

```bash
docker build --build-arg YTDLP_VERSION=<new version> -t watchsync-resolver:latest ./resolver
```

Bump `POT_PLUGIN_VERSION` (same Dockerfile) and the `brainicism/bgutil-ytdlp-pot-provider` image tag in [docker-compose.yml](docker-compose.yml) together — upstream requires the plugin and the provider server to match.

**Disabling it:** set `RESOLVER_URL=` (empty), then delete the `watchsync-resolver` and `watchsync-bgutil` services from docker-compose.yml, along with the `depends_on:` block under `watchsync-server` that waits for the resolver. Subtitles then return 501, and non-direct links are handed to ffmpeg unresolved (usually a failure).

**Limitations (best-effort by nature):**
- Extractors break as sites change — bump yt-dlp when a site stops resolving.
- Live streams are served as a sliding window (no rewinding a live source).
- **DRM** services (Netflix, Disney+, …) are impossible regardless.

Separate audio/video pairs and auth-header-protected CDN URLs are no longer limitations: the server-side ffmpeg proxy merges the pair and replays yt-dlp's request headers.

**Security note:** pasted URLs are fetched **server-side** (yt-dlp in the resolver, ffmpeg in the server) — an inherent SSRF surface. Both services therefore refuse URLs whose host resolves to a private, loopback, link-local, or otherwise internal address. If you *want* to play media from your LAN (Jellyfin, a NAS, …), set `ALLOW_PRIVATE_URLS=true` — only do that on an instance you don't expose to strangers. Redirects that ffmpeg or yt-dlp follow after the initial check are not re-validated, so treat the guard as a strong default, not a sandbox. The resolver itself stays internal (no published port, no edge route).

### YouTube subtitles

YouTube serves its **embedded** player a reduced caption dataset: the uploaded tracks are there, but the auto-translate catalog (`translationLanguages`, ~156 languages on youtube.com) is only sent to the watch page. That's why languages "disappear" in any site that embeds YouTube. WatchSync works around it app-side:

- `GET /api/subtitles?url=…` → the resolver extracts **every** available track (uploaded / auto-generated / auto-translated) from watch-page data and returns one entry per language, including a direct CORS-enabled `timedtext` URL.
- YouTube rejects **auto-translated** (`tlang=`) caption requests without BotGuard attestation (429). The `watchsync-bgutil` sidecar mints "PO tokens" that the resolver attaches to every caption URL, so the client's CC menu (top-right of the player) can fetch the chosen track as WebVTT **directly in the viewer's browser**. The `GET /api/subtitles/track?url=…&lang=…` server proxy is the fallback — fully reliable for uploaded/auto-generated tracks, best-effort (retried, then cached for an hour) for translated ones, since YouTube heavily throttles translation requests from server/datacenter IPs regardless of tokens.
- Cues render as an overlay above the iframe; the language choice is per-viewer (not synced) and remembered across videos. Track metadata is cached in the resolver for 15 minutes (`SUBS_CACHE_TTL`).
- To disable: set `POT_PROVIDER_URL=` (empty), then delete the `watchsync-bgutil` service and the resolver's `depends_on:` block that waits for it. Listing still works, but translated tracks will usually be rejected by YouTube.

---

## Privacy policy (GDPR / DSGVO)

The client ships a privacy notice at **`/privacy`** (alias `/datenschutz`), written for a
**privately operated, non-commercial** instance in Germany / the EU. It is bilingual — German
by default for German-language browsers, English otherwise — and reflects what this codebase
actually does: in-memory rooms reaped 5 min after the last participant leaves, an 80-message
chat cap, `localStorage` keys one by one, the optional no-email account layer, Argon2id
password hashes, the `ws_session` cookie, per-IP rate-limit buckets, and the one third party
(YouTube → Google).

> [!IMPORTANT]
> **You have to fill in the controller details yourself.** The repository ships placeholders
> (`[Your full name]`, `privacy@example.com`) in the `CONTROLLER` block at the top of
> [`frontend/src/components/Privacy.tsx`](frontend/src/components/Privacy.tsx). Whoever runs an
> instance is the controller under the GDPR, so replace them with your own details before going
> live. The notice is compiled into the client image: edit the file *before*
> `docker build ./frontend`, and rebuild the client after every change to it.

| Field | Notes |
|---|---|
| `name` | Your real name as the controller (Art. 13(1)(a) GDPR). Required — replace the placeholder. |
| `email` | A working contact address. Required — replace the placeholder. |
| `address` | Optional — a private, non-commercial service has no `§ 5 DDG` Impressum duty, so a postal address is not required. Leave the array empty to omit the block. |
| `hoster` | Optional — whoever runs the machine, named as an Art. 28 processor. Empty renders the unnamed wording, which Art. 13(1)(e) already satisfies. |
| `authority` | Your state's data-protection authority (Art. 77). Empty falls back to a link to the BfDI list. |

Also bump `LAST_UPDATED` whenever the notice changes.

> **Logs.** The resolver's access log (on by default) records each request line, which includes
> the full media URL being resolved. If that doesn't match what your notice promises, set
> `RESOLVER_LOG=0`. The server's own ffmpeg log lines keep only the host.

> **Note on YouTube.** The IFrame API is *not* in `index.html`. `YouTubePlayer` injects it the
> first time a YouTube video is actually played, and queue thumbnails for YouTube items come from
> `i.ytimg.com`. So Google sees nothing from visitors who only open the landing page or a room
> without YouTube content. Keep it that way — putting the `<script>` back in `index.html` would
> hand Google every visitor's IP on page load and undercut section 7.1 of the policy.

---

## Troubleshooting

**The stack takes minutes to start, or a container stays "starting"** — containers start in order, each waiting for the previous one to be healthy: `watchsync-bgutil` → `watchsync-resolver` → `watchsync-server` → `watchsync-client`. Run `docker compose ps` (or check the stack in Portainer) and look at the logs of the first one that isn't healthy.

**502 Bad Gateway from the reverse proxy** — usually the proxy container isn't on the `proxy` network. Check `docker network inspect proxy`; attach it with `docker network connect proxy <proxy-container>`. Also confirm the forward host is `watchsync-client` over `http`, and that `watchsync-client` is running (it only starts once the server is healthy).

**WebSocket fails / chat doesn't work but the page loads** — enable **Websockets Support** on your proxy host for this domain. Also note the server rejects socket upgrades from origins outside `PUBLIC_ORIGIN` — make sure it matches the URL in the browser exactly (scheme included, no trailing path).

**Non-YouTube videos stuck on "Preparing stream…" or failing to load** — check that the `watchsync-streams` volume is mounted in *both* `watchsync-server` and `watchsync-client` (`docker inspect <container> --format '{{json .Mounts}}'`). Then check `docker logs watchsync-server`: a failed ffmpeg run is logged with the tail of what ffmpeg said (URLs reduced to their host), e.g. `HTTP error 403 Forbidden` from the origin. `ffmpeg exited cleanly but … is empty — is the streams volume full?` means exactly that: several long films share the volume, and ffmpeg quietly writes empty files once it is full — raise `STREAMS_TMPFS_SIZE`.

**`STREAMS_TMPFS_SIZE` change has no effect** — the size is fixed when the volume is first created. Remove the volume so it's recreated with the new size. It only holds stream scratch data, and rooms live in memory, so they reset on any restart anyway:

```bash
docker compose down
docker volume rm watchsync_watchsync-streams
docker compose up -d
```

In Portainer: stop the stack, delete `watchsync_watchsync-streams` under **Volumes**, start the stack.

**A LAN/private URL is rejected with "not allowed"** — that's the SSRF guard. Set `ALLOW_PRIVATE_URLS=true` if the instance isn't publicly reachable (or you accept the risk).

**`/privacy` shows `[Your full name]`** — the placeholders are still in [Privacy.tsx](frontend/src/components/Privacy.tsx). Fill them in and rebuild the client image.

**`watchsync-bgutil` shows unhealthy** — the healthcheck must probe `http://127.0.0.1:4416/ping` via `node` (the image has no python and listens on 4416); the bundled compose file does this correctly.

---

## Development

Run the server and client locally without Docker:

```bash
# Terminal 1 — Rust server
cd backend
cargo run                          # listens on 0.0.0.0:3000

# Terminal 2 — Vite dev server (proxies /api and /ws to :3000)
cd frontend
npm install
npm run dev                        # http://localhost:5173
```

You need a stable Rust toolchain (the Docker image builds with 1.90) and Node 22.7 or newer. The Vite dev server proxies `/api` and `/ws` to `http://127.0.0.1:3000` (see [vite.config.ts](frontend/vite.config.ts)), so the app works end-to-end without Nginx. Accounts work in dev too: the SQLite file defaults to `backend/data/watchsync.db` (gitignored, created on first run), and browsers exempt `localhost` from the `Secure` cookie flag so no config change is needed. Non-YouTube playback additionally needs `ffmpeg` on your `PATH`, and resolver-backed sites need a running resolver — with `RESOLVER_URL` unset (the default outside Docker), non-direct links are handed straight to ffmpeg and `/api/subtitles` returns 501.

**Tests and checks** (no extra dependencies beyond each toolchain):

```bash
(cd backend && cargo test && cargo clippy --all-targets)          # room state, CORS, URL/IP guards
(cd frontend && npm test && npm run typecheck && npm run lint)   # sync engine, player adapters, helpers
python3 -m unittest discover -s resolver -v                      # resolver SSRF gate (yt-dlp is stubbed)
```

`npm test` runs the TypeScript sources directly through Node's built-in type stripping, so the frontend code must stay free of syntax that needs compiling (enums, parameter properties, namespaces). `erasableSyntaxOnly` in [tsconfig.json](frontend/tsconfig.json) makes `npm run typecheck` enforce that.

---

## How it works

```
                 ┌─────────────────────────────────────────┐
                 │  Your reverse proxy (NPM / Traefik / …)  │
                 │  https://watch.example.com → :80         │
                 └────────────────────┬─────────────────────┘
                                      │ external `proxy` network
                  ┌───────────────────▼─────────────────────┐
                  │  watchsync-client  (Nginx + React build) │
                  │  • Serves the static SPA                 │
                  │  • Reverse-proxies /ws and /api → server │
                  │  • Serves /api/streams/ straight off the │
                  │    shared watchsync-streams tmpfs volume │
                  │  • Ships the CSP + security headers      │
                  └───────────────────┬─────────────────────┘
                                      │ private `watchsync-internal` network
                  ┌───────────────────▼─────────────────────┐
                  │  watchsync-server  (Rust: axum + tokio)  │
                  │  • Authoritative room state (in-memory)  │
                  │  • Native-WebSocket sync engine          │
                  │  • Spawns ffmpeg per room → HLS onto the │
                  │    shared watchsync-streams tmpfs volume │
                  └───────────────────┬─────────────────────┘
                                      │ (internal only)
                  ┌───────────────────▼─────────────────────┐
                  │  watchsync-resolver  (Python + yt-dlp)   │
                  │  • Page URL → stream URLs + headers      │
                  └───────────────────┬─────────────────────┘
                                      │ (internal only)
                  ┌───────────────────▼─────────────────────┐
                  │  watchsync-bgutil  (PO-token provider)   │
                  │  • YouTube caption attestation tokens    │
                  └──────────────────────────────────────────┘
```

> ⚠️ The `watchsync-streams` volume must be mounted in **both** the server and
> the client container (the compose file does this). Without it, ffmpeg writes
> into one container while Nginx reads an empty directory in the other, and
> every non-YouTube stream 404s.

- **Server** holds `{ media, current_time, paused, rate, last_update, queue, users, chat_history, … }` per room in an in-memory map behind a `RwLock`. Clients send *intents* (play, pause, seek, set-rate, queue, chat, reaction, typing); the server validates them and broadcasts a fresh snapshot.
- **Position is never a moving value.** It's stored as `current_time` frozen at `last_update`; the *live* position is extrapolated on demand as `current_time + wall_clock_elapsed × rate`. That keeps pauses and speed changes exact.
- **Identity** is a stable `client_id` the browser generates once and persists in `localStorage`. Rooms key users by it, so a reconnecting socket reclaims the same seat, nickname, color, and host status. A grace window (`RECONNECT_GRACE_MS`) holds the seat before announcing "left" / migrating host.
- **Echo suppression:** every connection gets a `conn_id`; broadcasts carry the originating `caused_by` so the actor ignores the echo of its own action. A 4s heartbeat drift-corrects everyone else.
- **Graded drift correction** ([`SyncEngine.ts`](frontend/src/sync/SyncEngine.ts)). Seeking is the most disruptive fix available — it re-buffers from the previous keyframe — so small drift is left alone, moderate drift (up to 5s) is closed by playing up to 10% fast or slow, and only larger gaps seek, followed by a cooldown so a seek still landing is never measured as new drift. A viewer whose target position isn't buffered yet (the HLS proxy is still muxing) holds the room instead of seeking into a hole, and a paused room lines everyone up on its exact position.
- **Only the client is edge-facing.** It's the only container on the `proxy` network; the server, resolver, and bgutil sidecar sit on a private `watchsync-internal` network, publish no ports, and have no edge route. Nginx reaches the server under the alias `watchsync-server-int`, which nothing on the shared network can shadow.

### Tech stack

- **Server:** Rust — [axum](https://github.com/tokio-rs/axum) (HTTP + WebSocket), [tokio](https://tokio.rs), [serde](https://serde.rs), [reqwest](https://github.com/seanmonstar/reqwest) (oEmbed, resolver calls), [nanoid](https://crates.io/crates/nanoid). Room state is in-memory; the optional account layer (users, sessions, registered room names) lives in a single SQLite file via [sqlx](https://github.com/launchbadge/sqlx), with passwords hashed by [argon2](https://crates.io/crates/argon2).
- **Client:** [React 18](https://react.dev) + [TypeScript](https://www.typescriptlang.org) + [Vite](https://vitejs.dev) + [Tailwind CSS](https://tailwindcss.com), [Zustand](https://github.com/pmndrs/zustand) for state, [HLS.js](https://github.com/video-dev/hls.js) (lazy), the YouTube IFrame API (also lazy — see [Privacy policy](#privacy-policy-gdpr--dsgvo)), and a native reconnecting `WebSocket`.
- **Protocol:** JSON over a single native WebSocket (`/ws`). Each frame has a `type` discriminator; the message set is defined once in [`backend/src/protocol.rs`](backend/src/protocol.rs) and mirrored in [`frontend/src/types.ts`](frontend/src/types.ts).
- **Infra:** four containers — the Rust server (`debian:bookworm-slim` + ffmpeg), the Nginx Alpine client, the Python/yt-dlp resolver (`python:3.12-slim`), and the upstream `bgutil-ytdlp-pot-provider` sidecar. The client joins your external `proxy` network; the other three share a private bridge network. Two named volumes: `watchsync-streams` (tmpfs, per-room HLS) and `watchsync-data` (durable, the SQLite accounts DB).

### Repository layout

```
backend/                 Rust sync server
  src/
    main.rs              axum app, HTTP routes, CORS, graceful shutdown
    config.rs            every tunable, read from environment variables
    protocol.rs          ClientMsg / ServerMsg wire types
    state.rs             Room / User / VideoState + the in-memory store
    ws.rs                WebSocket loop, intent dispatch, heartbeat, lifecycle
    stream.rs            per-room ffmpeg → HLS proxy (spawn/supervise/teardown)
    media.rs             URL classification, SSRF guard, YouTube oEmbed titles
    auth.rs              optional accounts: register/login/logout/me, sessions
    registry.rs          persistent custom room slugs (claim/list/release)
    db.rs                SQLite pool + queries (users, sessions, registered rooms)
    sanitize.rs          input hardening (lengths, HTML, control characters)
    rate_limit.rs        per-connection token bucket
    http_limit.rs        per-IP token bucket for the HTTP routes
  migrations/            embedded SQL migrations for the accounts database
  Dockerfile             multi-stage → debian slim runtime (incl. ffmpeg)
frontend/                React + Vite client
  src/
    client.ts            WatchSyncClient — socket + sync engine + player glue
    store.ts             Zustand UI store
    sync/                SyncEngine + player adapters (HTML5/HLS, YouTube)
    components/          React UI (Room, TopBar, VideoPlayer, Chat, Queue, …)
      Privacy.tsx        bilingual (DE/EN) GDPR privacy notice — fill in the
                         CONTROLLER block before going live
    lib/                 socket, identity, API wrappers, captions/VTT, sound,
                         router (nav.ts), chat timestamps, URL helpers
  tests/                 node:test suites (sync engine, players, timestamps, URLs)
  Dockerfile             multi-stage → Nginx serving the build
  nginx.conf             SPA, /ws + /api reverse proxy, HLS files, edge rate limits
  security-headers.conf  CSP + security headers, included in every nginx location
resolver/                yt-dlp resolver sidecar (Python; internal-only)
  app.py                 /resolve (video+audio URLs, headers, title),
                         /subtitles/list + /subtitles/get, /healthz
  test_app.py            SSRF-gate tests (yt-dlp is stubbed)
  Dockerfile             python:3.12-slim + pinned yt-dlp + bgutil PO-token plugin
docker-compose.yml       the stack: client on the external `proxy` network, the
                         rest on a private network, plus the `watchsync-streams`
                         (tmpfs) and `watchsync-data` volumes
.env.example             every setting with its default — copy to .env
```

### WebSocket protocol

A single connection at `/ws` carries JSON frames discriminated by `type`.

**Client → server (intents):** `join_room`, `change_video`, `play_pause`, `seek`, `set_rate`, `buffering_start`/`buffering_end`, `queue_add`/`queue_remove`/`queue_move`/`queue_skip`/`queue_play`, `kick_user`/`ban_user`/`transfer_host`, `lock_room`, `set_persistent`, `media_title`, `chat_message`, `reaction`, `typing`, `sync_request`, `ping`.

**Server → client:** `welcome` (your `conn_id`), `joined` (ack + effective `client_id` + per-seat `seat_token` + snapshot + chat history + config + your account, if signed in), `join_error`, `kicked` (removed/banned by host), `action_error`, `room_state` (full snapshot + `caused_by`), `heartbeat`, `chat_message`, `system_message`, `reaction`, `typing`, `pong`, `sync_snapshot`.

The full schema is the source of truth in [`backend/src/protocol.rs`](backend/src/protocol.rs).

### Scaling beyond one process

Room state is in-memory. To run multiple server instances behind a load balancer, replace the `HashMap` in [backend/src/state.rs](backend/src/state.rs) with a shared store (e.g. Redis) and fan out broadcasts through a pub/sub channel. The sync logic is contained to `state.rs` and `ws.rs`.

---

## License

MIT.
