-- Accounts + persistent custom room registry. Room *state* stays in memory
-- (state.rs); these tables only hold identity that must survive restarts.

CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,          -- stored lowercase
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,                 -- argon2id PHC string
    color         TEXT,                          -- preferred chat color, optional
    created_at    INTEGER NOT NULL               -- unix ms
);

CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,                -- sha256(raw cookie token), hex
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    last_used   INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE registered_rooms (
    slug        TEXT PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
);
CREATE INDEX registered_rooms_owner ON registered_rooms(owner_id);
