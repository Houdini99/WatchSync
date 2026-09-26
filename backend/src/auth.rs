//! Optional account layer: register / login / logout / me, plus the session
//! resolution shared by the HTTP routes and the WebSocket upgrade.
//!
//! Sessions are opaque random tokens delivered in an HttpOnly cookie; only
//! their SHA-256 hash is stored, so a leaked database cannot replay live
//! sessions. Passwords are argon2id, hashed off the async workers. Guests are
//! untouched: every route here is additive and nothing else requires it.

use axum::extract::ConnectInfo;
use std::net::SocketAddr;
use std::fmt::Write as _;
use std::sync::OnceLock;
use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use nanoid::nanoid;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::db::{self, AuthedUser};
use crate::sanitize::sanitize_text;
use crate::state::now_ms;
use crate::ws::SharedState;
use crate::{client_ip, too_many_requests};

pub const SESSION_COOKIE: &str = "ws_session";
/// Sliding-expiry refresh happens at most this often per session.
const SESSION_REFRESH_MIN_AGE_MS: i64 = 86_400_000;
const MS_PER_DAY: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// Session plumbing (also used by ws.rs and registry.rs)
// ---------------------------------------------------------------------------

fn hash_token(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// The raw session token from a request's Cookie header, if present.
fn session_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        (k == SESSION_COOKIE && !v.is_empty()).then(|| v.to_string())
    })
}

/// Resolve the request's session cookie to a user, refreshing the sliding
/// expiry as a side effect. `None` for guests, expired sessions, and DB errors
/// alike — auth fails closed and must never turn a join into a 500.
pub async fn authed_user(state: &SharedState, headers: &HeaderMap) -> Option<AuthedUser> {
    let raw = session_token(headers)?;
    let token_hash = hash_token(&raw);
    let now = now_ms() as i64;
    let user = db::session_user(&state.db, &token_hash, now).await.ok().flatten()?;
    let ttl_ms = state.config.session_ttl_days as i64 * MS_PER_DAY;
    if let Err(e) =
        db::refresh_session(&state.db, &token_hash, now, ttl_ms, SESSION_REFRESH_MIN_AGE_MS).await
    {
        tracing::warn!("session refresh failed: {e}");
    }
    Some(user)
}

fn session_cookie(config: &Config, raw: &str, max_age_secs: i64) -> String {
    let mut c =
        format!("{SESSION_COOKIE}={raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}");
    if config.cookie_secure {
        c.push_str("; Secure");
    }
    c
}

pub fn user_view(u: &AuthedUser) -> serde_json::Value {
    json!({ "username": u.username, "displayName": u.display_name, "color": u.color })
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

pub fn unauthorized() -> Response {
    err(StatusCode::UNAUTHORIZED, "Sign in required")
}

/// Mint a session for `user` and answer with the cookie + user payload.
async fn start_session(state: &SharedState, user: AuthedUser, prev: Option<String>) -> Response {
    let raw = nanoid!(43); // 43 chars × 64-symbol alphabet ≈ 258 bits
    let token_hash = hash_token(&raw);
    // Retire the session this request arrived with, if any. Signing in already
    // mints a fresh random token (so a planted cookie is replaced, and
    // fixation never had a foothold), but the row behind the OLD cookie used
    // to be left valid until the 6-hourly purge — one orphaned, still-usable
    // session per re-login on the same browser.
    //
    // Deliberately scoped to this one session, NOT every session for the
    // account: signing in on a phone must not sign you out on a laptop.
    if let Some(prev_raw) = prev {
        let prev_hash = hash_token(&prev_raw);
        if prev_hash != token_hash {
            if let Err(e) = db::delete_session(&state.db, &prev_hash).await {
                // Non-fatal: the new session works; the old row just lingers.
                tracing::warn!("could not retire previous session: {e}");
            }
        }
    }
    let now = now_ms() as i64;
    let ttl_secs = state.config.session_ttl_days as i64 * 86_400;
    if let Err(e) = db::insert_session(&state.db, &token_hash, user.id, now, now + ttl_secs * 1000).await
    {
        tracing::error!("insert_session failed: {e}");
        return err(StatusCode::INTERNAL_SERVER_ERROR, "Could not sign in");
    }
    (
        [(header::SET_COOKIE, session_cookie(&state.config, &raw, ttl_secs))],
        Json(json!({ "user": user_view(&user) })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Password hashing (argon2id, kept off the async workers)
// ---------------------------------------------------------------------------

fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Ok(Argon2::default().hash_password(password.as_bytes(), &salt)?.to_string())
}

fn verify_password(password: &str, phc: &str) -> bool {
    PasswordHash::new(phc)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// A real argon2id hash of an unguessable value, verified against when the
/// username doesn't exist — so "no such user" and "wrong password" take the
/// same time and the login error stays uniform in practice, not just in text.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password(&nanoid!(20)).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn valid_username(name: &str) -> bool {
    (3..=24).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBody {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
}

pub async fn register(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RegisterBody>,
) -> Response {
    if !state
        .auth_limiter
        .allow(&client_ip(&headers, peer.ip(), &state.config))
        .await
    {
        return too_many_requests();
    }
    if !state.config.registration_enabled {
        return err(StatusCode::FORBIDDEN, "Registration is disabled on this instance");
    }
    let username = body.username.trim().to_ascii_lowercase();
    if !valid_username(&username) {
        return err(
            StatusCode::BAD_REQUEST,
            "Username must be 3–24 characters: lowercase letters, digits, underscore",
        );
    }
    if body.password.chars().count() < 8 || body.password.len() > 128 {
        return err(StatusCode::BAD_REQUEST, "Password must be 8–128 characters");
    }
    let display_name = {
        let raw = body.display_name.as_deref().unwrap_or(&username);
        let clean = sanitize_text(raw, state.config.nickname_max_len);
        if clean.is_empty() {
            username.clone()
        } else {
            clean
        }
    };

    let password = body.password;
    let hash = match tokio::task::spawn_blocking(move || hash_password(&password)).await {
        Ok(Ok(h)) => h,
        _ => return err(StatusCode::INTERNAL_SERVER_ERROR, "Could not create account"),
    };

    match db::create_user(&state.db, &username, &display_name, &hash, now_ms() as i64).await {
        Ok(db::CreateUserOutcome::Created(id)) => {
            tracing::info!("account registered: {username}");
            let user = AuthedUser { id, username, display_name, color: None };
            start_session(&state, user, session_token(&headers)).await
        }
        Ok(db::CreateUserOutcome::UsernameTaken) => {
            err(StatusCode::CONFLICT, "That username is taken")
        }
        Err(e) => {
            tracing::error!("create_user failed: {e}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Could not create account")
        }
    }
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    if !state
        .auth_limiter
        .allow(&client_ip(&headers, peer.ip(), &state.config))
        .await
    {
        return too_many_requests();
    }
    let username = body.username.trim().to_ascii_lowercase();
    // Per-username throttle on top of the per-IP one, so a single account can't
    // be brute-forced from many IPs.
    //
    // The key is TRUNCATED first. valid_username is never applied on the login
    // path (an unknown user must still reach the dummy-hash branch, so we
    // cannot reject early), which left the limiter keyed by up to axum's
    // default 2 MB body limit — attacker-controlled, unbounded-length map keys
    // in a global HashMap on the request path.
    let limiter_key: String = username.chars().take(64).collect();
    if !state.login_limiter.allow(&limiter_key).await {
        return too_many_requests();
    }

    let row = match db::user_for_login(&state.db, &username).await {
        Ok(row) => row,
        Err(e) => {
            tracing::error!("user_for_login failed: {e}");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "Could not sign in");
        }
    };

    let password = body.password;
    let (user, phc) = match row {
        Some(r) => (Some(r.user), r.password_hash),
        None => (None, dummy_hash().to_string()),
    };
    let ok = matches!(
        tokio::task::spawn_blocking(move || verify_password(&password, &phc)).await,
        Ok(true)
    );
    match user {
        Some(user) if ok => start_session(&state, user, session_token(&headers)).await,
        _ => err(StatusCode::UNAUTHORIZED, "Invalid username or password"),
    }
}

pub async fn logout(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if let Some(raw) = session_token(&headers) {
        if let Err(e) = db::delete_session(&state.db, &hash_token(&raw)).await {
            tracing::warn!("delete_session failed: {e}");
        }
    }
    (
        [(header::SET_COOKIE, session_cookie(&state.config, "", 0))],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

pub async fn me(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    match authed_user(&state, &headers).await {
        Some(u) => Json(json!({ "user": user_view(&u) })).into_response(),
        None => Json(json!({ "user": null })).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/// Periodically drop expired session rows so the table can't grow unbounded.
pub fn spawn_session_purge(state: SharedState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
            match db::purge_expired_sessions(&state.db, now_ms() as i64).await {
                Ok(n) if n > 0 => tracing::info!("purged {n} expired sessions"),
                Ok(_) => {}
                Err(e) => tracing::warn!("session purge failed: {e}"),
            }
        }
    });
}
