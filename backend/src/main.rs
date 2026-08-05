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

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
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
        .route("/api/resolve", get(resolve))
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

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");

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

async fn create_room(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if !state.room_limiter.allow(&client_ip(&headers)).await {
        return too_many_requests();
    }
    let (id, host_token) = state.create_room().await;
    Json(json!({ "id": id, "hostToken": host_token })).into_response()
}

/// Best-effort client IP for per-IP rate limiting. Behind the bundled Nginx the
/// real client is in `X-Real-IP` / `X-Forwarded-For`; fall back to a shared key
/// (so header-less callers are limited together rather than not at all).
pub(crate) fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.split(',').next())
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
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
    Path(id): Path<String>,
) -> impl IntoResponse {
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

#[derive(Deserialize)]
struct ResolveQuery {
    url: String,
}

/// Resolve a page URL (Vimeo / Twitch / Dailymotion / Reddit / …) to a direct,
/// browser-playable stream URL by forwarding to the yt-dlp resolver sidecar.
/// Returns 501 when no resolver is configured (`RESOLVER_URL` unset).
async fn resolve(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(q): Query<ResolveQuery>,
) -> impl IntoResponse {
    if !state.resolve_limiter.allow(&client_ip(&headers)).await {
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

    let endpoint = format!("{base}/resolve");
    match state
        .http
        .get(&endpoint)
        .query(&[("url", url)])
        .timeout(Duration::from_secs(25))
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
    headers: HeaderMap,
    Query(q): Query<SubtitlesListQuery>,
) -> impl IntoResponse {
    if !state.resolve_limiter.allow(&client_ip(&headers)).await {
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
    headers: HeaderMap,
    Query(q): Query<SubtitlesTrackQuery>,
) -> Response {
    if !state.resolve_limiter.allow(&client_ip(&headers)).await {
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
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let ctype = if file.ends_with(".m3u8") {
                "application/vnd.apple.mpegurl"
            } else {
                "video/mp2t"
            };
            (
                [
                    (axum::http::header::CONTENT_TYPE, ctype),
                    (axum::http::header::CACHE_CONTROL, "no-cache"),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
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
    let base = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);
    match origin {
        CorsOrigin::Any => base.allow_origin(Any),
        CorsOrigin::List(list) => {
            let origins: Vec<HeaderValue> =
                list.iter().filter_map(|o| o.parse().ok()).collect();
            base.allow_origin(origins)
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
