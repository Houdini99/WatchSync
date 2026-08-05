//! SQLite persistence for the optional account layer: users, sessions, and the
//! registry of claimed room slugs. Room *state* stays in memory (`state.rs`);
//! the pool is touched only at auth/join/registry time, never in the per-frame
//! intent path. One file (`DATABASE_PATH`), WAL mode, embedded migrations.

use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};

/// A logged-in user as resolved from a session cookie.
#[derive(Clone, Debug)]
pub struct AuthedUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub color: Option<String>,
}

/// Open (creating if missing) the database and run embedded migrations.
pub async fn init(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

fn user_from_row(row: &sqlx::sqlite::SqliteRow) -> AuthedUser {
    AuthedUser {
        id: row.get("id"),
        username: row.get("username"),
        display_name: row.get("display_name"),
        color: row.get("color"),
    }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

pub enum CreateUserOutcome {
    Created(i64),
    UsernameTaken,
}

pub async fn create_user(
    pool: &SqlitePool,
    username: &str,
    display_name: &str,
    password_hash: &str,
    now: i64,
) -> sqlx::Result<CreateUserOutcome> {
    let res = sqlx::query(
        "INSERT INTO users (username, display_name, password_hash, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(username)
    .bind(display_name)
    .bind(password_hash)
    .bind(now)
    .execute(pool)
    .await;
    match res {
        Ok(r) => Ok(CreateUserOutcome::Created(r.last_insert_rowid())),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            Ok(CreateUserOutcome::UsernameTaken)
        }
        Err(e) => Err(e),
    }
}

pub struct LoginRow {
    pub user: AuthedUser,
    pub password_hash: String,
}

pub async fn user_for_login(pool: &SqlitePool, username: &str) -> sqlx::Result<Option<LoginRow>> {
    let row = sqlx::query(
        "SELECT id, username, display_name, color, password_hash FROM users WHERE username = ?1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| LoginRow {
        user: user_from_row(&r),
        password_hash: r.get("password_hash"),
    }))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

pub async fn insert_session(
    pool: &SqlitePool,
    token_hash: &str,
    user_id: i64,
    now: i64,
    expires_at: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used) \
         VALUES (?1, ?2, ?3, ?4, ?3)",
    )
    .bind(token_hash)
    .bind(user_id)
    .bind(now)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Resolve a session token hash to its user, if the session is still live.
pub async fn session_user(
    pool: &SqlitePool,
    token_hash: &str,
    now: i64,
) -> sqlx::Result<Option<AuthedUser>> {
    let row = sqlx::query(
        "SELECT u.id, u.username, u.display_name, u.color \
         FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = ?1 AND s.expires_at > ?2",
    )
    .bind(token_hash)
    .bind(now)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| user_from_row(&r)))
}

/// Sliding expiry: push `expires_at` out to `now + ttl_ms`, but only when the
/// session hasn't been refreshed within `min_age_ms` (so the row isn't
/// rewritten on every request).
pub async fn refresh_session(
    pool: &SqlitePool,
    token_hash: &str,
    now: i64,
    ttl_ms: i64,
    min_age_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE sessions SET last_used = ?2, expires_at = ?3 \
         WHERE token_hash = ?1 AND last_used < ?4",
    )
    .bind(token_hash)
    .bind(now)
    .bind(now + ttl_ms)
    .bind(now - min_age_ms)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_session(pool: &SqlitePool, token_hash: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?1")
        .bind(token_hash)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn purge_expired_sessions(pool: &SqlitePool, now: i64) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM sessions WHERE expires_at <= ?1")
        .bind(now)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

// ---------------------------------------------------------------------------
// Registered rooms
// ---------------------------------------------------------------------------

pub struct RegisteredRoom {
    pub slug: String,
    pub created_at: i64,
}

pub async fn slug_owner(pool: &SqlitePool, slug: &str) -> sqlx::Result<Option<i64>> {
    let row = sqlx::query("SELECT owner_id FROM registered_rooms WHERE slug = ?1")
        .bind(slug)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get("owner_id")))
}

pub async fn owner_rooms(pool: &SqlitePool, owner_id: i64) -> sqlx::Result<Vec<RegisteredRoom>> {
    let rows = sqlx::query(
        "SELECT slug, created_at FROM registered_rooms WHERE owner_id = ?1 ORDER BY created_at",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| RegisteredRoom {
            slug: r.get("slug"),
            created_at: r.get("created_at"),
        })
        .collect())
}

pub async fn owner_room_count(pool: &SqlitePool, owner_id: i64) -> sqlx::Result<i64> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM registered_rooms WHERE owner_id = ?1")
        .bind(owner_id)
        .fetch_one(pool)
        .await?;
    Ok(row.get("n"))
}

pub enum ClaimOutcome {
    Claimed,
    Taken,
}

pub async fn claim_slug(
    pool: &SqlitePool,
    slug: &str,
    owner_id: i64,
    now: i64,
) -> sqlx::Result<ClaimOutcome> {
    let res = sqlx::query("INSERT INTO registered_rooms (slug, owner_id, created_at) VALUES (?1, ?2, ?3)")
        .bind(slug)
        .bind(owner_id)
        .bind(now)
        .execute(pool)
        .await;
    match res {
        Ok(_) => Ok(ClaimOutcome::Claimed),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Ok(ClaimOutcome::Taken),
        Err(e) => Err(e),
    }
}

/// Remove a registration; `true` when a row owned by `owner_id` was deleted.
pub async fn release_slug(pool: &SqlitePool, slug: &str, owner_id: i64) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM registered_rooms WHERE slug = ?1 AND owner_id = ?2")
        .bind(slug)
        .bind(owner_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}
