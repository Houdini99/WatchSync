//! Single source of truth for every tunable. Each knob is overridable via an
//! environment variable so the same image serves a tiny watch party or a busier
//! instance without a rebuild. Nothing else should hardcode these numbers.

use std::env;
use std::net::IpAddr;
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
    /// Peers whose `X-Real-IP` / `X-Forwarded-For` headers may be believed.
    /// Anything else is rate-limited by its actual socket address.
    pub trusted_proxies: TrustedProxies,
    /// Base URL of the optional yt-dlp resolver sidecar, used server-side by
    /// `stream::prepare_source` and the `/api/subtitles*` routes. `None` →
    /// non-direct media falls back to handing the page URL straight to ffmpeg
    /// (usually a failure) and subtitle listing returns 501.
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
    /// `-fs`: hard byte ceiling on ONE room's ffmpeg output. The RAM disk is
    /// shared by every room, so without a per-room budget a single long video
    /// fills it and every other room's ffmpeg dies with ENOSPC.
    pub stream_max_bytes: u64,
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
            trusted_proxies: TrustedProxies::parse(
                env::var("TRUSTED_PROXIES").ok().as_deref(),
            ),
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
            // 1 GiB: roughly a 2h 1080p H.264 remux, and half the default 2g
            // tmpfs, so one room cannot starve the rest on its own.
            stream_max_bytes: uint("STREAM_MAX_BYTES", 1024 * 1024 * 1024),
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

// ---------------------------------------------------------------------------
// Trusted proxies
// ---------------------------------------------------------------------------

/// The set of peers allowed to tell us who the real client is.
///
/// `client_ip` keys every per-IP rate limit, so believing a forwarding header
/// from an arbitrary peer means the limits are opt-out: any caller can send
/// `X-Real-IP: <random>` per request and never hit a bucket. Believing NO peer
/// is equally wrong behind the bundled Nginx, where the socket address is
/// always the proxy container. So: believe the header only from a listed peer.
#[derive(Clone, Debug)]
pub struct TrustedProxies(Vec<(IpAddr, u8)>);

/// Private/loopback space. The default because in every supported topology the
/// hop in front of the server is a container on a Docker network; a public
/// source address is by definition not our reverse proxy.
const DEFAULT_TRUSTED_PROXIES: &str =
    "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7";

impl TrustedProxies {
    /// Comma-separated CIDRs or bare IPs. Unset uses the private-range default;
    /// an explicit empty string trusts nothing (every client keyed by its real
    /// socket address, correct when the server is exposed directly).
    pub fn parse(raw: Option<&str>) -> Self {
        let spec = match raw {
            None => DEFAULT_TRUSTED_PROXIES,
            Some(s) if s.trim().is_empty() => return TrustedProxies(Vec::new()),
            Some(s) => s,
        };
        let nets = spec
            .split(',')
            .filter_map(|entry| parse_cidr(entry.trim()))
            .collect();
        TrustedProxies(nets)
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        // An IPv4-mapped peer (::ffff:10.0.0.1) must match IPv4 rules.
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
            v4 => v4,
        };
        self.0.iter().any(|&(net, prefix)| ip_in_net(ip, net, prefix))
    }
}

/// `"10.0.0.0/8"` or `"10.1.2.3"` (treated as a full-length prefix).
fn parse_cidr(entry: &str) -> Option<(IpAddr, u8)> {
    if entry.is_empty() {
        return None;
    }
    let (addr_part, prefix_part) = match entry.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (entry, None),
    };
    let addr: IpAddr = addr_part.parse().ok()?;
    let max = if addr.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix_part {
        None => max,
        Some(p) => {
            let n: u8 = p.parse().ok()?;
            if n > max {
                return None;
            }
            n
        }
    };
    Some((addr, prefix))
}

/// `true` when `ip` falls inside `net/prefix`. Mismatched families never match.
fn ip_in_net(ip: IpAddr, net: IpAddr, prefix: u8) -> bool {
    fn masked_eq(a: &[u8], b: &[u8], prefix: u8) -> bool {
        let full = (prefix / 8) as usize;
        let rem = prefix % 8;
        if a[..full] != b[..full] {
            return false;
        }
        if rem == 0 {
            return true;
        }
        let mask = 0xffu8 << (8 - rem);
        (a[full] & mask) == (b[full] & mask)
    }
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(b)) => masked_eq(&a.octets(), &b.octets(), prefix),
        (IpAddr::V6(a), IpAddr::V6(b)) => masked_eq(&a.octets(), &b.octets(), prefix),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn default_trusts_private_space_only() {
        let t = TrustedProxies::parse(None);
        for addr in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
                     "192.168.1.1", "::1", "fd00::1"] {
            assert!(t.contains(ip(addr)), "{addr} should be trusted by default");
        }
        for addr in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255",
                     "193.168.1.1", "2606:4700::1111"] {
            assert!(!t.contains(ip(addr)), "{addr} must NOT be trusted");
        }
    }

    /// An explicit empty value means "trust nothing" -- correct when the server
    /// is exposed directly rather than behind the bundled nginx.
    #[test]
    fn explicit_empty_trusts_nothing() {
        let t = TrustedProxies::parse(Some(""));
        assert!(!t.contains(ip("127.0.0.1")));
        assert!(!t.contains(ip("10.0.0.1")));
    }

    #[test]
    fn parses_explicit_list_and_bare_ips() {
        let t = TrustedProxies::parse(Some("203.0.113.7, 198.51.100.0/24"));
        assert!(t.contains(ip("203.0.113.7")));
        assert!(!t.contains(ip("203.0.113.8")), "bare IP is a /32");
        assert!(t.contains(ip("198.51.100.1")));
        assert!(t.contains(ip("198.51.100.255")));
        assert!(!t.contains(ip("198.51.101.0")));
        assert!(!t.contains(ip("10.0.0.1")), "default is replaced, not extended");
    }

    /// Docker frequently presents peers as ::ffff:a.b.c.d on a dual-stack
    /// listener; those must match the IPv4 rules or nginx stops being trusted.
    #[test]
    fn ipv4_mapped_peer_matches_ipv4_rule() {
        let t = TrustedProxies::parse(Some("172.16.0.0/12"));
        assert!(t.contains(ip("::ffff:172.16.0.5")));
        assert!(!t.contains(ip("::ffff:8.8.8.8")));
    }

    #[test]
    fn non_byte_aligned_prefixes() {
        let t = TrustedProxies::parse(Some("10.0.0.0/12"));
        assert!(t.contains(ip("10.0.0.1")));
        assert!(t.contains(ip("10.15.255.255")));
        assert!(!t.contains(ip("10.16.0.0")));
    }

    #[test]
    fn malformed_entries_are_skipped_not_fatal() {
        let t = TrustedProxies::parse(Some("not-an-ip,10.0.0.0/8,10.0.0.0/99,"));
        assert!(t.contains(ip("10.1.1.1")));
        assert!(!t.contains(ip("8.8.8.8")));
    }

    #[test]
    fn families_do_not_cross_match() {
        let t = TrustedProxies::parse(Some("0.0.0.0/0"));
        assert!(t.contains(ip("8.8.8.8")));
        assert!(!t.contains(ip("2606:4700::1111")), "v4 rule must not match v6");
    }
}
