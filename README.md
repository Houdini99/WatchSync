# WatchSync

A self-hosted "watch together" web app. Create a room, share the link, watch YouTube videos or direct media files (`.mp4`, `.webm`, `.m3u8`, …) in tight sync with your friends, and chat alongside. No signup required, no tracking, no third-party services beyond YouTube's public IFrame API (and that one is only loaded once a YouTube video is actually played) — with an **optional** account layer for people who want a permanent room URL of their own.

> **v3 — full rewrite.** This is a clean-room rebuild of the original Node/vanilla-JS WatchSync on a modern stack: a **Rust** sync engine (axum + tokio) over native **WebSockets**, and a **React + TypeScript + Vite + Tailwind** client. The room-sync behaviour and feature set are preserved; the implementation is new.

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
- **YouTube title resolution** — queue/now-playing entries swap from URL to real title via YouTube oEmbed; deep-links with `?t=` start at the right spot
- **Full YouTube subtitles** — the embedded player is served fewer caption languages than youtube.com (no auto-translate catalog), so a CC menu on the player lists *every* language (uploaded + auto-generated + auto-translated) via the resolver and renders the chosen track as an overlay; per-viewer choice, remembered across videos
- **Chat** with persistent in-room history for late joiners, per-user colors, timestamps, auto-linking URLs, **clickable video timestamps** (`look at 12:34` jumps the room there), **typing indicators**, unread badge, optional ping sound, browser tab-title flash
- **Floating emoji reactions** that drift up over the video for everyone
- **Picture-in-Picture** for direct/HLS video, plus a light/dark theme toggle
- **Keyboard shortcuts** — Space/K (play/pause), ←/→ (±5s), J/L (±10s), F (fullscreen), M (mute); `?` lists them in the room
- **Resync button** + live ping indicator in the topbar
- **Persistent room** toggle (host) — prevents the empty-room auto-reap
- **Hardened** — per-seat secret tokens (a public client_id can't hijack a seat or host status), rate-limited chat/reactions + global flood guard, per-connection throttling of expensive intents (change-video/queue-add), per-IP limits on the room-create and resolver HTTP routes, HTML/control-char stripping, strict CSP and security headers, graceful shutdown

## Supported media

| Source | Support | Notes |
|---|---|---|
| YouTube (`youtube.com`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`, `music.youtube.com`) | First-class | IFrame API, title via oEmbed |
| HLS streams (`.m3u8`) | First-class | Remuxed through the server-side HLS proxy; plays via HLS.js |
| Direct video (`.mp4`, `.webm`, `.ogg`, `.mov`, `.mkv`, …) | First-class | Server-side ffmpeg remux to HLS: video passes through, audio is transcoded to AAC — so MKV's AC-3/DTS audio just works |
| Vimeo, Twitch, Dailymotion, Reddit, etc. | Built-in (best-effort) | Resolved by the bundled **yt-dlp resolver** sidecar (~1800 sites), then muxed server-side — separate video+audio sources (e.g. Reddit) are merged, and CDN auth headers are replayed by ffmpeg. See [yt-dlp resolver](#yt-dlp-resolver-vimeo-twitch-dailymotion-reddit--1800-sites) |
| Any other URL | Best-effort | Direct media URLs (known extensions, `.m3u8`) go straight to ffmpeg; anything else is tried via the resolver first. With `RESOLVER_URL` unset the page URL is handed to ffmpeg as-is, which usually fails |
| Netflix, Disney+, etc. | Not possible | DRM-protected; no shared-stream model works for these |

Everything except YouTube plays through a **server-side HLS proxy**: one ffmpeg per room remuxes the source into HLS segments on a RAM-backed volume (`watchsync-streams`), which Nginx serves at `/api/streams/…` with no upstream hop. Viewers never talk to the origin, so CORS, auth headers, and codec quirks are handled once, server-side.

## Architecture

```
                 ┌─────────────────────────────────────────┐
                 │  Your reverse proxy (NPM / Traefik / …)  │
                 │  https://watch.example.com → :80         │
                 └────────────────────┬─────────────────────┘
                                      │
                  ┌───────────────────▼─────────────────────┐
                  │  watchsync-client  (Nginx + React build) │
                  │  • Serves the static SPA                 │
                  │  • Reverse-proxies /ws and /api → server │
                  │  • Serves /api/streams/ straight off the │
                  │    shared watchsync-streams tmpfs volume │
                  │  • Ships the CSP + security headers      │
                  └───────────────────┬─────────────────────┘
                                      │ (Docker DNS)
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

- **Server** holds `{ media, current_time, paused, rate, last_update, queue, users, chat_history, … }` per room behind an `Arc<RwLock<…>>`. Clients send *intents* (play, pause, seek, set-rate, queue, chat, reaction, typing); the server validates them and broadcasts a fresh snapshot.
- **Position is never a moving value.** It's stored as `current_time` frozen at `last_update`; the *live* position is extrapolated on demand as `current_time + wall_clock_elapsed × rate`. That keeps pauses and speed changes exact.
- **Identity** is a stable `client_id` the browser generates once and persists in `localStorage`. Rooms key users by it, so a reconnecting socket reclaims the same seat, nickname, color, and host status. A grace window (`RECONNECT_GRACE_MS`) holds the seat before announcing "left" / migrating host.
- **Echo suppression:** every connection gets a `conn_id`; broadcasts carry the originating `caused_by` so the actor ignores the echo of its own action. A 4s heartbeat drift-corrects everyone else.
- **Graded drift correction** ([`SyncEngine.ts`](frontend/src/sync/SyncEngine.ts)). Seeking is the most disruptive fix available — it re-buffers from the previous keyframe — so small drift is left alone, moderate drift (up to 5s) is closed by playing up to 10% fast or slow, and only larger gaps seek, followed by a cooldown so a seek still landing is never measured as new drift. A viewer whose target position isn't buffered yet (the HLS proxy is still muxing) holds the room instead of seeking into a hole, and a paused room lines everyone up on its exact position.
- **Only the client is edge-facing**, which keeps the proxy config tiny — your reverse proxy points at that one container, and it reverse-proxies `/ws` and `/api` internally. The server, resolver, and bgutil sidecar publish no ports and have no edge route.

## Tech stack

- **Server:** Rust — [axum](https://github.com/tokio-rs/axum) (HTTP + WebSocket), [tokio](https://tokio.rs), [serde](https://serde.rs), [reqwest](https://github.com/seanmonstar/reqwest) (oEmbed), [nanoid](https://crates.io/crates/nanoid). Room state is in-memory; the optional account layer (users, sessions, registered room names) lives in a single SQLite file via [sqlx](https://github.com/launchbadge/sqlx), with passwords hashed by [argon2](https://crates.io/crates/argon2).
- **Client:** [React 18](https://react.dev) + [TypeScript](https://www.typescriptlang.org) + [Vite](https://vitejs.dev) + [Tailwind CSS](https://tailwindcss.com), [Zustand](https://github.com/pmndrs/zustand) for state, [HLS.js](https://github.com/video-dev/hls.js) (lazy), the YouTube IFrame API (also lazy — see [Privacy policy](#privacy-policy-gdpr--dsgvo)), and a native reconnecting `WebSocket`.
- **Protocol:** JSON over a single native WebSocket (`/ws`). Each frame has a `type` discriminator; the message set is defined once in [`backend/src/protocol.rs`](backend/src/protocol.rs) and mirrored in [`frontend/src/types.ts`](frontend/src/types.ts).
- **Infra:** four containers on an external Docker network — the Rust server (`debian:bookworm-slim` + ffmpeg), the Nginx Alpine client, the Python/yt-dlp resolver (`python:3.12-slim`), and the upstream `bgutil-ytdlp-pot-provider` sidecar. Two named volumes: `watchsync-streams` (tmpfs, per-room HLS) and `watchsync-data` (durable, the SQLite accounts DB).

## Repository layout

```
backend/                 Rust sync server
  src/
    main.rs              axum app, HTTP routes, CORS, graceful shutdown
    config.rs            env-overridable configuration
    protocol.rs          ClientMsg / ServerMsg wire types
    state.rs             Room / User / VideoState + the in-memory store
    ws.rs                WebSocket loop, intent dispatch, heartbeat, lifecycle
    stream.rs            per-room ffmpeg → HLS proxy (spawn/supervise/teardown)
    media.rs             URL → media classification + YouTube oEmbed titles
    auth.rs              optional accounts: register/login/logout/me, sessions
    registry.rs          persistent custom room slugs (claim/list/release)
    db.rs                SQLite pool + queries (users, sessions, registered rooms)
    sanitize.rs          input hardening
    rate_limit.rs        per-connection token bucket
    http_limit.rs        per-IP token bucket for the HTTP routes
  migrations/            embedded SQL migrations for the accounts database
  Dockerfile             multi-stage → small slim runtime (incl. ffmpeg)
frontend/                React + Vite client
  src/
    client.ts            WatchSyncClient — socket + sync engine + player glue
    store.ts             Zustand UI store
    sync/                SyncEngine + player adapters (HTML5/HLS, YouTube)
    components/          React UI (Room, TopBar, VideoPlayer, Chat, Queue, …)
      Privacy.tsx        bilingual (DE/EN) GDPR privacy policy — edit the
                         CONTROLLER block at the top before going live
    lib/                 socket, identity, api wrappers, captions/VTT, sound
      nav.ts             path router (/, /r/<id>, /privacy) + navigate()
  Dockerfile             multi-stage → Nginx serving the build
  nginx.conf             SPA + /ws + /api reverse proxy + CSP/security headers
resolver/                yt-dlp resolver sidecar (Python; internal-only)
  app.py                 /resolve (video+audio URLs, headers, title) and
                         /subtitles/list + /subtitles/get
  Dockerfile             python:3.12-slim + yt-dlp + bgutil PO-token plugin
docker-compose.yml       Portainer-friendly stack on the external `proxy` network
                         (+ the `watchsync-streams` tmpfs and `watchsync-data`
                         volumes)
```

---

## Install

Requirements:

- A Linux host with Docker (and Docker Compose v2)
- A reverse proxy in front (Nginx Proxy Manager, Traefik, Caddy, …) — needed for HTTPS, which YouTube's IFrame API requires in modern browsers
- An external Docker network shared by the proxy and these containers (this README assumes it's named `proxy`)

### Option A — Plain Docker Compose

The compose file deliberately declares no `build:` contexts, so that the same file can be pasted straight into Portainer's web editor (Option B). Build the three first-party images once, then bring the stack up:

```bash
git clone https://github.com/YOUR-USER/watchsync.git
cd watchsync

cp .env.example .env
$EDITOR .env                       # set PUBLIC_ORIGIN to your https URL
$EDITOR frontend/src/components/Privacy.tsx   # REQUIRED: your name + contact email, see "Privacy policy"

docker network create proxy        # skip if your proxy already created it

docker build -t watchsync-server:latest   ./backend
docker build -t watchsync-client:latest   ./frontend
docker build -t watchsync-resolver:latest ./resolver

docker compose up -d
```

The fourth container (`watchsync-bgutil`) is pulled from Docker Hub. Update later by re-running the three `docker build` commands after a `git pull`, then `docker compose up -d`.

```bash
docker compose logs -f
docker compose logs -f watchsync-server
```

### Option B — Portainer

Portainer's web editor doesn't build images, and the compose file carries no `build:` contexts for exactly that reason — build the images on the host once, then deploy the stack; the `image:` tags in the compose file match.

**1. Get the source, fill in the privacy notice, build the images on the host**

```bash
git clone https://github.com/YOUR-USER/watchsync.git
cd watchsync
$EDITOR frontend/src/components/Privacy.tsx   # REQUIRED: your name + contact email, see "Privacy policy"
docker build -t watchsync-server:latest ./backend
docker build -t watchsync-client:latest ./frontend
docker build -t watchsync-resolver:latest ./resolver
```

**2. Ensure the proxy network exists**

```bash
docker network create proxy        # skip if it already exists
```

**3. Deploy the stack in Portainer**

- **Stacks** → **Add stack** → name it `watchsync`
- **Web editor** → paste [docker-compose.yml](docker-compose.yml)
- Under **Environment variables**, add `PUBLIC_ORIGIN = https://watch.yourdomain.com` (and optionally `LOG_LEVEL = info`)
- **Deploy the stack**

> The `watchsync-bgutil` image is pulled from Docker Hub, so it needs no local build. If you'd rather have Portainer (or `docker compose`) build the three first-party images for you, add `build: ./backend`, `build: ./frontend`, and `build: ./resolver` to the respective services — they're omitted so the file stays paste-able into the web editor, where no source tree exists.

**4. Wire up the proxy**

Point your reverse proxy host at the **client** container:

- **Forward Hostname / IP:** `watchsync-client`
- **Forward Port:** `80`
- **Scheme:** `http` *(SSL terminates at the proxy, not the container)*
- **Websockets Support:** **ON** *(required for the `/ws` sync channel)*
- Attach an SSL certificate (Let's Encrypt)

If your reverse proxy also runs in Docker, attach it to the `proxy` network:

```bash
docker network connect proxy <your-proxy-container-name>
```

Visit your domain and click **Create a Room**.

### Option C — Local development (no Docker)

```bash
# Terminal 1 — Rust server
cd backend
cargo run                          # listens on 0.0.0.0:3000

# Terminal 2 — Vite dev server (proxies /api and /ws to :3000)
cd frontend
npm install
npm run dev                        # http://localhost:5173
```

Tests (no extra dependencies beyond each toolchain):

```bash
(cd backend && cargo test)                   # room state, CORS, URL/IP guards
(cd frontend && npm test)                    # sync engine + player adapters (Node ≥ 22.7)
python3 -m unittest discover -s resolver -v  # resolver SSRF gate (yt-dlp is stubbed)
```

`npm run lint` and `npm run typecheck` round off the frontend checks.

The Vite dev server proxies `/api` and `/ws` to `http://127.0.0.1:3000` (see [vite.config.ts](frontend/vite.config.ts)), so the app works end-to-end without Nginx. Accounts work in dev too: the SQLite file defaults to `backend/data/watchsync.db` (gitignored, created on first run), and browsers exempt `localhost` from the `Secure` cookie flag so no config change is needed. Non-YouTube playback additionally needs `ffmpeg` on your `PATH`, and resolver-backed sites need the sidecar reachable — with `RESOLVER_URL` unset (the bare default), non-direct links fall back to handing the page URL straight to ffmpeg, and `/api/subtitles` returns 501.

## Configuration

Every server knob lives in [backend/src/config.rs](backend/src/config.rs) and is overridable via an environment variable — no rebuild needed. (`PUBLIC_ORIGIN` and `STREAMS_TMPFS_SIZE` are the exceptions: they're read by [docker-compose.yml](docker-compose.yml) itself, which maps `PUBLIC_ORIGIN` onto the server's `CORS_ORIGIN` and sizes the tmpfs volume.)

**Server** (`watchsync-server`):

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_ORIGIN` / `CORS_ORIGIN` | `*` | Origin(s) allowed for CORS. Set to your https URL in production; `*` reflects any origin (testing only). Comma-separate for several. |
| `PORT` | `3000` | Server listen port (internal — change only if you also edit the proxy line in [frontend/nginx.conf](frontend/nginx.conf)) |
| `HOST` | `0.0.0.0` | Server bind address |
| `RUST_LOG` / `LOG_LEVEL` | `info` | Log verbosity: `trace` / `debug` / `info` / `warn` / `error` |
| `RESOLVER_URL` | `http://watchsync-resolver:8080` | Base URL of the yt-dlp resolver sidecar, used server-side when preparing a stream and by `/api/subtitles`. Empty → subtitles return 501 and non-direct links are handed to ffmpeg unresolved |
| `ALLOW_PRIVATE_URLS` | `false` | Allow media URLs that resolve to private/LAN addresses (your Jellyfin, a NAS, …). Leave off on a public instance — pasted URLs are fetched server-side, so this is an SSRF hole into your Docker network. Set on **both** server and resolver (the compose file wires one env var to both) |
| `STREAMS_TMPFS_SIZE` | `2g` | Size of the RAM-backed `watchsync-streams` volume holding per-room HLS. A proxied VOD stays on it in full while the room lives, so size for your longest/highest-bitrate file. Changing it later requires removing the volume first (see comment in the compose file) |
| `STREAMS_DIR` | `/dev/shm/streams` | Where ffmpeg writes per-room HLS. Must match the `alias` in `frontend/nginx.conf` if changed |
| `HLS_SEGMENT_SEC` | `4` | Target HLS segment length |
| `STREAM_AUDIO_BITRATE` | `192k` | AAC bitrate for the transcoded audio track |
| `STREAM_READY_TIMEOUT_SEC` | `30` | How long to wait for ffmpeg's first playable playlist before flagging the stream as failed |
| `STREAM_MAX_BYTES` | `1073741824` (1 GiB) | Per-room ceiling on ffmpeg's HLS output (`-fs`), so one long, high-bitrate video can't fill the shared tmpfs and kill every other room's stream. A stream that hits it ends early |
| `MAX_USERS_PER_ROOM` | `50` | Hard cap on live users per room |
| `MAX_ROOMS` | `5000` | Global room cap (evicts the oldest empty room when full) |
| `MAX_QUEUE_LENGTH` | `200` | Max items in a room's queue |
| `CHAT_HISTORY_LIMIT` | `80` | Messages retained per room and replayed to late joiners |
| `EMPTY_ROOM_TTL_MS` | `300000` | Reap empty, non-persistent rooms after this long |
| `RECONNECT_GRACE_MS` | `12000` | Hold a dropped user's seat this long before "left" / host migration |
| `HEARTBEAT_MS` | `4000` | Drift-correction broadcast interval |
| `DRIFT_TOLERANCE_SEC` | `1.5` | How far out of sync a viewer may be before the client starts correcting (sent to the client). Moderate drift is closed by a slight speed change; only gaps over 5s seek |
| `ALLOWED_RATES` | `0.25,0.5,0.75,1,1.25,1.5,1.75,2` | Comma-separated playback speeds offered in the UI |
| `DATABASE_PATH` | `/data/watchsync.db` (image) | SQLite file for the optional account layer. The compose file mounts the `watchsync-data` volume at `/data`; running bare, it defaults to `data/watchsync.db` relative to the working directory |
| `REGISTRATION_ENABLED` | `true` | Allow new signups. Set `false` to close registration on a public instance — existing accounts keep working |
| `MAX_ROOMS_PER_USER` | `5` | Custom room names one account may hold (anti-squatting) |
| `SESSION_TTL_DAYS` | `30` | Session cookie lifetime; sliding (refreshed on use) |
| `COOKIE_SECURE` | `true` | Mark the session cookie HTTPS-only. Browsers exempt `localhost`, so dev works; set `false` only for a plain-HTTP LAN install |

**Resolver** (`watchsync-resolver`, see [resolver/app.py](resolver/app.py)):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (internal only — must match `RESOLVER_URL` on the server) |
| `ALLOW_PRIVATE_URLS` | `false` | Same SSRF guard as the server; the compose file wires one variable to both |
| `POT_PROVIDER_URL` | `http://watchsync-bgutil:4416` | PO-token provider for YouTube caption attestation. Empty → subtitle listing still works, but auto-translated tracks are usually rejected |
| `RESOLVE_TIMEOUT` | `20` | Per-extraction socket timeout, seconds |
| `SUBS_CACHE_TTL` | `900` | How long extracted subtitle-track metadata is cached, seconds |

Other server constants (nickname/chat length, token-bucket rates for chat, reactions, the per-IP HTTP limiters, and login attempts) are also in `config.rs` and env-tunable; see the file for the full list. Empty rooms are reaped after the TTL unless the host marks the room **Persist**.

## Accounts & custom room URLs (optional)

Everything above works with zero signup — accounts only *add*:

- **Register** (top-right on the landing page): username + password, no email. Passwords are argon2id-hashed; the session is an HttpOnly `SameSite=Lax` cookie whose token is stored server-side only as a SHA-256 hash.
- **Claim a permanent room name** — `/r/movie-night` instead of `/r/x7k2m9qe4w`. Names are 3–32 chars (lowercase letters, digits, hyphens), capped at `MAX_ROOMS_PER_USER` per account, managed from the **My rooms** panel on the landing page (open / copy link / release).
- **Permanent URL, ephemeral state.** The *registration* lives in SQLite forever; the room *state* stays in-memory exactly like an ad-hoc room. When a registered room empties it is reaped as usual (freeing ffmpeg/RAM) — the next visitor to the URL gets a fresh instance under the same name. Share the link once, use it every movie night.
- **The owner is always host.** Joining one of your rooms (signed in) grants you host on the spot — even reclaiming it if host had migrated to someone else while you were away. If you hand host to someone yourself, it stays with them until you next arrive; a reconnect does not take it back. Guests joining before the owner behave exactly like an ad-hoc room (first in hosts) until the owner arrives.
- **Signed-in niceties:** your display name prefills the nickname prompt (and is the server-side default), and your session rides the WebSocket automatically — no tokens to manage across devices.

Ops notes:

- The database is one SQLite file on the `watchsync-data` volume — **back it up by copying that file**; deleting the volume deletes every account and claimed name.
- Password reset (no email, so the admin does it): the pragmatic route is deleting the account so the person can re-register — from the host, `sqlite3` against the file on the `watchsync-data` volume:
  `sqlite3 "$(docker volume inspect -f '{{.Mountpoint}}' watchsync_watchsync-data)/watchsync.db" "DELETE FROM users WHERE username='name';"`
  Their claimed room names are released along with the account (re-claim after re-registering).
- `REGISTRATION_ENABLED=false` freezes signups without touching existing users.

## WebSocket protocol (overview)

A single connection at `/ws` carries JSON frames discriminated by `type`.

**Client → server (intents):** `join_room`, `change_video`, `play_pause`, `seek`, `set_rate`, `buffering_start`/`buffering_end`, `queue_add`/`queue_remove`/`queue_move`/`queue_skip`/`queue_play`, `kick_user`/`ban_user`/`transfer_host`, `lock_room`, `set_persistent`, `media_title`, `chat_message`, `reaction`, `typing`, `sync_request`, `ping`.

**Server → client:** `welcome` (your `conn_id`), `joined` (ack + effective `client_id` + per-seat `seat_token` + snapshot + chat history + config + your account, if signed in), `join_error`, `kicked` (removed/banned by host), `action_error`, `room_state` (full snapshot + `caused_by`), `heartbeat`, `chat_message`, `system_message`, `reaction`, `typing`, `pong`, `sync_snapshot`.

The full schema is the source of truth in [`backend/src/protocol.rs`](backend/src/protocol.rs).

## yt-dlp resolver (Vimeo, Twitch, Dailymotion, Reddit, … ~1800 sites)

This is **built in**. The stack ships a small `watchsync-resolver` container ([resolver/](resolver/)) — a Python HTTP service that uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) as a library to turn a page URL into a direct, browser-playable stream URL.

**Flow:** the resolver is reached **only by the server**, never by the browser. When a room loads a link that is neither YouTube nor a direct media URL, `stream::prepare_source` calls the resolver over the private Docker network and gets back `{ video_url, audio_url, video_headers, audio_headers, title, is_live, kind }` — separate video and audio streams plus the request headers ffmpeg must replay against signed CDN URLs. ffmpeg then muxes both into the room's HLS output. Direct media URLs (`.mp4`, `.m3u8`, …) short-circuit *before* the resolver; YouTube skips it entirely and plays through the IFrame API.

The browser only ever talks to `/api/subtitles` and `/api/subtitles/track`, which proxy the resolver's caption extraction.

**Disabling it:** set `RESOLVER_URL=` (empty) on the server and drop the `watchsync-resolver` service. Subtitles then return 501, and non-direct links are handed to ffmpeg unresolved (usually a failure).

**Keeping it working:** sites change constantly, so bump yt-dlp periodically. The version is pinned in [resolver/Dockerfile](resolver/Dockerfile) — change `YTDLP_VERSION` and rebuild:

```bash
docker build --build-arg YTDLP_VERSION=<new version> -t watchsync-resolver:latest ./resolver
```

Bump `POT_PLUGIN_VERSION` and the `brainicism/bgutil-ytdlp-pot-provider` tag in [docker-compose.yml](docker-compose.yml) together — upstream requires the plugin and provider server to match. (The compose file declares no `build:` contexts, so `docker compose build` does not work here; build the images directly as above.)

**Limitations (best-effort by nature):**
- Extractors break as sites change — rebuild the resolver image when a site stops resolving.
- Live streams are served as a sliding window (no rewinding a live source).
- **DRM** services (Netflix, Disney+, …) are impossible regardless.

Separate audio/video pairs and auth-header-protected CDN URLs are no longer limitations: the server-side ffmpeg proxy merges the pair and replays yt-dlp's request headers.

**Security note:** pasted URLs are fetched **server-side** (yt-dlp in the resolver, ffmpeg in the server) — an inherent SSRF surface. Both services therefore refuse URLs whose host resolves to a private, loopback, link-local, or otherwise internal address. If you *want* to play media from your LAN (Jellyfin, a NAS, …), set `ALLOW_PRIVATE_URLS=true` — only do that on an instance you don't expose to strangers. Redirects fetched after the initial check are not re-validated, so treat the guard as a strong default, not a sandbox. The resolver itself stays internal (no published port, no edge route).

### YouTube subtitles

YouTube serves its **embedded** player a reduced caption dataset: the uploaded tracks are there, but the auto-translate catalog (`translationLanguages`, ~156 languages on youtube.com) is only sent to the watch page. That's why languages "disappear" in any site that embeds YouTube. WatchSync works around it app-side:

- `GET /api/subtitles?url=…` → the resolver extracts **every** available track (uploaded / auto-generated / auto-translated) from watch-page data and returns one entry per language, including a direct CORS-enabled `timedtext` URL.
- YouTube rejects **auto-translated** (`tlang=`) caption requests without BotGuard attestation (429). The `watchsync-bgutil` sidecar mints "PO tokens" that the resolver attaches to every caption URL, so the client's CC menu (top-right of the player) can fetch the chosen track as WebVTT **directly in the viewer's browser**. The `GET /api/subtitles/track?url=…&lang=…` server proxy is the fallback — fully reliable for uploaded/auto-generated tracks, best-effort (retried, then cached for an hour) for translated ones, since YouTube heavily throttles translation requests from server/datacenter IPs regardless of tokens.
- Cues render as an overlay above the iframe; the language choice is per-viewer (not synced) and remembered across videos. Track metadata is cached in the resolver for 15 minutes (`SUBS_CACHE_TTL`).
- Disable with `POT_PROVIDER_URL=` (empty) and drop the `watchsync-bgutil` service: listing still works, but translated tracks will usually be rejected by YouTube.

### Scaling beyond one process

Room state is in-memory. To run multiple server instances behind a load balancer, replace the `HashMap` in [backend/src/state.rs](backend/src/state.rs) with a shared store (e.g. Redis) and fan out broadcasts through a pub/sub channel. The sync logic is contained to `state.rs` and `ws.rs`.

## Troubleshooting

**502 Bad Gateway from the reverse proxy** — usually the proxy container isn't on the `proxy` network. Check `docker network inspect proxy`; attach it with `docker network connect proxy <proxy-container>`. Also confirm the forward host is `watchsync-client` over `http`.

**WebSocket fails / chat doesn't work but the page loads** — enable **Websockets Support** on your proxy host for this domain. Also note the server rejects socket upgrades from origins outside `PUBLIC_ORIGIN` — make sure it matches the URL in the browser exactly.

**Non-YouTube videos stuck on "Preparing stream…" or failing to load** — check that the `watchsync-streams` volume is mounted in *both* `watchsync-server` and `watchsync-client` (`docker inspect <container> --format '{{json .Mounts}}'`). Then check `docker logs watchsync-server`: a failed ffmpeg run is logged with the tail of what ffmpeg said (URLs reduced to their host), e.g. `HTTP error 403 Forbidden` from the origin. `ffmpeg exited cleanly but … is empty — is the streams volume full?` means exactly that: several long films share the tmpfs, and ffmpeg quietly writes empty files once it is full — raise `STREAMS_TMPFS_SIZE`.

**A LAN/private URL is rejected with "not allowed"** — that's the SSRF guard. Set `ALLOW_PRIVATE_URLS=true` if the instance isn't publicly reachable (or you accept the risk).

**`watchsync-bgutil` shows unhealthy** — the healthcheck must probe `http://127.0.0.1:4416/ping` via `node` (the image has no python and listens on 4416); the bundled compose file does this correctly.

---

## Privacy policy (GDPR / DSGVO)

The client ships a privacy notice at **`/privacy`** (alias `/datenschutz`), written for a
**privately operated, non-commercial** instance in Germany / the EU. It is bilingual — German
by default for German-language browsers, English otherwise — and reflects what this codebase
actually does: in-memory rooms reaped 5 min after the last participant leaves, an 80-message
chat cap, `localStorage` keys one by one, the optional no-email account layer, Argon2id
password hashes, the `ws_session` cookie, per-IP rate-limit buckets, and the one third-party
connection (the YouTube IFrame player → Google).

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

> **Note on the YouTube embed.** The IFrame API is *not* in `index.html`. It is injected on
> demand by `YouTubePlayer` the first time a YouTube video is actually played, so Google sees
> nothing at all from visitors who only open the landing page or a room. Keep it that way —
> putting the `<script>` back in `index.html` would hand Google every visitor's IP on page
> load and undercut section 7.1 of the policy.

---

## License

MIT.
