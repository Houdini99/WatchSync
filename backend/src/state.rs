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
use tokio::sync::mpsc::UnboundedSender;
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
}

/// A live WebSocket connection registered in a room: its outbound sink plus a
/// one-shot to force-close it (used by kick/ban). The kill sender is taken once.
pub struct ConnHandle {
    pub out: UnboundedSender<Message>,
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
        let users = self
            .users
            .values()
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
            let _ = handle.out.send(Message::Text(json.clone()));
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
                .map_or(false, |u| u.seat_token == seat_token)
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
        let user = User {
            client_id: client_id.to_string(),
            seat_token: nanoid!(24, &ID_ALPHABET),
            conn_id: conn_id.to_string(),
            color: color_for(client_id),
            nickname,
            buffering: false,
            disconnected: false,
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
        !token.is_empty() && token == self.host_token
    }

    pub fn is_host(&self, client_id: &str) -> bool {
        self.host_client_id.as_deref() == Some(client_id)
    }

    /// Pick a live, connected user to inherit host. Returns the new host's
    /// nickname, if any.
    pub fn migrate_host(&mut self) -> Option<String> {
        if let Some(u) = self.users.values().find(|u| !u.disconnected) {
            let cid = u.client_id.clone();
            let nick = u.nickname.clone();
            self.host_client_id = Some(cid);
            return Some(nick);
        }
        self.host_client_id = None;
        None
    }

    pub fn update_video_state(&mut self, paused: Option<bool>, current_time: Option<f64>) {
        let live = self.compute_live_time();
        let v = &mut self.video;
        match current_time {
            Some(t) if t.is_finite() && t >= 0.0 => v.current_time = t,
            _ => v.current_time = live,
        }
        if let Some(p) = paused {
            v.paused = p;
        }
        v.last_update = Instant::now();
        v.auto_paused = false;
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
    }

    pub fn clear_media(&mut self) {
        self.video = VideoState::default();
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
    /// Returns `(room_id, host_token)`.
    pub async fn create_room(&self) -> (String, String) {
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
        let evicted = {
            let mut rooms = self.rooms.write().await;
            let evicted = if rooms.len() >= self.config.max_rooms {
                evict_oldest_empty(&mut rooms)
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
        let (id, token, evicted) = evicted;
        // Tear down the evicted room's ffmpeg + RAM-disk dir (lock released).
        if let Some(victim) = evicted {
            self.streams.stop(&victim).await;
        }
        (id, token)
    }

    pub fn join_config(&self) -> JoinConfig {
        JoinConfig {
            allowed_rates: self.config.allowed_rates.clone(),
            max_queue_length: self.config.max_queue_length,
            drift_tolerance_sec: self.config.drift_tolerance_sec,
        }
    }
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
