//! WatchSync server — authoritative room state + low-latency WebSocket sync.
//!
//! Built on axum/tokio. Room state lives entirely in memory behind an
//! `Arc<RwLock<…>>`; clients connect over a single `/ws` endpoint and exchange
//! typed JSON intents/events (see `protocol.rs`). A handful of small JSON HTTP
//! routes cover room creation and health.

mod auth;
mod config;
mod db;
mod http_limit;
mod media;
mod registry;
mod protocol;
mod rate_limit;
mod sanitize;
mod state;
mod stream;
mod ws;

use axum::extract::ConnectInfo;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};

use config::{Config, CorsOrigin};
use state::AppState;
use ws::{spawn_heartbeat, ws_handler, SharedState};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| Config::log_level().into()),
        )
        .init();

    let config = Config::from_env();
    let host = config.host.clone();
    let port = config.port;
    let cors = build_cors(&config.cors_origin);
    clean_streams_dir(&config.streams_dir);

    let database = db::init(&config.database_path)
        .await
        .unwrap_or_else(|e| panic!("failed to open database {:?}: {e}", config.database_path));

    let state: SharedState = Arc::new(AppState::new(config, database));
    // Start the uptime clock at boot. `health` used to be the only place that
    // initialized it, so uptime read 0 on the first probe and undercounted
    // from then on.
    let _ = START.set(Instant::now());
    let state_for_shutdown = state.clone();
    spawn_heartbeat(state.clone());
    auth::spawn_session_purge(state.clone());

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/:id", get(room_info))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/my/rooms", get(registry::list_rooms).post(registry::claim_room))
        .route("/api/my/rooms/check", get(registry::check_slug))
        .route("/api/my/rooms/:slug", axum::routing::delete(registry::release_room))
        .route("/api/subtitles", get(subtitles_list))
        .route("/api/subtitles/track", get(subtitles_track))
        // Dev/fallback static HLS. In production Nginx serves /api/streams/
        // straight off the shared RAM disk and this never runs (see nginx.conf).
        .route("/api/streams/:room/:file", get(serve_stream))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));

    tracing::info!("WatchSync {VERSION} ready on {addr}");

    // into_make_service_with_connect_info: client_ip needs the real socket peer
    // to decide whether a forwarding header may be believed at all.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("server error");

    // Kill every ffmpeg child before exiting.
    //
    // axum's graceful shutdown waits for all connections to close and
    // WebSockets never close on their own, so SIGTERM blocks until Docker's
    // grace period expires and SIGKILL lands. Because the process is killed
    // rather than unwound, the kill_on_drop backstop in stream.rs never runs:
    // outside a PID namespace those ffmpeg children are reparented to init and
    // keep writing into /dev/shm/streams, which clean_streams_dir then races
    // on the next boot. This sweep runs whenever we do reach it; the startup
    // tmpfs wipe stays the backstop for the SIGKILL path.
    state_for_shutdown.streams.stop_all().await;
    tracing::info!("shut down cleanly");
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

async fn health(State(state): State<SharedState>) -> impl IntoResponse {
    let start = START.get_or_init(Instant::now);
    let rooms = state.rooms.read().await.len();
    Json(json!({
        "ok": true,
        "version": VERSION,
        "rooms": rooms,
        "uptime": start.elapsed().as_secs(),
        "ts": state::now_ms(),
    }))
}

async fn create_room(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !state
        .room_limiter
        .allow(&client_ip(&headers, peer.ip(), &state.config))
        .await
    {
        return too_many_requests();
    }
    let Some((id, host_token)) = state.create_room().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Server is at room capacity — try again shortly" })),
        )
            .into_response();
    };
    Json(json!({ "id": id, "hostToken": host_token })).into_response()
}

/// Client IP used to key every per-IP rate limit.
///
/// Forwarding headers are believed ONLY when the socket peer is a configured
/// trusted proxy. Previously they were believed unconditionally, which made
/// the limits opt-out for anyone who could reach the server directly: a fresh
/// `X-Real-IP` per request meant a fresh bucket every time, including on the
/// login route, where the bucket is all that bounds argon2 work (19 MiB and
/// two iterations per attempt).
///
/// Untrusted peers are keyed by their real socket address. A trusted peer that
/// sends no forwarding header falls back to the same, so a misconfigured proxy
/// degrades to one shared bucket rather than to no limit at all.
pub(crate) fn client_ip(headers: &HeaderMap, peer: IpAddr, cfg: &Config) -> String {
    if !cfg.trusted_proxies.contains(peer) {
        return peer.to_string();
    }
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                // Leftmost entry is the client as reported by the first proxy.
                // Nginx's real_ip_recursive has already collapsed the trusted
                // tail, so this is the value that hop vouched for.
                .and_then(|s| s.split(',').next())
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .unwrap_or_else(|| peer.to_string())
}

pub(crate) fn too_many_requests() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": "Too many requests — slow down" })),
    )
        .into_response()
}

async fn room_info(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Unauthenticated and previously unthrottled, while every miss issues a
    // db::slug_owner query — a free slug-enumeration and DB-load primitive.
    if !state
        .room_limiter
        .allow(&client_ip(&headers, peer.ip(), &state.config))
        .await
    {
        return too_many_requests();
    }
    {
        let rooms = state.rooms.read().await;
        if let Some(room) = rooms.get(&id) {
            return Json(json!({
                "id": room.id,
                "exists": true,
                "registered": room.registered,
                "userCount": room.live_user_count(),
                "hasMedia": room.video.media.is_some(),
                "locked": room.locked,
            }))
            .into_response();
        }
    }
    // Not live — a registered slug still "exists" (it materializes on join).
    if let Ok(Some(_)) = db::slug_owner(&state.db, &id).await {
        return Json(json!({
            "id": id,
            "exists": true,
            "registered": true,
            "userCount": 0,
            "hasMedia": false,
            "locked": false,
        }))
        .into_response();
    }
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response()
}

/// `true` for a plausible non-huge http(s) URL — shared guard for the routes
/// that forward a user-pasted URL to the resolver sidecar.
fn valid_forward_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    url.len() <= 4096 && (lower.starts_with("http://") || lower.starts_with("https://"))
}

#[derive(Deserialize)]
struct SubtitlesListQuery {
    url: String,
}

/// List the subtitle languages available for a media URL (manual tracks plus
/// YouTube's auto-generated/auto-translated ones) via the resolver sidecar.
/// The embedded YouTube player is served a reduced caption dataset, so the
/// client builds its own caption menu from this instead.
async fn subtitles_list(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<SubtitlesListQuery>,
) -> impl IntoResponse {
    if !state
        .resolve_limiter
        .allow(&client_ip(&headers, peer.ip(), &state.config))
        .await
    {
        return too_many_requests();
    }
    let Some(base) = state.config.resolver_url.clone() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "External resolver not configured" })),
        )
            .into_response();
    };
    let url = q.url.trim();
    if !valid_forward_url(url) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid URL" }))).into_response();
    }

    let endpoint = format!("{base}/subtitles/list");
    match state
        .http
        .get(&endpoint)
        .query(&[("url", url)])
        .timeout(Duration::from_secs(30))
        .send()
        .await
    {
        Ok(resp) => {
            let code = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            match resp.json::<serde_json::Value>().await {
                Ok(body) => (code, Json(body)).into_response(),
                Err(_) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "Resolver returned an invalid response" })),
                )
                    .into_response(),
            }
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Resolver unavailable" })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct SubtitlesTrackQuery {
    url: String,
    lang: String,
}

/// Fetch one subtitle track as WebVTT through the resolver sidecar. Proxied
/// (rather than fetched by the browser) because the CDN subtitle URLs are
/// short-lived, cross-origin, and only known to the resolver.
async fn subtitles_track(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<SubtitlesTrackQuery>,
) -> Response {
    if !state
        .resolve_limiter
        .allow(&client_ip(&headers, peer.ip(), &state.config))
        .await
    {
        return too_many_requests();
    }
    let Some(base) = state.config.resolver_url.clone() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "External resolver not configured" })),
        )
            .into_response();
    };
    let url = q.url.trim();
    let lang = q.lang.trim();
    let lang_ok = !lang.is_empty()
        && lang.len() <= 20
        && lang.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid_forward_url(url) || !lang_ok {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid request" }))).into_response();
    }

    let endpoint = format!("{base}/subtitles/get");
    // Generous: the resolver retries YouTube's ~15-20s translation rate limit
    // internally, so a first-time translated track can legitimately take ~20s.
    match state
        .http
        .get(&endpoint)
        .query(&[("url", url), ("lang", lang)])
        .timeout(Duration::from_secs(45))
        .send()
        .await
    {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let ctype = resp
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            match resp.bytes().await {
                Ok(body) if status.is_success() => (
                    status,
                    [
                        (axum::http::header::CONTENT_TYPE, ctype),
                        // The track for a given (video, lang) never changes;
                        // let the browser cache re-selections for a while.
                        (axum::http::header::CACHE_CONTROL, "private, max-age=3600".to_string()),
                    ],
                    body,
                )
                    .into_response(),
                Ok(body) => (
                    status,
                    [(axum::http::header::CONTENT_TYPE, ctype)],
                    body,
                )
                    .into_response(),
                Err(_) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "Resolver returned an invalid response" })),
                )
                    .into_response(),
            }
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Resolver unavailable" })),
        )
            .into_response(),
    }
}

/// Serve an on-the-fly HLS file (playlist or segment) off the shared RAM disk.
///
/// In production Nginx serves `/api/streams/` directly and this route is never
/// reached; it exists so the Vite dev proxy (which forwards `/api` here) can
/// play proxied streams without Nginx, and as a safety net if someone forgets
/// the Nginx `location`. Strict allow-list on both path segments — no traversal.
async fn serve_stream(
    State(state): State<SharedState>,
    Path((room, file)): Path<(String, String)>,
) -> Response {
    // Hyphens included: registered room slugs allow them (still no dots or
    // separators, so the path stays traversal-proof).
    let room_ok = !room.is_empty()
        && room.len() <= 32
        && room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let file_ok = file == "index.m3u8" || valid_segment(&file);
    if !room_ok || !file_ok {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let path = state.config.streams_dir.join(&room).join(&file);
    // Stream the body rather than tokio::fs::read'ing the whole file into
    // memory. A 4s segment of a high-bitrate remux is tens of MB, and this
    // route has no rate limit, so N concurrent requests multiplied that
    // directly into RSS. (In the shipped topology Nginx serves these off the
    // shared RAM disk and this route is the dev/fallback path.)
    let fh = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let len = fh.metadata().await.ok().map(|m| m.len());
    let ctype = if file.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else {
        "video/mp2t"
    };
    // 64 KiB at a time, so peak memory per request is the chunk, not the file.
    // Hand-rolled with futures-util (already a direct dependency) rather than
    // pulling in tokio-util just for ReaderStream.
    let stream = futures_util::stream::try_unfold(fh, |mut f| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 64 * 1024];
        let n = f.read(&mut buf).await?;
        if n == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            buf.truncate(n);
            Ok(Some((buf, f)))
        }
    });
    let body = axum::body::Body::from_stream(stream);
    let mut resp = Response::builder()
        .header(axum::http::header::CONTENT_TYPE, ctype)
        .header(axum::http::header::CACHE_CONTROL, "no-cache");
    if let Some(len) = len {
        resp = resp.header(axum::http::header::CONTENT_LENGTH, len);
    }
    resp.body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "error").into_response())
}

/// `seg_<digits>.ts` only — the exact shape ffmpeg's segment pattern produces.
fn valid_segment(file: &str) -> bool {
    match file.strip_prefix("seg_").and_then(|s| s.strip_suffix(".ts")) {
        Some(mid) => !mid.is_empty() && mid.len() <= 10 && mid.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

/// Wipe leftover per-room HLS dirs from a previous run. The streams dir is a
/// shared volume that outlives the container, but rooms are in-memory only —
/// after a restart every dir under it is orphaned RAM. Only the *children* are
/// removed; the dir itself is a mount point.
fn clean_streams_dir(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let gone = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if gone {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::info!("cleaned {removed} stale entries from {dir:?}");
    }
}

fn build_cors(origin: &CorsOrigin) -> CorsLayer {
    // DELETE was missing while the router exposes it (/api/my/rooms/:slug), so
    // releasing a room failed its preflight on any split-origin deployment.
    let base = CorsLayer::new().allow_methods([Method::GET, Method::POST, Method::DELETE]);
    match origin {
        // `Any` cannot be combined with credentials — the browser refuses the
        // pair — so a wildcard origin stays cookie-less by construction, and
        // only there may the header list stay wide open.
        CorsOrigin::Any => base.allow_origin(Any).allow_headers(Any),
        CorsOrigin::List(list) => {
            let origins: Vec<HeaderValue> = list
                .iter()
                .filter_map(|o| match o.parse() {
                    Ok(v) => Some(v),
                    Err(_) => {
                        tracing::warn!("ignoring unparsable CORS_ORIGIN entry {o:?}");
                        None
                    }
                })
                .collect();
            if origins.is_empty() {
                tracing::error!(
                    "CORS_ORIGIN had no usable origins; falling back to wildcard (cookie-less)"
                );
                return base.allow_origin(Any).allow_headers(Any);
            }
            // With an explicit origin list the session cookie must be allowed
            // to ride cross-origin, or the split-origin setup this code
            // advertises cannot authenticate at all. `allow_headers(Any)` is
            // NOT usable here: tower-http panics at startup on the
            // credentials + wildcard-headers pair (the spec forbids it), so
            // the headers the frontend actually sends are named explicitly.
            base.allow_origin(origins)
                .allow_headers([header::CONTENT_TYPE, header::ACCEPT])
                .allow_credentials(true)
        }
    }
}

/// Resolve on SIGINT / SIGTERM so in-flight sockets close cleanly on stop.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tower-http validates CORS rules when the layer is applied and panics on
    /// forbidden combinations (credentials + wildcard headers/methods). That
    /// panic happened at boot, so a bad pairing surfaced as a restart loop in
    /// production rather than as a failing build. Apply every branch here.
    #[test]
    fn every_cors_branch_builds_without_panicking() {
        let origins = [
            CorsOrigin::Any,
            CorsOrigin::List(vec!["https://watch.example.com".into()]),
            CorsOrigin::List(vec!["https://a.example".into(), "https://b.example".into()]),
            // Nothing parseable: must fall back to the wildcard, not panic.
            CorsOrigin::List(vec!["bad\norigin".into()]),
        ];
        for origin in &origins {
            let _app: Router = Router::new()
                .route("/", get(|| async { "ok" }))
                .layer(build_cors(origin));
        }
    }

    #[test]
    fn stream_segment_names_are_allow_listed() {
        assert!(valid_segment("seg_00001.ts"));
        assert!(!valid_segment("seg_.ts"));
        assert!(!valid_segment("seg_../../x.ts"));
        assert!(!valid_segment("seg_12345678901.ts"));
        assert!(!valid_segment("index.m3u8"));
    }
}
