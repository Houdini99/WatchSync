# WatchSync

A self-hosted "watch together" web app. Create a room, share the link, watch YouTube videos or direct media files (`.mp4`, `.webm`, `.m3u8`, etc.) in tight sync with your friends, and chat alongside. No signup, no tracking, no third-party services beyond YouTube's public IFrame API.

## Features

- **Instant rooms** — one click creates a shareable URL, no account needed
- **Tight sync** — server is the source of truth; play, pause, and seek propagate in real time
- **Buffer-aware** — if someone's stream stalls, the room can auto-pause and resume together
- **Mid-stream join** — late joiners hard-seek to the current position the moment their player is ready
- **Host controls** — first user to create the room is host; can lock player controls for everyone else; persistent host token survives reconnects
- **Queue** — line up multiple videos; the room auto-advances when one ends
- **YouTube title resolution** — queue entries swap from URL to real video title via YouTube oEmbed
- **Chat** with timestamps, auto-linking URLs, quick emoji reactions, unread badge, optional ping sound, browser tab title flash
- **Keyboard shortcuts** — Space/K (play/pause), ←/→ (±5s), J/L (±10s), F (fullscreen), M (mute)
- **Resync button** + live ping indicator in the topbar
- **Persistent room** toggle (host) — prevents the 5-minute empty-room auto-reap
- **Dark, mobile-responsive UI** — no build step on the client
- **Rate-limited chat** + HTML/control-char stripping on chat and nicknames

## Supported media

| Source | Support | Notes |
|---|---|---|
| YouTube (`youtube.com`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`, `music.youtube.com`) | First-class | IFrame API, title via oEmbed |
| HLS streams (`.m3u8`) | First-class | Plays via HLS.js |
| Direct video (`.mp4`, `.webm`, `.ogg`, `.mov`) | First-class | Native `<video>` |
| `.mkv` | Works partially | Most browsers can't decode common MKV audio codecs (AC-3, DTS, EAC-3). The app warns you and suggests `ffmpeg -i in.mkv -c:v copy -c:a aac -b:a 192k out.mp4` |
| Any other URL | Best-effort | Falls through to native `<video>`. Works only if the host serves a browser-playable codec with permissive CORS |
| Vimeo, Twitch, Dailymotion, Reddit, Twitter, etc. | Not built-in | Stub at `/api/resolve` is ready for a yt-dlp sidecar — see [Optional extensions](#optional-extensions) |
| Netflix, Disney+, HBO, Spotify, etc. | Not possible | DRM-protected; no shared-stream model works for these |

## Architecture

```
                 ┌─────────────────────────────────────────┐
                 │  Nginx Proxy Manager (your existing)    │
                 │  https://watch.example.com → :80        │
                 └────────────────────┬────────────────────┘
                                      │
                  ┌───────────────────▼────────────────────┐
                  │  watchsync-client (Nginx + static)     │
                  │  • Serves HTML/CSS/JS                  │
                  │  • Reverse-proxies /socket.io → server │
                  │  • Reverse-proxies /api → server       │
                  └───────────────────┬────────────────────┘
                                      │ (Docker DNS)
                  ┌───────────────────▼────────────────────┐
                  │  watchsync-server (Node 20 + Fastify)  │
                  │  • Authoritative room state            │
                  │  • Socket.IO sync engine               │
                  │  • In-memory rooms (no DB needed)      │
                  └────────────────────────────────────────┘
```

- **Server** holds `{currentTime, paused, lastUpdateAt, queue, users, ...}` per room. Clients send *intents* (play, pause, seek, queue, chat); server validates and broadcasts.
- **Heartbeat** every 4s for drift correction; broadcasts also carry a `causedBy` socket ID so originators ignore their own echoes.
- **Two-container split** keeps the Nginx config tiny — NPM only needs to point at the client, which proxies everything else internally.

## Tech stack

- **Server**: Node 20, [Fastify](https://fastify.dev), [Socket.IO](https://socket.io), [nanoid](https://github.com/ai/nanoid)
- **Client**: Vanilla ES modules, [HLS.js](https://github.com/video-dev/hls.js), [DOMPurify](https://github.com/cure53/DOMPurify), YouTube IFrame API
- **Infra**: Two containers (Node + Nginx Alpine) on an external Docker network. ~1800 lines of code total, no build step required for either container.

---

## Install

Requirements:

- A Linux host with Docker (and Docker Compose v2)
- A reverse proxy in front (Nginx Proxy Manager, Traefik, Caddy, etc.) — needed for HTTPS, which YouTube's IFrame API requires in modern browsers
- An external Docker network the reverse proxy and these containers will share (this README assumes it's called `proxy`)

### Option A — Portainer (recommended for self-hosters)

Portainer doesn't build images, so we build them once on the host, then deploy the stack.

**1. Get the source onto the VPS**

```bash
git clone https://github.com/YOUR-USER/watchsync.git
cd watchsync
```

**2. Build the two images on the host**

```bash
docker build -t watchsync-server:latest ./server
docker build -t watchsync-client:latest ./client
```

The images now live in the local Docker daemon Portainer manages. `pull_policy: never` in the compose file tells Docker not to look for them on Docker Hub.

**3. Ensure the proxy network exists**

```bash
docker network create proxy   # skip if NPM/your proxy already created it
```

**4. Deploy the stack in Portainer**

- **Stacks** → **Add stack** → name it `watchsync`
- **Web editor** → paste the contents of [docker-compose.yml](docker-compose.yml)
- Under **Environment variables**, add:
  - `PUBLIC_ORIGIN` = `https://watch.yourdomain.com`
  - `LOG_LEVEL` = `info` *(optional)*
- **Deploy the stack**

**5. Wire up the proxy**

In NPM (or equivalent):

- **Forward Hostname / IP**: `watchsync-client`
- **Forward Port**: `80`
- **Scheme**: `http` *(SSL terminates at NPM, not the container)*
- **Websockets Support**: **ON** *(required for Socket.IO)*
- Attach an SSL certificate (Let's Encrypt)

If you also self-host the reverse proxy in Docker, make sure its container is attached to the `proxy` network:

```bash
docker network connect proxy <your-proxy-container-name>
```

Visit your domain and click **Create a Room**.

#### Updating

After pulling new code:

```bash
git pull
docker build -t watchsync-server:latest ./server   # only if server/ changed
docker build -t watchsync-client:latest ./client   # only if client/ changed
```

Then in Portainer: stack → **Stop** → **Start** (or recreate just the changed container).

### Option B — Plain Docker Compose (no Portainer)

```bash
git clone https://github.com/YOUR-USER/watchsync.git
cd watchsync

# Configure
cp .env.example .env
$EDITOR .env                              # set PUBLIC_ORIGIN to your https URL

# Network (if not already present)
docker network create proxy

# Build + run
docker compose up -d --build
```

The compose file has `pull_policy: never` and uses local image tags, so `docker compose up --build` will build and start in one go.

To update later: `git pull && docker compose up -d --build`.

Logs:

```bash
docker compose logs -f
docker compose logs -f watchsync-server
docker compose logs -f watchsync-client
```

### Option C — Local development (no Docker)

For hacking on the code without Docker. You'll lose the Nginx reverse-proxy convenience, so set up an alternative.

```bash
# Terminal 1 — server
cd server
npm install
PORT=3000 node index.js

# Terminal 2 — serve the client
cd client/public
# Any static server works. Examples:
python3 -m http.server 5173
# or: npx serve -p 5173
```

Either configure the static server to proxy `/socket.io` and `/api` to `http://localhost:3000`, or run a local Nginx with the project's [client/nginx.conf](client/nginx.conf) pointed at `http://localhost:3000` instead of `http://watchsync-server:3000`.

Then visit `http://localhost:5173/`.

## Configuration

All settings via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_ORIGIN` | `*` | Origin allowed for Socket.IO CORS. Set to your https URL in production. `*` is fine during testing but allows any origin to connect. |
| `PORT` | `3000` | Server listen port (internal — change only if you customize the Nginx proxy line in [client/nginx.conf](client/nginx.conf)) |
| `HOST` | `0.0.0.0` | Server bind address |
| `LOG_LEVEL` | `info` | Fastify logger level: `trace` / `debug` / `info` / `warn` / `error` |

There are no other knobs. Room/chat limits are constants in code:

- Max 50 users per room
- Chat rate limit: 5 messages per 10 seconds per socket
- Nickname max 24 chars, chat message max 500 chars
- Empty rooms reaped after 5 minutes (unless host marked **Persist**)
- Heartbeat interval: 4 seconds; drift tolerance: 1.5 seconds; local-action grace: 2 seconds

## Optional extensions

### yt-dlp sidecar (Vimeo, Twitch VODs, Reddit, etc.)

The server exposes `/api/resolve` returning 501 by default. To enable ~1800 additional sites:

1. Add a [yt-dlp service container](https://hub.docker.com/r/jauderho/yt-dlp) to the compose file on the same `proxy` network.
2. Replace the `/api/resolve` stub in [server/index.js](server/index.js) with a handler that calls the sidecar (`yt-dlp -g <url>`) and returns the direct stream URL.
3. In [client/public/app.js](client/public/app.js), POST unknown URLs to `/api/resolve` first and use the returned URL.

Won't help with DRM-protected services (Netflix, Disney+, etc.) — those need a separate browser-extension architecture and aren't planned.

### Scaling beyond one process

Room state lives in memory. To run multiple server instances behind a load balancer, swap the in-memory map for Redis and add `@socket.io/redis-adapter`. The relevant logic is contained to [server/src/rooms.js](server/src/rooms.js) and the Socket.IO setup in [server/index.js](server/index.js).

## Troubleshooting

**502 Bad Gateway from the reverse proxy**

- Most likely: the proxy container isn't on the `proxy` network. Check `docker network inspect proxy` — your proxy container's name should appear. Attach it with `docker network connect proxy <proxy-container>`.
- Less likely: wrong forward hostname (should be `watchsync-client`, not `localhost`/IP) or wrong scheme (should be `http`, not `https`).

**WebSocket fails / chat doesn't work but page loads**

- Toggle **Websockets Support** on in your reverse proxy's proxy host config.

**MKV plays without audio**

- Browser limitation, not the app. Remux to MP4 — the app shows the exact ffmpeg command when you load an MKV. See [Supported media](#supported-media).

## License

MIT.

## Contributing

Issues and PRs welcome. Please include the browser and a short repro for sync-related bugs — they're race-sensitive and not always reproducible without specifics.
