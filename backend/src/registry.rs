//! Persistent custom room IDs ("registered rooms"). The registration — slug +
//! owner — lives in SQLite forever; the room *state* stays in-memory and is
//! reaped when empty exactly like an ad-hoc room. Opening a registered slug
//! later re-materializes a fresh room under the same URL (see ws.rs), so the
//! link never dies. These handlers cover claiming, listing, availability
//! checks, and release; all of them require a signed-in session.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::auth;
use crate::db;
use crate::state::now_ms;
use crate::ws::SharedState;
use crate::{client_ip, too_many_requests};

/// Slugs users may claim: 3–32 chars of lowercase letters / digits / hyphens,
/// no leading or trailing hyphen. The charset deliberately excludes anything
/// that could read as path traversal — a slug becomes a directory name under
/// the streams tmpfs and a URL path segment.
pub fn valid_slug(slug: &str) -> bool {
    let b = slug.as_bytes();
    (3..=32).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// Names kept out of user hands: app surfaces, likely future routes, and
/// generic labels that would read as official.
const RESERVED: &[&str] = &[
    "api", "ws", "www", "app", "admin", "mod", "staff", "official", "system", "root", "new",
    "create", "room", "rooms", "watchsync", "assets", "static", "stream", "streams", "health",
    "login", "logout", "register", "signup", "account", "settings", "help", "about",
];

fn reserved(slug: &str) -> bool {
    RESERVED.contains(&slug)
}

/// Why a slug can't be claimed, as a user-facing string — or `None` when it is
/// syntactically fine and not reserved (existence checks happen separately).
fn shape_problem(slug: &str) -> Option<&'static str> {
    if !valid_slug(slug) {
        return Some("Room names are 3–32 characters: lowercase letters, digits, hyphens");
    }
    if reserved(slug) {
        return Some("That name is reserved");
    }
    None
}

fn json_err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

// ---------------------------------------------------------------------------
// Handlers (all session-gated)
// ---------------------------------------------------------------------------

pub async fn list_rooms(State(state): State<SharedState>, headers: axum::http::HeaderMap) -> Response {
    let Some(user) = auth::authed_user(&state, &headers).await else {
        return auth::unauthorized();
    };
    let regs = match db::owner_rooms(&state.db, user.id).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("owner_rooms failed: {e}");
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not load rooms");
        }
    };
    let rooms = state.rooms.read().await;
    let list: Vec<_> = regs
        .iter()
        .map(|r| {
            let live = rooms.get(&r.slug);
            json!({
                "slug": r.slug,
                "createdAt": r.created_at,
                "live": live.is_some(),
                "userCount": live.map_or(0, |room| room.live_user_count()),
            })
        })
        .collect();
    Json(json!({ "rooms": list, "max": state.config.max_rooms_per_user })).into_response()
}

#[derive(Deserialize)]
pub struct ClaimBody {
    slug: String,
}

pub async fn claim_room(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ClaimBody>,
) -> Response {
    if !state.auth_limiter.allow(&client_ip(&headers)).await {
        return too_many_requests();
    }
    let Some(user) = auth::authed_user(&state, &headers).await else {
        return auth::unauthorized();
    };
    let slug = body.slug.trim().to_ascii_lowercase();
    if let Some(problem) = shape_problem(&slug) {
        return json_err(StatusCode::BAD_REQUEST, problem);
    }
    // A live ad-hoc room with this exact id (10-char generated ids share the
    // charset) — don't let a registration shadow a room people are sitting in.
    if state.rooms.read().await.contains_key(&slug) {
        return json_err(StatusCode::CONFLICT, "That name is taken");
    }
    match db::owner_room_count(&state.db, user.id).await {
        Ok(n) if n >= state.config.max_rooms_per_user as i64 => {
            return json_err(
                StatusCode::FORBIDDEN,
                "Room limit reached — release one to claim another",
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!("owner_room_count failed: {e}");
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not claim room");
        }
    }
    match db::claim_slug(&state.db, &slug, user.id, now_ms() as i64).await {
        Ok(db::ClaimOutcome::Claimed) => {
            tracing::info!("room slug claimed: {slug} by {}", user.username);
            Json(json!({ "slug": slug })).into_response()
        }
        Ok(db::ClaimOutcome::Taken) => json_err(StatusCode::CONFLICT, "That name is taken"),
        Err(e) => {
            tracing::error!("claim_slug failed: {e}");
            json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not claim room")
        }
    }
}

#[derive(Deserialize)]
pub struct CheckQuery {
    slug: String,
}

/// Live availability feedback while the user types a name to claim.
pub async fn check_slug(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<CheckQuery>,
) -> Response {
    if auth::authed_user(&state, &headers).await.is_none() {
        return auth::unauthorized();
    }
    let slug = q.slug.trim().to_ascii_lowercase();
    if let Some(problem) = shape_problem(&slug) {
        return Json(json!({ "available": false, "reason": problem })).into_response();
    }
    if state.rooms.read().await.contains_key(&slug) {
        return Json(json!({ "available": false, "reason": "That name is taken" })).into_response();
    }
    match db::slug_owner(&state.db, &slug).await {
        Ok(None) => Json(json!({ "available": true })).into_response(),
        Ok(Some(_)) => {
            Json(json!({ "available": false, "reason": "That name is taken" })).into_response()
        }
        Err(e) => {
            tracing::error!("slug_owner failed: {e}");
            json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not check name")
        }
    }
}

/// Release a registration. A live in-memory instance keeps running until it
/// empties and is reaped — releasing only stops future re-materialization (and
/// owner-host on the next hydration).
pub async fn release_room(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Path(slug): Path<String>,
) -> Response {
    let Some(user) = auth::authed_user(&state, &headers).await else {
        return auth::unauthorized();
    };
    let slug = slug.trim().to_ascii_lowercase();
    match db::release_slug(&state.db, &slug, user.id).await {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => json_err(StatusCode::NOT_FOUND, "Not one of your rooms"),
        Err(e) => {
            tracing::error!("release_slug failed: {e}");
            json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not release room")
        }
    }
}
