//! The WebSocket wire protocol. Every frame is a JSON object with a `type`
//! discriminator. Clients send *intents*; the server validates them and
//! broadcasts authoritative state. Field names are snake_case on the wire and
//! match the TypeScript types in the frontend 1:1.

use serde::{Deserialize, Serialize};

/// A piece of media the room is (or could be) playing.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Media {
    /// "youtube" | "hls" | "file"
    pub kind: String,
    /// YouTube video id (only for `kind == "youtube"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The original URL the user pasted.
    pub source: String,
    /// Start offset in seconds (from `?t=` / `?start=`).
    pub start: f64,
    /// Display title (falls back to the source until resolved).
    pub title: String,
    /// A live stream (YouTube `/live/`, or flagged by the resolver). Live media
    /// has no shared scrub position, so the client plays the live edge and skips
    /// position drift-correction. Defaults to false for older clients.
    #[serde(default)]
    pub is_live: bool,
}

/// A user as seen by other clients.
#[derive(Clone, Debug, Serialize)]
pub struct UserView {
    pub client_id: String,
    pub nickname: String,
    pub color: String,
    pub is_host: bool,
    pub buffering: bool,
    pub disconnected: bool,
}

/// The server-side HLS proxy stream backing the current media (everything except
/// YouTube). The client loads `path` via hls.js and maps the authoritative
/// content time onto the local stream timeline using `offset` (the `-ss` second
/// the ffmpeg producing this playlist was started at — so stream-time 0 ==
/// content-second `offset`).
#[derive(Clone, Debug, Serialize)]
pub struct StreamView {
    /// HLS playlist path relative to the public origin. Carries a `?g=` cache
    /// buster so the client reloads when ffmpeg is respawned (e.g. on a seek).
    pub path: String,
    /// Content-second the current ffmpeg was started at.
    pub offset: f64,
    /// True once ffmpeg has produced a playable playlist.
    pub ready: bool,
    /// True when the resolver or ffmpeg failed — the client surfaces an error.
    pub error: bool,
}

/// Authoritative playback state. `current_time` is the *extrapolated* live
/// position at `server_time`, always in content time (independent of the HLS
/// proxy's stream timeline; see `StreamView`).
#[derive(Clone, Debug, Serialize)]
pub struct VideoView {
    pub media: Option<Media>,
    pub current_time: f64,
    pub paused: bool,
    pub rate: f64,
    pub server_time: f64,
    /// Present when the media is served through the server-side HLS proxy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<StreamView>,
}

/// The signed-in account behind a connection, echoed back on join so the
/// client can confirm the socket carried its session.
#[derive(Clone, Debug, Serialize)]
pub struct AccountView {
    pub username: String,
    pub display_name: String,
    pub color: Option<String>,
}

/// A full picture of a room. Sent on join and on every state change.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub locked: bool,
    pub persistent: bool,
    /// True for an instance of a registered (custom-slug) room — the URL is
    /// permanent even though the state is not.
    pub registered: bool,
    pub host_client_id: Option<String>,
    pub users: Vec<UserView>,
    pub video: VideoView,
    pub queue: Vec<Media>,
}

/// A persisted chat-log entry, replayed to late joiners.
#[derive(Clone, Debug, Serialize)]
pub struct ChatHistoryEntry {
    /// "chat" | "system"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub ts: f64,
}

/// Server-advertised configuration the client needs at join time.
#[derive(Clone, Debug, Serialize)]
pub struct JoinConfig {
    pub allowed_rates: Vec<f64>,
    pub max_queue_length: usize,
    /// How far out of sync (seconds) before the client hard-corrects.
    pub drift_tolerance_sec: f64,
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    JoinRoom {
        room_id: String,
        #[serde(default)]
        nickname: Option<String>,
        #[serde(default)]
        client_id: Option<String>,
        #[serde(default)]
        host_token: Option<String>,
        /// Per-seat secret issued by the server on first join. Required to reclaim
        /// an existing seat (and thus its host status); an absent/wrong token can
        /// never take over someone else's seat — the joiner gets a fresh one.
        #[serde(default)]
        seat_token: Option<String>,
    },
    ChangeVideo {
        url: String,
        /// Optional pre-resolved display title (e.g. from the resolver sidecar).
        #[serde(default)]
        title: Option<String>,
        /// Resolver-provided live flag, since live-ness can't be inferred from a
        /// resolved stream URL alone.
        #[serde(default)]
        is_live: Option<bool>,
    },
    PlayPause {
        paused: bool,
        #[serde(default)]
        current_time: Option<f64>,
    },
    Seek {
        current_time: f64,
    },
    SetRate {
        rate: f64,
    },
    BufferingStart,
    BufferingEnd,
    QueueAdd {
        url: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        is_live: Option<bool>,
    },
    QueueRemove {
        index: i64,
    },
    QueueMove {
        from: i64,
        to: i64,
    },
    QueueSkip {
        /// Set by an automatic end-of-video advance to the source that just
        /// finished. The server ignores the skip if the room has already moved
        /// on, so N viewers all reporting `ended` advance the queue only once.
        /// Absent for a manual (host) skip, which always advances.
        #[serde(default)]
        ended_media: Option<String>,
    },
    /// Host-only: remove a user from the room (they may rejoin).
    KickUser {
        client_id: String,
    },
    /// Host-only: remove a user and block their rejoin for the room's lifetime.
    BanUser {
        client_id: String,
    },
    LockRoom {
        locked: bool,
    },
    SetPersistent {
        persistent: bool,
    },
    MediaTitle {
        title: String,
    },
    ChatMessage {
        text: String,
    },
    Reaction {
        emoji: String,
    },
    Typing {
        typing: bool,
    },
    SyncRequest,
    Ping {
        client_time: f64,
    },
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// First frame after the socket opens; hands the client its connection id so
    /// it can ignore broadcasts caused by its own actions.
    Welcome {
        conn_id: String,
    },
    /// Successful join acknowledgement. `client_id` is the *effective* identity
    /// the server assigned (which may differ from the requested one if that seat
    /// was already taken); the client should adopt it. `seat_token` is the secret
    /// to persist and present on reconnect to reclaim this exact seat.
    Joined {
        you_are_host: bool,
        client_id: String,
        seat_token: String,
        snapshot: Snapshot,
        chat_history: Vec<ChatHistoryEntry>,
        config: JoinConfig,
        /// The account this socket's session resolved to, if any.
        #[serde(skip_serializing_if = "Option::is_none")]
        account: Option<AccountView>,
    },
    /// The host removed this connection (kick or ban). The client disconnects and
    /// returns to the landing page; a ban also blocks a rejoin server-side.
    Kicked {
        reason: String,
    },
    /// Join was rejected (room not found / full).
    JoinError {
        error: String,
    },
    /// A non-fatal intent failure (invalid URL, locked, queue full, …).
    ActionError {
        error: String,
    },
    /// Full authoritative state. `caused_by` is the originating connection id
    /// (null for server-initiated changes like enrichment).
    RoomState {
        snapshot: Snapshot,
        caused_by: Option<String>,
    },
    /// Lightweight drift-correction tick.
    Heartbeat {
        current_time: f64,
        paused: bool,
        rate: f64,
        server_time: f64,
    },
    ChatMessage {
        nickname: String,
        color: Option<String>,
        text: String,
        client_id: String,
        ts: f64,
    },
    SystemMessage {
        text: String,
        ts: f64,
    },
    Reaction {
        emoji: String,
        nickname: String,
        color: Option<String>,
        client_id: String,
        ts: f64,
    },
    Typing {
        client_id: String,
        nickname: String,
        typing: bool,
    },
    Pong {
        client_time: f64,
        server_time: f64,
    },
    /// Response to an explicit `sync_request`.
    SyncSnapshot {
        snapshot: Snapshot,
    },
}

impl ServerMsg {
    /// Serialize to a JSON string for transmission. Infallible in practice;
    /// falls back to an empty object if serialization ever fails.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}
