//! Authoritative, in-memory room state and the global store.
//!
//! The server is the single source of truth: clients send intents, the store
//! mutates state, and a fresh snapshot is broadcast. Playback position is never
//! stored as a moving value — it is held as `current_time` frozen at
//! `last_update`, and the *live* position is extrapolated on demand by
//! `wall_clock_elapsed * rate`. That keeps speed changes and pauses exact.

use crate::config::Config;
use crate::http_limit::IpRateLimiter;
use crate::media::TitleCache;
use crate::protocol::{
    ChatHistoryEntry, JoinConfig, Media, ServerMsg, Snapshot, StreamView, UserView, VideoView,
};
use crate::stream::StreamManager;
use axum::extract::ws::Message;
use nanoid::nanoid;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::Sender;
use tokio::sync::{oneshot, Mutex, RwLock};

/// Max distinct client_ids a single room may keep banned, so a host cannot grow
/// the set without bound.
const MAX_BANNED_PER_ROOM: usize = 1000;

/// Unambiguous, readable id/token alphabet (no look-alike characters).
const ID_ALPHABET: [char; 31] = [
    '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'j', 'k', 'm',
    'n', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
];

/// Distinct nick colors, picked deterministically per user so a given person
/// keeps the same color for the room's lifetime.
const USER_COLORS: &[&str] = &[
    "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#60a5fa", "#818cf8",
    "#a78bfa", "#e879f9", "#f472b6", "#fb7185",
];

/// Epoch milliseconds as an f64 (matches the browser's `Date.now()`).
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn color_for(seed: &str) -> String {
    let mut h: u32 = 0;
    for b in seed.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    USER_COLORS[(h as usize) % USER_COLORS.len()].to_string()
}

/// Snap a requested rate to the nearest allowed value within a small tolerance.
fn clamp_rate(rate: f64, allowed: &[f64]) -> Option<f64> {
    if !rate.is_finite() {
        return None;
    }
    allowed.iter().copied().find(|a| (a - rate).abs() < 0.001)
}

// ---------------------------------------------------------------------------

pub struct User {
    pub client_id: String,
    /// Secret issued when this seat is first created. A reconnect must present it
    /// to reclaim the seat; without it (or with the wrong one) a joiner using this
    /// client_id is given a brand-new seat instead of taking this one over. This
    /// is what stops a client_id — which is public (it rides in the snapshot and
    /// on every chat message) — from being used to hijack a seat or host status.
    pub seat_token: String,
    /// The connection id currently "owning" this seat. A newer tab with the same
    /// client_id (and matching seat_token) takes over; the older socket's
    /// disconnect is then ignored.
    pub conn_id: String,
    pub nickname: String,
    pub color: String,
    pub buffering: bool,
    pub disconnected: bool,
    /// Order of arrival in the room, for a stable user list. `users` is a
    /// HashMap, so without it the list reshuffled on every join and leave.
    pub seq: u64,
}

/// A live WebSocket connection registered in a room: its outbound sink plus a
/// one-shot to force-close it (used by kick/ban). The kill sender is taken once.
pub struct ConnHandle {
    pub out: Sender<Message>,
    pub kill: Option<oneshot::Sender<()>>,
}

/// Bookkeeping for the room's active server-side HLS proxy stream. Present only
/// for non-YouTube media; `None` means "no proxy" (YouTube IFrame path, or no
/// media). The actual ffmpeg child lives in [`StreamManager`], keyed by room id;
/// this is just the metadata the snapshot needs plus the generation used to
/// reconcile out-of-order spawn/ready/error callbacks.
#[derive(Clone)]
pub struct StreamInfo {
    /// Monotonic id for this (re)spawn. Bumped on every change/seek so a stale
    /// ffmpeg's ready/error callback can't clobber a newer stream.
    pub generation: u64,
    /// Content-second ffmpeg was started at (`-ss`).
    pub offset: f64,
    pub ready: bool,
    pub error: bool,
}

pub struct VideoState {
    pub media: Option<Media>,
    pub current_time: f64,
    pub paused: bool,
    pub rate: f64,
    pub last_update: Instant,
    /// True when the room paused itself because someone was buffering (so it can
    /// auto-resume once everyone is ready).
    pub auto_paused: bool,
    /// The proxy stream backing this media, if any (non-YouTube).
    pub stream: Option<StreamInfo>,
}

impl Default for VideoState {
    fn default() -> Self {
        VideoState {
            media: None,
            current_time: 0.0,
            paused: true,
            rate: 1.0,
            last_update: Instant::now(),
            auto_paused: false,
            stream: None,
        }
    }
}

pub struct ChatEntry {
    pub kind: &'static str, // "chat" | "system"
    pub nickname: Option<String>,
    pub color: Option<String>,
    pub text: String,
    pub client_id: Option<String>,
    pub ts: f64,
}

/// Outcome of a buffering-state change, so the caller knows whether (and why)
/// to broadcast.
pub enum BufferOutcome {
    Unchanged,
    Changed,
}

pub struct Room {
    pub id: String,
    pub host_token: String,
    pub host_client_id: Option<String>,
    /// Set when this instance was materialized from a registered slug: the
    /// account that owns the slug. Owner joins are granted host (ws.rs). The
    /// registration itself lives in SQLite — this instance is still reaped
    /// when empty like any other room, and re-hydrates on the next visit.
    pub owner_id: Option<i64>,
    /// True for an instance of a registered (custom-slug) room.
    pub registered: bool,
    pub locked: bool,
    pub persistent: bool,
    /// Keyed by client_id — a stable per-browser identity.
    pub users: HashMap<String, User>,
    /// client_ids the host has banned; blocked from rejoining this room.
    pub banned: HashSet<String>,
    pub video: VideoState,
    pub queue: Vec<Media>,
    pub chat_history: VecDeque<ChatEntry>,
    pub created_at: Instant,
    /// Live WebSocket connections, keyed by connection id.
    pub connections: HashMap<String, ConnHandle>,
    /// Next `User::seq` to hand out.
    next_seq: u64,
}

impl Room {
    fn new() -> Self {
        let id: String = nanoid!(10, &ID_ALPHABET);
        Self::with_id(id, None, false)
    }

    /// A fresh instance of a registered room, materialized on demand when
    /// someone opens its slug (the previous instance was reaped, or none ever
    /// existed). State starts clean; only the identity persists.
    pub fn new_registered(slug: String, owner_id: i64) -> Self {
        Self::with_id(slug, Some(owner_id), true)
    }

    fn with_id(id: String, owner_id: Option<i64>, registered: bool) -> Self {
        // Registered rooms keep a host token too, but it is never handed out —
        // host status there flows from the owner's session instead.
        let host_token: String = nanoid!(32, &ID_ALPHABET);
        Room {
            id,
            host_token,
            host_client_id: None,
            owner_id,
            registered,
            locked: false,
            persistent: false,
            users: HashMap::new(),
            banned: HashSet::new(),
            video: VideoState::default(),
            queue: Vec::new(),
            chat_history: VecDeque::new(),
            created_at: Instant::now(),
            connections: HashMap::new(),
            next_seq: 0,
        }
    }

    pub fn live_user_count(&self) -> usize {
        self.users.values().filter(|u| !u.disconnected).count()
    }

    /// Extrapolated live playback position.
    pub fn compute_live_time(&self) -> f64 {
        let v = &self.video;
        if v.media.is_none() {
            return 0.0;
        }
        if v.paused {
            return v.current_time;
        }
        v.current_time + v.last_update.elapsed().as_secs_f64() * v.rate.max(0.0)
    }

    pub fn snapshot(&self) -> Snapshot {
        // Host first, then everyone in order of arrival.
        let mut ordered: Vec<&User> = self.users.values().collect();
        ordered.sort_by_key(|u| (!self.is_host(&u.client_id), u.seq));
        let users = ordered
            .into_iter()
            .map(|u| UserView {
                client_id: u.client_id.clone(),
                nickname: u.nickname.clone(),
                color: u.color.clone(),
                is_host: Some(&u.client_id) == self.host_client_id.as_ref(),
                buffering: u.buffering,
                disconnected: u.disconnected,
            })
            .collect();

        Snapshot {
            id: self.id.clone(),
            locked: self.locked,
            persistent: self.persistent,
            registered: self.registered,
            host_client_id: self.host_client_id.clone(),
            users,
            video: VideoView {
                media: self.video.media.clone(),
                current_time: self.compute_live_time(),
                paused: self.video.paused,
                rate: self.video.rate.max(0.0),
                server_time: now_ms(),
                stream: self.video.stream.as_ref().map(|s| StreamView {
                    // Relative path: served by nginx off the shared RAM disk
                    // (and by the server's own dev route). The `?g=` generation
                    // makes the client reload hls.js after a seek-respawn.
                    path: format!("/api/streams/{}/index.m3u8?g={}", self.id, s.generation),
                    offset: s.offset,
                    ready: s.ready,
                    error: s.error,
                }),
            },
            queue: self.queue.clone(),
        }
    }

    /// Send a message to every live connection in the room.
    pub fn broadcast(&self, msg: &ServerMsg) {
        let json = msg.to_json();
        for handle in self.connections.values() {
            // try_send, not send: this fn is sync and must never block a
            // room-wide broadcast on one slow reader. A full queue means the
            // client is not draining; drop the frame rather than buffer it.
            // The protocol re-broadcasts a full snapshot on the next room
            // event and the client can also request one, so a dropped frame
            // is recoverable -- an unbounded queue is not.
            if handle.out.try_send(Message::Text(json.clone())).is_err() {
                tracing::debug!("dropping frame for a connection that is not draining");
            }
        }
    }

    /// Broadcast the full room state. `caused_by` lets the originator ignore its
    /// own echo.
    pub fn broadcast_state(&self, caused_by: Option<String>) {
        self.broadcast(&ServerMsg::RoomState {
            snapshot: self.snapshot(),
            caused_by,
        });
    }

    /// Push a system message into history and broadcast it.
    pub fn system_message(&mut self, text: impl Into<String>, history_limit: usize) {
        let text = text.into();
        let ts = now_ms();
        self.push_chat(
            ChatEntry {
                kind: "system",
                nickname: None,
                color: None,
                text: text.clone(),
                client_id: None,
                ts,
            },
            history_limit,
        );
        self.broadcast(&ServerMsg::SystemMessage { text, ts });
    }

    /// `true` if `client_id` names an existing seat whose secret matches — i.e.
    /// this join is a legitimate reclaim of that seat (not a hijack attempt).
    pub fn is_seat_owner(&self, client_id: &str, seat_token: &str) -> bool {
        !seat_token.is_empty()
            && self
                .users
                .get(client_id)
                .is_some_and(|u| constant_time_eq(&u.seat_token, seat_token))
    }

    /// Seat this join. If `requested_id` names an existing seat and `seat_token`
    /// matches, reclaim it (a reconnect/takeover). Otherwise create a *new* seat:
    /// with the requested id if it's free, or a fresh server-generated id if that
    /// id is already taken by someone else (so a spoofed/absent token can never
    /// take over another person's seat). Returns `(effective_client_id, reconnected)`.
    pub fn claim_seat(
        &mut self,
        requested_id: &str,
        seat_token: &str,
        conn_id: &str,
        nickname: String,
    ) -> (String, bool) {
        // Legit reclaim: existing seat whose secret matches.
        if self.is_seat_owner(requested_id, seat_token) {
            if let Some(existing) = self.users.get_mut(requested_id) {
                existing.conn_id = conn_id.to_string();
                existing.disconnected = false;
                if !nickname.is_empty() {
                    existing.nickname = nickname;
                }
            }
            return (requested_id.to_string(), true);
        }
        // Seat is taken by someone else (spoofed/absent token) — hand this joiner a
        // fresh server-generated id rather than rejecting (never lock out a legit
        // user) or reclaiming (never hand over the existing seat/host).
        if self.users.contains_key(requested_id) {
            let new_id = format!("g-{}", nanoid!(16, &ID_ALPHABET));
            self.insert_new_user(&new_id, conn_id, nickname);
            return (new_id, false);
        }
        // Free id — first join for this seat.
        self.insert_new_user(requested_id, conn_id, nickname);
        (requested_id.to_string(), false)
    }

    fn insert_new_user(&mut self, client_id: &str, conn_id: &str, nickname: String) {
        let seq = self.next_seq;
        self.next_seq += 1;
        let user = User {
            client_id: client_id.to_string(),
            seat_token: nanoid!(24, &ID_ALPHABET),
            conn_id: conn_id.to_string(),
            color: color_for(client_id),
            nickname,
            buffering: false,
            disconnected: false,
            seq,
        };
        self.users.insert(client_id.to_string(), user);
    }

    /// The secret to hand back to the seat's owner so it can reconnect.
    pub fn seat_token_of(&self, client_id: &str) -> String {
        self.users
            .get(client_id)
            .map(|u| u.seat_token.clone())
            .unwrap_or_default()
    }

    pub fn is_banned(&self, client_id: &str) -> bool {
        self.banned.contains(client_id)
    }

    /// Record a ban (bounded, so a host can't grow the set without limit).
    pub fn ban(&mut self, client_id: &str) {
        if self.banned.len() < MAX_BANNED_PER_ROOM {
            self.banned.insert(client_id.to_string());
        }
    }

    /// Flag a seat as gone without freeing it, so a quick reconnect is seamless.
    pub fn mark_disconnected(&mut self, client_id: &str) {
        if let Some(u) = self.users.get_mut(client_id) {
            u.disconnected = true;
            u.buffering = false;
        }
    }

    pub fn remove_user(&mut self, client_id: &str) {
        self.users.remove(client_id);
        if self.host_client_id.as_deref() == Some(client_id) {
            self.host_client_id = None;
        }
    }

    pub fn set_host(&mut self, client_id: &str) {
        self.host_client_id = Some(client_id.to_string());
    }

    pub fn is_host_token(&self, token: &str) -> bool {
        !token.is_empty() && constant_time_eq(token, &self.host_token)
    }

    pub fn is_host(&self, client_id: &str) -> bool {
        self.host_client_id.as_deref() == Some(client_id)
    }

    /// Hand host to another connected seat, returning its nickname (`None` if
    /// there is no such seat, or it is away). Rotates the host token: the
    /// creator's copy of it grants host on every join, so otherwise the old
    /// host would take the room back on their next reconnect.
    pub fn transfer_host(&mut self, target: &str) -> Option<String> {
        let nick = self
            .users
            .get(target)
            .filter(|u| !u.disconnected)?
            .nickname
            .clone();
        self.host_client_id = Some(target.to_string());
        self.host_token = nanoid!(32, &ID_ALPHABET);
        Some(nick)
    }

    /// Pick a live, connected user to inherit host — the longest-present one,
    /// rather than whichever the HashMap yields first. Returns the new host's
    /// nickname, if any.
    pub fn migrate_host(&mut self) -> Option<String> {
        if let Some(u) = self.users.values().filter(|u| !u.disconnected).min_by_key(|u| u.seq) {
            let cid = u.client_id.clone();
            let nick = u.nickname.clone();
            self.host_client_id = Some(cid);
            return Some(nick);
        }
        self.host_client_id = None;
        None
    }

    /// Move the playhead and/or play-pause state. `paused: None` keeps both the
    /// pause state and any auto-pause: only a deliberate play or pause overrides
    /// a wait for buffering viewers. A seek used to clear `auto_paused` too, so a
    /// scrub while the room waited turned the wait into a pause nobody had asked
    /// for — the room stayed stopped after everyone caught up.
    pub fn update_video_state(&mut self, paused: Option<bool>, current_time: Option<f64>) {
        let live = self.compute_live_time();
        let v = &mut self.video;
        match current_time {
            Some(t) if t.is_finite() && t >= 0.0 => v.current_time = t,
            _ => v.current_time = live,
        }
        if let Some(p) = paused {
            v.paused = p;
            v.auto_paused = false;
        }
        v.last_update = Instant::now();
    }

    pub fn set_rate(&mut self, rate: f64, allowed: &[f64]) -> bool {
        let Some(r) = clamp_rate(rate, allowed) else {
            return false;
        };
        if (r - self.video.rate).abs() < f64::EPSILON {
            return false;
        }
        // Freeze the current position before changing the multiplier.
        self.video.current_time = self.compute_live_time();
        self.video.rate = r;
        self.video.last_update = Instant::now();
        true
    }

    pub fn set_media(&mut self, media: Media) {
        let start = if media.start.is_finite() { media.start } else { 0.0 };
        self.video.media = Some(media);
        self.video.current_time = start;
        self.video.paused = false;
        self.video.rate = 1.0;
        self.video.last_update = Instant::now();
        self.video.auto_paused = false;
        // The caller re-arms a fresh proxy generation for non-YouTube media; a
        // YouTube change just leaves this cleared.
        self.video.stream = None;
        self.clear_buffering();
    }

    pub fn clear_media(&mut self) {
        self.video = VideoState::default();
        self.clear_buffering();
    }

    /// Buffering describes one viewer's progress through one piece of media, so
    /// a media change voids it. Clients tear their player down on a change and
    /// start over not-buffering; a flag left set here outlived that and, since
    /// `set_buffering` only acts on transitions, kept `any_buffering` true for
    /// good — the next time anyone else buffered, the room auto-paused and then
    /// never auto-resumed.
    fn clear_buffering(&mut self) {
        for user in self.users.values_mut() {
            user.buffering = false;
        }
    }

    /// Begin (or restart, on a seek) the proxy stream for the current media:
    /// record the generation + content offset and reset ready/error so clients
    /// wait for the new ffmpeg's playlist.
    pub fn begin_stream(&mut self, generation: u64, offset: f64) {
        self.video.stream = Some(StreamInfo {
            generation,
            offset: offset.max(0.0),
            ready: false,
            error: false,
        });
    }

    pub fn clear_stream(&mut self) {
        self.video.stream = None;
    }

    /// Flip the stream to ready, but only if it's still the generation that asked
    /// (a newer change/seek may have superseded it). Returns whether it changed.
    pub fn mark_stream_ready(&mut self, generation: u64) -> bool {
        match self.video.stream.as_mut() {
            Some(s) if s.generation == generation && (!s.ready || s.error) => {
                s.ready = true;
                s.error = false;
                true
            }
            _ => false,
        }
    }

    pub fn mark_stream_error(&mut self, generation: u64) -> bool {
        match self.video.stream.as_mut() {
            Some(s) if s.generation == generation && !s.error => {
                s.error = true;
                true
            }
            _ => false,
        }
    }

    pub fn stream_generation(&self) -> Option<u64> {
        self.video.stream.as_ref().map(|s| s.generation)
    }

    /// Promote the current media to live (resolver-reported). Returns whether it
    /// changed, so the caller knows to rebroadcast.
    pub fn set_media_live(&mut self) -> bool {
        match self.video.media.as_mut() {
            Some(m) if !m.is_live => {
                m.is_live = true;
                true
            }
            _ => false,
        }
    }

    pub fn set_buffering(&mut self, client_id: &str, buffering: bool) -> BufferOutcome {
        let Some(user) = self.users.get_mut(client_id) else {
            return BufferOutcome::Unchanged;
        };
        if user.buffering == buffering {
            return BufferOutcome::Unchanged;
        }
        user.buffering = buffering;

        let any_buffering = self.users.values().any(|u| !u.disconnected && u.buffering);
        let live = self.compute_live_time();
        let v = &mut self.video;
        if any_buffering && !v.paused {
            v.current_time = live;
            v.paused = true;
            v.auto_paused = true;
            v.last_update = Instant::now();
        } else if !any_buffering && v.paused && v.auto_paused {
            v.paused = false;
            v.auto_paused = false;
            v.last_update = Instant::now();
        }
        BufferOutcome::Changed
    }

    /// After someone leaves, resume if the only buffering users are now gone.
    pub fn reconcile_auto_pause(&mut self) -> bool {
        let any_buffering = self.users.values().any(|u| !u.disconnected && u.buffering);
        let v = &mut self.video;
        if !any_buffering && v.paused && v.auto_paused {
            v.paused = false;
            v.auto_paused = false;
            v.last_update = Instant::now();
            return true;
        }
        false
    }

    pub fn enqueue(&mut self, media: Media, max: usize) -> bool {
        if self.queue.len() >= max {
            return false;
        }
        self.queue.push(media);
        true
    }

    pub fn dequeue_at(&mut self, index: i64) -> Option<Media> {
        if index < 0 || index as usize >= self.queue.len() {
            return None;
        }
        Some(self.queue.remove(index as usize))
    }

    pub fn move_queue_item(&mut self, from: i64, to: i64) -> bool {
        let n = self.queue.len() as i64;
        if from < 0 || from >= n || to < 0 || to >= n || from == to {
            return false;
        }
        let item = self.queue.remove(from as usize);
        self.queue.insert(to as usize, item);
        true
    }

    pub fn shift_queue(&mut self) -> Option<Media> {
        if self.queue.is_empty() {
            None
        } else {
            Some(self.queue.remove(0))
        }
    }

    pub fn update_media_title(&mut self, title: &str) -> bool {
        if let Some(media) = self.video.media.as_mut() {
            // Titles arrive from clients *and* from resolver/yt-dlp metadata —
            // all externally controlled, so they get the standard scrub.
            let t = crate::sanitize::sanitize_text(title, 200);
            if !t.is_empty() && t != media.title {
                media.title = t;
                return true;
            }
        }
        false
    }

    pub fn set_persistent(&mut self, persistent: bool) {
        self.persistent = persistent;
    }

    pub fn push_chat(&mut self, entry: ChatEntry, limit: usize) {
        self.chat_history.push_back(entry);
        while self.chat_history.len() > limit {
            self.chat_history.pop_front();
        }
    }

    pub fn chat_history_view(&self, limit: usize) -> Vec<ChatHistoryEntry> {
        let skip = self.chat_history.len().saturating_sub(limit);
        self.chat_history
            .iter()
            .skip(skip)
            .map(|e| ChatHistoryEntry {
                kind: e.kind.to_string(),
                nickname: e.nickname.clone(),
                color: e.color.clone(),
                text: e.text.clone(),
                client_id: e.client_id.clone(),
                ts: e.ts,
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------

pub struct AppState {
    pub rooms: RwLock<HashMap<String, Room>>,
    pub config: Config,
    pub title_cache: Mutex<TitleCache>,
    pub http: reqwest::Client,
    /// SQLite pool for the optional account layer (users/sessions/registered
    /// rooms). Touched at auth/join/registry time only — never per intent.
    pub db: sqlx::SqlitePool,
    /// ffmpeg process manager for the server-side HLS proxy.
    pub streams: StreamManager,
    /// Per-IP limiter for room creation.
    pub room_limiter: IpRateLimiter,
    /// Per-IP limiter for the resolver-backed HTTP routes (resolve/subtitles),
    /// each of which triggers a heavy yt-dlp extraction.
    pub resolve_limiter: IpRateLimiter,
    /// Per-IP limiter for the auth routes (argon2 work per request).
    pub auth_limiter: IpRateLimiter,
    /// Per-username limiter for login attempts.
    pub login_limiter: IpRateLimiter,
}

impl AppState {
    pub fn new(config: Config, db: sqlx::SqlitePool) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("WatchSync/3.0")
            .build()
            .unwrap_or_default();
        let streams = StreamManager::new(
            config.streams_dir.clone(),
            config.hls_segment_sec,
            config.stream_audio_bitrate.clone(),
            config.stream_ready_timeout_sec,
            config.stream_max_bytes,
        );
        let room_limiter =
            IpRateLimiter::new(config.http_room_bucket.capacity, config.http_room_bucket.refill_per_sec);
        let resolve_limiter = IpRateLimiter::new(
            config.http_resolve_bucket.capacity,
            config.http_resolve_bucket.refill_per_sec,
        );
        let auth_limiter =
            IpRateLimiter::new(config.http_auth_bucket.capacity, config.http_auth_bucket.refill_per_sec);
        let login_limiter = IpRateLimiter::new(
            config.login_user_bucket.capacity,
            config.login_user_bucket.refill_per_sec,
        );
        AppState {
            rooms: RwLock::new(HashMap::new()),
            config,
            title_cache: Mutex::new(TitleCache::default()),
            http,
            db,
            streams,
            room_limiter,
            resolve_limiter,
            auth_limiter,
            login_limiter,
        }
    }

    /// Create a fresh room, evicting the oldest empty room first if at capacity.
    /// Returns `(room_id, host_token)`, or `None` when the server is full and
    /// nothing could be evicted.
    pub async fn create_room(&self) -> Option<(String, String)> {
        // A generated id must not shadow a registered slug (10 chars from a
        // 31-symbol alphabet makes a collision ~impossible, but the indexed
        // lookup is free). Checked before the lock; ids never leave this fn
        // unclaimed, so the window is harmless.
        let room = loop {
            let room = Room::new();
            match crate::db::slug_owner(&self.db, &room.id).await {
                Ok(Some(_)) => continue,
                _ => break room,
            }
        };
        let outcome = {
            let mut rooms = self.rooms.write().await;
            let evicted = if rooms.len() >= self.config.max_rooms {
                // MAX_ROOMS was previously advisory: the insert below ran even
                // when eviction found nothing, so `rooms` grew without bound.
                // Every room is empty-reaped eventually, but a `persistent`
                // room is exempt from BOTH reaping and eviction -- and the
                // first joiner is always host and can set persistent -- so a
                // single client could pin arbitrarily many rooms in memory.
                match evict_oldest_empty(&mut rooms) {
                    Some(victim) => Some(victim),
                    // Genuinely full: every room is occupied or persistent.
                    None => return None,
                }
            } else {
                None
            };
            let id = room.id.clone();
            let token = room.host_token.clone();
            rooms.insert(id.clone(), room);
            // Return the host token early; the eviction cleanup happens below
            // after the lock is dropped.
            (id, token, evicted)
        };
        let (id, token, evicted) = outcome;
        // Tear down the evicted room's ffmpeg + RAM-disk dir (lock released).
        if let Some(victim) = evicted {
            self.streams.stop(&victim).await;
        }
        Some((id, token))
    }

    pub fn join_config(&self) -> JoinConfig {
        JoinConfig {
            allowed_rates: self.config.allowed_rates.clone(),
            max_queue_length: self.config.max_queue_length,
            drift_tolerance_sec: self.config.drift_tolerance_sec,
        }
    }
}

/// Byte-wise comparison that does not short-circuit on the first difference.
///
/// These are the bearer secrets for host privileges and seat takeover, and the
/// WebSocket path lets a client submit guesses at high rate. At 158 and 119
/// bits they were not practically attackable through `==`, but every other
/// secret comparison in the codebase goes through a hash, and a timing-safe
/// compare is the cheap way to keep that property as the tokens change.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Evict the oldest empty, non-persistent room. Returns its id so the caller can
/// tear down any ffmpeg/RAM-disk state once the rooms lock is released.
fn evict_oldest_empty(rooms: &mut HashMap<String, Room>) -> Option<String> {
    let victim = rooms
        .values()
        .filter(|r| !r.persistent && r.live_user_count() == 0)
        .min_by_key(|r| r.created_at)
        .map(|r| r.id.clone());
    if let Some(id) = &victim {
        rooms.remove(id);
    }
    victim
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(src: &str) -> Media {
        Media {
            kind: "file".into(),
            id: None,
            source: src.into(),
            start: 0.0,
            title: src.into(),
            is_live: false,
        }
    }

    fn room_with(users: &[&str]) -> Room {
        let mut room = Room::new();
        for (i, id) in users.iter().enumerate() {
            room.claim_seat(id, "", &format!("conn-{i}"), id.to_string());
        }
        room.set_media(media("https://example.com/a.mp4"));
        room
    }

    #[test]
    fn room_waits_for_every_buffering_viewer() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        assert!(!room.video.paused);

        room.set_buffering("alice-01", true);
        assert!(room.video.paused && room.video.auto_paused);
        room.set_buffering("bob-0001", true);
        room.set_buffering("alice-01", false);
        assert!(room.video.paused, "bob is still buffering");
        room.set_buffering("bob-0001", false);
        assert!(!room.video.paused && !room.video.auto_paused);
    }

    #[test]
    fn repeated_reports_are_not_transitions() {
        let mut room = room_with(&["alice-01"]);
        assert!(matches!(room.set_buffering("alice-01", false), BufferOutcome::Unchanged));
        assert!(matches!(room.set_buffering("alice-01", true), BufferOutcome::Changed));
        assert!(matches!(room.set_buffering("alice-01", true), BufferOutcome::Unchanged));
        assert!(matches!(room.set_buffering("nobody-1", true), BufferOutcome::Unchanged));
    }

    /// Regression: a flag set under the previous media used to survive the
    /// change, so the next viewer to buffer paused the room for good.
    #[test]
    fn media_change_voids_buffering_flags() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        room.set_buffering("alice-01", true);
        room.set_media(media("https://example.com/b.mp4"));
        assert!(room.users.values().all(|u| !u.buffering));
        assert!(!room.video.paused);

        room.set_buffering("bob-0001", true);
        assert!(room.video.paused);
        room.set_buffering("bob-0001", false);
        assert!(!room.video.paused, "the room must resume once bob is ready");
    }

    #[test]
    fn clearing_media_voids_buffering_flags() {
        let mut room = room_with(&["alice-01"]);
        room.set_buffering("alice-01", true);
        room.clear_media();
        assert!(!room.users["alice-01"].buffering);
    }

    /// A deliberate play during an auto-pause wins; the buffering viewer
    /// catching up afterwards must not toggle anything.
    #[test]
    fn manual_play_overrides_auto_pause() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        room.set_buffering("alice-01", true);
        room.update_video_state(Some(false), None);
        assert!(!room.video.paused && !room.video.auto_paused);
        room.set_buffering("alice-01", false);
        assert!(!room.video.paused);
    }

    #[test]
    fn users_are_listed_host_first_then_by_arrival() {
        let mut room = room_with(&["carol-01", "alice-01", "bob-0001", "dave-001"]);
        room.set_host("bob-0001");
        let order: Vec<String> = room.snapshot().users.into_iter().map(|u| u.client_id).collect();
        assert_eq!(order, ["bob-0001", "carol-01", "alice-01", "dave-001"]);
    }

    #[test]
    fn host_migrates_to_the_longest_present_user() {
        let mut room = room_with(&["carol-01", "alice-01", "bob-0001"]);
        room.set_host("carol-01");
        room.remove_user("carol-01");
        assert_eq!(room.migrate_host().as_deref(), Some("alice-01"));
        assert!(room.is_host("alice-01"));
    }

    #[test]
    fn transfer_host_rotates_the_host_token() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        room.set_host("alice-01");
        let old_token = room.host_token.clone();
        assert_eq!(room.transfer_host("bob-0001").as_deref(), Some("bob-0001"));
        assert!(room.is_host("bob-0001"));
        assert!(!room.is_host_token(&old_token), "the old host's token must stop working");
    }

    #[test]
    fn transfer_host_refuses_missing_or_away_users() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        room.set_host("alice-01");
        room.mark_disconnected("bob-0001");
        assert_eq!(room.transfer_host("bob-0001"), None);
        assert_eq!(room.transfer_host("nobody-1"), None);
        assert!(room.is_host("alice-01"));
    }

    /// Regression: a seek during an auto-pause cleared `auto_paused`, so the
    /// room never resumed once the buffering viewer caught up.
    #[test]
    fn a_seek_while_waiting_keeps_the_room_waiting() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        room.set_buffering("bob-0001", true);
        room.update_video_state(None, Some(180.0));
        assert!(room.video.paused && room.video.auto_paused);
        assert_eq!(room.video.current_time, 180.0);
        room.set_buffering("bob-0001", false);
        assert!(!room.video.paused, "the room resumes once bob is ready");
    }

    #[test]
    fn leaving_while_buffering_releases_the_room() {
        let mut room = room_with(&["alice-01", "bob-0001"]);
        room.set_buffering("alice-01", true);
        room.mark_disconnected("alice-01");
        assert!(room.reconcile_auto_pause());
        assert!(!room.video.paused);
    }
}
