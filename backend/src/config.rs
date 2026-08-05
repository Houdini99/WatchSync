//! Single source of truth for every tunable. Each knob is overridable via an
//! environment variable so the same image serves a tiny watch party or a busier
//! instance without a rebuild. Nothing else should hardcode these numbers.

use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Bucket {
    pub capacity: f64,
    pub refill_per_sec: f64,
}

#[derive(Clone, Debug)]
pub enum CorsOrigin {
    /// Reflect any origin (testing only).
    Any,
    /// An explicit allow-list of origins.
    List(Vec<String>),
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub cors_origin: CorsOrigin,
    /// Base URL of the optional yt-dlp resolver sidecar. `None` → `/api/resolve`
    /// stays a 501 stub.
    pub resolver_url: Option<String>,
    /// Permit media URLs that resolve to private/loopback/link-local addresses.
    /// Off by default: user-pasted URLs are fetched server-side (ffmpeg/yt-dlp),
    /// which is an SSRF vector into the Docker network on a public instance.
    pub allow_private_urls: bool,

    // Optional account layer (SQLite).
    /// SQLite file holding users/sessions/registered rooms. The Docker image
    /// sets this to `/data/watchsync.db` (a named volume); the bare default is
    /// dev-friendly relative to the working directory.
    pub database_path: PathBuf,
    /// Allow new signups. Turn off to lock a public instance down once your
    /// friends have registered — existing accounts keep working.
    pub registration_enabled: bool,
    /// Max custom room slugs a single account may register (anti-squatting).
    pub max_rooms_per_user: usize,
    /// Session lifetime; sliding (refreshed on use, at most once a day).
    pub session_ttl_days: u64,
    /// Mark the session cookie `Secure` (HTTPS-only). Leave on in production;
    /// browsers exempt localhost, so dev works either way. Turn off only for a
    /// plain-HTTP LAN install.
    pub cookie_secure: bool,

    // Server-side HLS proxy (ffmpeg → RAM disk).
    /// Root of the shared tmpfs where per-room HLS is written
    /// (`{streams_dir}/{room_id}/index.m3u8`). Mounted in docker-compose.
    pub streams_dir: PathBuf,
    /// `-hls_time`: target segment length in seconds.
    pub hls_segment_sec: u32,
    /// `-b:a` for the transcoded AAC audio track.
    pub stream_audio_bitrate: String,
    /// How long to wait for ffmpeg to produce a playable playlist before
    /// flagging the stream as failed.
    pub stream_ready_timeout_sec: u64,

    // Sync timing.
    pub heartbeat_ms: u64,
    pub drift_tolerance_sec: f64,

    // Lifecycle.
    pub empty_room_ttl_ms: u64,
    pub reconnect_grace_ms: u64,

    // Limits.
    pub max_users_per_room: usize,
    pub max_rooms: usize,
    pub max_queue_length: usize,
    pub chat_history_limit: usize,
    pub nickname_max_len: usize,
    pub chat_max_len: usize,
    pub url_max_len: usize,

    // Token buckets (capacity, refill tokens/sec).
    pub chat_bucket: Bucket,
    pub reaction_bucket: Bucket,
    pub global_bucket: Bucket,
    /// Per-connection guard for expensive intents (change_video, queue_add) that
    /// spawn ffmpeg / call the resolver, so they can't be spammed into churn.
    pub heavy_bucket: Bucket,
    /// Per-IP HTTP limiter for `POST /api/rooms`.
    pub http_room_bucket: Bucket,
    /// Per-IP HTTP limiter for the resolver-backed routes (resolve/subtitles).
    pub http_resolve_bucket: Bucket,
    /// Per-IP HTTP limiter for the auth routes (register/login), which each do
    /// an argon2 hash — deliberately expensive, so keep the refill low.
    pub http_auth_bucket: Bucket,
    /// Per-username limiter for login attempts (argon2 verify), so one target
    /// account can't be brute-forced from many IPs.
    pub login_user_bucket: Bucket,

    // Allowed playback speeds; the server rejects anything else.
    pub allowed_rates: Vec<f64>,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            port: env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3000),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            cors_origin: parse_origin(env::var("CORS_ORIGIN").ok().as_deref()),
            resolver_url: env::var("RESOLVER_URL")
                .ok()
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty()),
            allow_private_urls: env_bool("ALLOW_PRIVATE_URLS", false),

            database_path: env::var("DATABASE_PATH")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("data/watchsync.db")),
            registration_enabled: env_bool("REGISTRATION_ENABLED", true),
            max_rooms_per_user: uint("MAX_ROOMS_PER_USER", 5) as usize,
            session_ttl_days: uint("SESSION_TTL_DAYS", 30),
            cookie_secure: env_bool("COOKIE_SECURE", true),

            streams_dir: env::var("STREAMS_DIR")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/dev/shm/streams")),
            hls_segment_sec: uint("HLS_SEGMENT_SEC", 4) as u32,
            stream_audio_bitrate: env::var("STREAM_AUDIO_BITRATE")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "192k".to_string()),
            stream_ready_timeout_sec: uint("STREAM_READY_TIMEOUT_SEC", 30),

            heartbeat_ms: uint("HEARTBEAT_MS", 4000),
            drift_tolerance_sec: ufloat("DRIFT_TOLERANCE_SEC", 1.5),

            empty_room_ttl_ms: uint("EMPTY_ROOM_TTL_MS", 5 * 60 * 1000),
            reconnect_grace_ms: uint("RECONNECT_GRACE_MS", 12 * 1000),

            max_users_per_room: uint("MAX_USERS_PER_ROOM", 50) as usize,
            max_rooms: uint("MAX_ROOMS", 5000) as usize,
            max_queue_length: uint("MAX_QUEUE_LENGTH", 200) as usize,
            chat_history_limit: uint("CHAT_HISTORY_LIMIT", 80) as usize,
            nickname_max_len: uint("NICKNAME_MAX_LEN", 24) as usize,
            chat_max_len: uint("CHAT_MAX_LEN", 500) as usize,
            url_max_len: uint("URL_MAX_LEN", 2048) as usize,

            chat_bucket: Bucket {
                capacity: uint("CHAT_BUCKET_CAP", 5) as f64,
                refill_per_sec: ufloat("CHAT_BUCKET_REFILL", 0.5),
            },
            reaction_bucket: Bucket {
                capacity: uint("REACTION_BUCKET_CAP", 8) as f64,
                refill_per_sec: ufloat("REACTION_BUCKET_REFILL", 2.0),
            },
            global_bucket: Bucket {
                capacity: uint("GLOBAL_BUCKET_CAP", 40) as f64,
                refill_per_sec: ufloat("GLOBAL_BUCKET_REFILL", 20.0),
            },
            heavy_bucket: Bucket {
                capacity: uint("HEAVY_BUCKET_CAP", 6) as f64,
                refill_per_sec: ufloat("HEAVY_BUCKET_REFILL", 1.0),
            },
            http_room_bucket: Bucket {
                capacity: uint("HTTP_ROOM_BUCKET_CAP", 10) as f64,
                refill_per_sec: ufloat("HTTP_ROOM_BUCKET_REFILL", 0.2),
            },
            http_resolve_bucket: Bucket {
                capacity: uint("HTTP_RESOLVE_BUCKET_CAP", 15) as f64,
                refill_per_sec: ufloat("HTTP_RESOLVE_BUCKET_REFILL", 0.5),
            },
            http_auth_bucket: Bucket {
                capacity: uint("HTTP_AUTH_BUCKET_CAP", 10) as f64,
                refill_per_sec: ufloat("HTTP_AUTH_BUCKET_REFILL", 0.2),
            },
            login_user_bucket: Bucket {
                capacity: uint("LOGIN_USER_BUCKET_CAP", 10) as f64,
                refill_per_sec: ufloat("LOGIN_USER_BUCKET_REFILL", 0.1),
            },

            allowed_rates: parse_rates(env::var("ALLOWED_RATES").ok().as_deref())
                .unwrap_or_else(|| vec![0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]),
        }
    }

    pub fn log_level() -> String {
        env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string())
    }
}

/// Positive integer env var, else fallback.
fn uint(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.floor() as u64)
        .unwrap_or(fallback)
}

/// Boolean env var (`1`/`true`/`yes`, case-insensitive), else fallback.
fn env_bool(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => fallback,
    }
}

/// Non-negative float env var, else fallback.
fn ufloat(name: &str, fallback: f64) -> f64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(fallback)
}

/// `*` / unset → reflect any origin; otherwise a single origin or a
/// comma-separated allow-list.
fn parse_origin(raw: Option<&str>) -> CorsOrigin {
    match raw {
        None | Some("") | Some("*") => CorsOrigin::Any,
        Some(s) => {
            let list: Vec<String> = s
                .split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();
            if list.is_empty() {
                CorsOrigin::Any
            } else {
                CorsOrigin::List(list)
            }
        }
    }
}

/// Parse a comma-separated list of playback rates, keeping only finite values in
/// (0, 4], de-duplicated and sorted. Returns `None` if nothing usable remains.
fn parse_rates(raw: Option<&str>) -> Option<Vec<f64>> {
    let raw = raw?;
    let mut rates: Vec<f64> = raw
        .split(',')
        .filter_map(|p| p.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 4.0)
        .collect();
    rates.sort_by(|a, b| a.partial_cmp(b).unwrap());
    rates.dedup_by(|a, b| (*a - *b).abs() < f64::EPSILON);
    if rates.is_empty() {
        None
    } else {
        Some(rates)
    }
}
