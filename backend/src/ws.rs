//! WebSocket connection handling: the per-connection receive loop, intent
//! dispatch, background heartbeat, and the disconnect/grace/reap lifecycle.
//!
//! Each connection gets its own outbound mpsc channel (a dedicated task drains
//! it to the socket). On join, a clone of that sender is registered in the
//! room's `connections` map so any handler can broadcast by iterating senders.
//! The originating connection id rides along in `caused_by` so a client can
//! ignore the echo of its own action.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, sleep, timeout};

use crate::config::{Config, CorsOrigin};
use crate::db::{self, AuthedUser};
use crate::media::detect_media;
use crate::protocol::{AccountView, ClientMsg, Media, ServerMsg};
use crate::rate_limit::TokenBucket;
use crate::sanitize::{
    sanitize_chat, sanitize_client_id, sanitize_nickname, sanitize_reaction, sanitize_text,
    sanitize_url,
};
use crate::state::{now_ms, AppState, BufferOutcome, ChatEntry, ConnHandle};

pub type SharedState = Arc<AppState>;

/// Axum handler for `GET /ws` — upgrades to a WebSocket connection.
///
/// Browsers do not apply CORS to WebSockets, so when an explicit origin
/// allow-list is configured (CORS_ORIGIN=https://…) enforce it on the upgrade
/// too — otherwise any third-party page could open the socket. Requests with
/// no Origin header (non-browser clients, same-machine tools) pass through.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Response {
    if let CorsOrigin::List(allowed) = &state.config.cors_origin {
        if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
            let ok = allowed
                .iter()
                .any(|a| a.trim().trim_end_matches('/').to_ascii_lowercase() == origin);
            if !ok {
                return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
            }
        }
    }
    // Same-origin cookies ride the upgrade request, so the session (if any) is
    // resolved once here and pinned to the connection. Guests get `None`.
    let user = crate::auth::authed_user(&state, &headers).await;
    ws.on_upgrade(move |socket| connection(socket, state, user))
}

/// Per-connection mutable state + behaviour.
struct Conn {
    state: SharedState,
    conn_id: String,
    out: mpsc::UnboundedSender<Message>,
    /// Taken and handed to the room on join, so a host kick/ban can force-close
    /// this connection. `None` once handed over (or if never joined).
    kill_tx: Option<oneshot::Sender<()>>,
    room_id: Option<String>,
    client_id: Option<String>,
    /// The signed-in account behind this socket, resolved from the session
    /// cookie at upgrade time. `None` for guests. Grants owner-host in
    /// registered rooms and defaults the nickname.
    user: Option<AuthedUser>,
    chat_bucket: TokenBucket,
    reaction_bucket: TokenBucket,
    global_bucket: TokenBucket,
    heavy_bucket: TokenBucket,
}

impl Conn {
    fn cfg(&self) -> &Config {
        &self.state.config
    }

    fn send(&self, msg: ServerMsg) {
        let _ = self.out.send(Message::Text(msg.to_json()));
    }

    /// Cheap flood guard for the chatty real-time events.
    fn allow(&mut self) -> bool {
        self.global_bucket.take(1.0)
    }

    /// Guard for expensive intents (change_video, queue_add): each spawns ffmpeg
    /// or calls the resolver, so they get a tighter, separate bucket.
    fn allow_heavy(&mut self) -> bool {
        self.heavy_bucket.take(1.0)
    }
}

async fn connection(socket: WebSocket, state: SharedState, user: Option<AuthedUser>) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    // Dedicated outbound pump: everything this connection sends goes through here.
    let send_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // WebSocket-level keepalive. The browser auto-replies with a Pong, so this
    // keeps the connection from being idle-reaped by intermediaries (reverse
    // proxies, load balancers) even when a room has no media and thus no
    // heartbeat traffic.
    let keepalive_tx = out_tx.clone();
    let keepalive = tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(20));
        tick.tick().await; // consume the immediate first tick
        loop {
            tick.tick().await;
            if keepalive_tx.send(Message::Ping(Vec::new())).is_err() {
                break;
            }
        }
    });

    let conn_id = uuid::Uuid::new_v4().to_string();
    // Force-close channel: a host kick/ban fires `kill_tx` (handed to the room on
    // join) and this connection's read loop stops.
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
    let cfg = &state.config;
    let mut conn = Conn {
        state: state.clone(),
        conn_id: conn_id.clone(),
        out: out_tx.clone(),
        kill_tx: Some(kill_tx),
        room_id: None,
        client_id: None,
        user,
        chat_bucket: TokenBucket::new(cfg.chat_bucket.capacity, cfg.chat_bucket.refill_per_sec),
        reaction_bucket: TokenBucket::new(
            cfg.reaction_bucket.capacity,
            cfg.reaction_bucket.refill_per_sec,
        ),
        global_bucket: TokenBucket::new(
            cfg.global_bucket.capacity,
            cfg.global_bucket.refill_per_sec,
        ),
        heavy_bucket: TokenBucket::new(cfg.heavy_bucket.capacity, cfg.heavy_bucket.refill_per_sec),
    };

    // Hand the client its connection id up front.
    conn.send(ServerMsg::Welcome {
        conn_id: conn_id.clone(),
    });

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    Message::Text(text) => {
                        if let Ok(parsed) = serde_json::from_str::<ClientMsg>(&text) {
                            conn.handle(parsed).await;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            // Kicked/banned by the host: tell the client to close, then stop
            // reading. The Kicked frame was already queued by the moderator.
            _ = &mut kill_rx => {
                let _ = conn.out.send(Message::Close(None));
                break;
            }
        }
    }

    conn.cleanup().await;
    keepalive.abort();
    // Drop every outbound sender so the pump drains its queue (any pending
    // Kicked/Close frames) and then exits on its own; bound the wait so a stuck
    // client socket can't hold the task open.
    drop(conn);
    drop(out_tx);
    let _ = keepalive.await;
    let _ = timeout(Duration::from_secs(2), send_task).await;
}

impl Conn {
    async fn handle(&mut self, msg: ClientMsg) {
        match msg {
            ClientMsg::JoinRoom {
                room_id,
                nickname,
                client_id,
                host_token,
                seat_token,
            } => {
                self.on_join(room_id, nickname, client_id, host_token, seat_token)
                    .await
            }
            ClientMsg::ChangeVideo {
                url,
                title,
                is_live,
            } => self.on_change_video(url, title, is_live).await,
            ClientMsg::PlayPause {
                paused,
                current_time,
            } => self.on_play_pause(paused, current_time).await,
            ClientMsg::Seek { current_time } => self.on_seek(current_time).await,
            ClientMsg::SetRate { rate } => self.on_set_rate(rate).await,
            ClientMsg::BufferingStart => self.on_buffering(true).await,
            ClientMsg::BufferingEnd => self.on_buffering(false).await,
            ClientMsg::QueueAdd {
                url,
                title,
                is_live,
            } => self.on_queue_add(url, title, is_live).await,
            ClientMsg::QueueRemove { index } => self.on_queue_remove(index).await,
            ClientMsg::QueueMove { from, to } => self.on_queue_move(from, to).await,
            ClientMsg::QueueSkip { ended_media } => self.on_queue_skip(ended_media).await,
            ClientMsg::KickUser { client_id } => self.on_moderate(client_id, false).await,
            ClientMsg::BanUser { client_id } => self.on_moderate(client_id, true).await,
            ClientMsg::LockRoom { locked } => self.on_lock_room(locked).await,
            ClientMsg::SetPersistent { persistent } => self.on_set_persistent(persistent).await,
            ClientMsg::MediaTitle { title } => self.on_media_title(title).await,
            ClientMsg::ChatMessage { text } => self.on_chat(text).await,
            ClientMsg::Reaction { emoji } => self.on_reaction(emoji).await,
            ClientMsg::Typing { typing } => self.on_typing(typing).await,
            ClientMsg::SyncRequest => self.on_sync_request().await,
            ClientMsg::Ping { client_time } => self.send(ServerMsg::Pong {
                client_time,
                server_time: now_ms(),
            }),
        }
    }

    async fn on_join(
        &mut self,
        room_id: String,
        nickname: Option<String>,
        client_id: Option<String>,
        host_token: Option<String>,
        seat_token: Option<String>,
    ) {
        let room_id = room_id.trim().to_string();
        // Signed-in joiners with no explicit nickname get their account display
        // name — decided before sanitizing, which turns empty into "guest".
        let raw_nick = {
            let sent = nickname.unwrap_or_default();
            match (&self.user, sent.trim().is_empty()) {
                (Some(u), true) => u.display_name.clone(),
                _ => sent,
            }
        };
        let nickname = sanitize_nickname(&raw_nick, self.cfg().nickname_max_len);
        let requested_id = sanitize_client_id(&client_id.unwrap_or_default())
            .unwrap_or_else(|| format!("c-{}", self.conn_id));
        let host_token = host_token.unwrap_or_default();
        let seat_token = seat_token.unwrap_or_default();
        let history_limit = self.cfg().chat_history_limit;
        let max_users = self.cfg().max_users_per_room;

        // Registered slug? One indexed lookup per join (before the lock), so a
        // cold registered room can materialize on demand under its permanent
        // URL. The map is re-checked under the write lock — two concurrent
        // joiners hydrate exactly once.
        let registered_owner = db::slug_owner(&self.state.db, &room_id).await.ok().flatten();

        let mut rooms = self.state.rooms.write().await;
        if !rooms.contains_key(&room_id) {
            if let Some(owner_id) = registered_owner {
                // Hydration skips the MAX_ROOMS eviction dance (create_room
                // enforces the cap on its own path); briefly exceeding the cap
                // is harmless and the empty-room reaper restores it.
                rooms.insert(
                    room_id.clone(),
                    crate::state::Room::new_registered(room_id.clone(), owner_id),
                );
                tracing::info!("registered room hydrated: {room_id}");
            }
        }
        let Some(room) = rooms.get_mut(&room_id) else {
            self.send(ServerMsg::JoinError {
                error: "Room not found".to_string(),
            });
            return;
        };

        if room.is_banned(&requested_id) {
            self.send(ServerMsg::JoinError {
                error: "You have been removed from this room".to_string(),
            });
            return;
        }

        // A reclaim (existing seat + matching secret) always gets back in; a new
        // seat is blocked once the room is full.
        let is_reclaim = room.is_seat_owner(&requested_id, &seat_token);
        if !is_reclaim && room.live_user_count() >= max_users {
            self.send(ServerMsg::JoinError {
                error: "Room is full".to_string(),
            });
            return;
        }

        let (client_id, reconnected) =
            room.claim_seat(&requested_id, &seat_token, &self.conn_id, nickname);
        let seat_token_out = room.seat_token_of(&client_id);

        room.connections.insert(
            self.conn_id.clone(),
            ConnHandle {
                out: self.out.clone(),
                kill: self.kill_tx.take(),
            },
        );
        self.room_id = Some(room_id.clone());
        self.client_id = Some(client_id.clone());

        // Host status is granted by the room's secret host_token, by being the
        // first user in, or — in registered rooms — by being the signed-in
        // owner, who reclaims host on every join even if it migrated away.
        // Never by simply claiming a client_id (which is public).
        let is_owner = matches!(
            (&self.user, room.owner_id),
            (Some(u), Some(owner)) if u.id == owner
        );
        if is_owner || room.host_client_id.is_none() || room.is_host_token(&host_token) {
            room.set_host(&client_id);
        }

        if !reconnected {
            let nick = room
                .users
                .get(&client_id)
                .map(|u| u.nickname.clone())
                .unwrap_or_else(|| "someone".to_string());
            room.system_message(format!("{nick} joined"), history_limit);
        }
        room.broadcast_state(Some(self.conn_id.clone()));

        self.send(ServerMsg::Joined {
            you_are_host: room.is_host(&client_id),
            client_id,
            seat_token: seat_token_out,
            snapshot: room.snapshot(),
            chat_history: room.chat_history_view(history_limit),
            config: self.state.join_config(),
            account: self.user.as_ref().map(|u| AccountView {
                username: u.username.clone(),
                display_name: u.display_name.clone(),
                color: u.color.clone(),
            }),
        });
    }

    async fn on_change_video(&mut self, url: String, title: Option<String>, is_live: Option<bool>) {
        if !self.allow_heavy() {
            return self.send(err("You're changing the video too fast — slow down"));
        }
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let history_limit = self.cfg().chat_history_limit;

        let mut media = {
            let url = match sanitize_url(&url, self.cfg().url_max_len) {
                Some(u) => u,
                None => return self.send(err("Invalid URL")),
            };
            let cache = self.state.title_cache.lock().await;
            match detect_media(&url, &cache) {
                Some(m) => m,
                None => return self.send(err("Unsupported media")),
            }
        };
        apply_title(&mut media, title);
        apply_is_live(&mut media, is_live);

        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if !room.is_host(&client_id) && room.locked {
            return self.send(err("Locked"));
        }
        let nick = nick_of(room, &client_id);
        let proxy = install_media(&self.state, room, media.clone());
        room.system_message(format!("{nick} changed the video"), history_limit);
        room.broadcast_state(Some(self.conn_id.clone()));
        drop(rooms);
        match proxy {
            // Non-YouTube → (re)spawn the server-side HLS stream.
            Some((generation, offset, m)) => {
                start_proxy_stream(self.state.clone(), room_id.clone(), m, generation, offset)
            }
            // YouTube → IFrame path; tear down any ffmpeg/RAM-disk state.
            None => self.state.streams.stop(&room_id).await,
        }
        self.spawn_enrich(room_id, media);
    }

    async fn on_play_pause(&mut self, paused: bool, current_time: Option<f64>) {
        if !self.allow() {
            return;
        }
        self.with_room_unlocked(|room, conn_id| {
            if room.video.media.is_none() {
                return;
            }
            room.update_video_state(Some(paused), current_time);
            room.broadcast_state(Some(conn_id));
        })
        .await;
    }

    async fn on_seek(&mut self, current_time: f64) {
        if !self.allow() {
            return;
        }
        if !(current_time.is_finite() && current_time >= 0.0) {
            return;
        }
        // Proxied media is muxed from the start as a growing VOD, so a seek is
        // purely a position update: the server moves `current_time` and every
        // client seeks its own local HLS player to match (drift-correction). We
        // never respawn ffmpeg on a seek — that would wipe the playlist and
        // black-reload the stream for the entire room on every scrub.
        self.with_room_unlocked(|room, conn_id| {
            if room.video.media.is_none() {
                return;
            }
            let paused = room.video.paused;
            room.update_video_state(Some(paused), Some(current_time));
            room.broadcast_state(Some(conn_id));
        })
        .await;
    }

    async fn on_set_rate(&mut self, rate: f64) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let history_limit = self.cfg().chat_history_limit;
        let allowed = self.cfg().allowed_rates.clone();
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if room.video.media.is_none() || (!room.is_host(&client_id) && room.locked) {
            return;
        }
        if room.set_rate(rate, &allowed) {
            let nick = nick_of(room, &client_id);
            let r = room.video.rate;
            room.system_message(format!("{nick} set speed to {r}×"), history_limit);
            room.broadcast_state(Some(self.conn_id.clone()));
        }
    }

    async fn on_buffering(&mut self, buffering: bool) {
        if !self.allow() {
            return;
        }
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if room.video.media.is_none() {
            return;
        }
        if let BufferOutcome::Changed = room.set_buffering(&client_id, buffering) {
            room.broadcast_state(Some(self.conn_id.clone()));
        }
    }

    async fn on_queue_add(&mut self, url: String, title: Option<String>, is_live: Option<bool>) {
        if !self.allow_heavy() {
            return self.send(err("You're adding to the queue too fast — slow down"));
        }
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let max_queue = self.cfg().max_queue_length;

        let mut media = {
            let url = match sanitize_url(&url, self.cfg().url_max_len) {
                Some(u) => u,
                None => return self.send(err("Invalid URL")),
            };
            let cache = self.state.title_cache.lock().await;
            match detect_media(&url, &cache) {
                Some(m) => m,
                None => return self.send(err("Unsupported media")),
            }
        };
        apply_title(&mut media, title);
        apply_is_live(&mut media, is_live);

        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if !room.is_host(&client_id) && room.locked {
            return self.send(err("Locked"));
        }
        if !room.enqueue(media.clone(), max_queue) {
            return self.send(err("Queue is full"));
        }
        room.broadcast_state(Some(self.conn_id.clone()));
        drop(rooms);
        self.spawn_enrich(room_id, media);
    }

    async fn on_queue_remove(&mut self, index: i64) {
        self.with_room_unlocked(|room, conn_id| {
            if room.dequeue_at(index).is_some() {
                room.broadcast_state(Some(conn_id));
            }
        })
        .await;
    }

    async fn on_queue_move(&mut self, from: i64, to: i64) {
        self.with_room_unlocked(|room, conn_id| {
            if room.move_queue_item(from, to) {
                room.broadcast_state(Some(conn_id));
            }
        })
        .await;
    }

    async fn on_queue_skip(&mut self, ended_media: Option<String>) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let history_limit = self.cfg().chat_history_limit;
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if !room.is_host(&client_id) && room.locked {
            return;
        }
        // Auto-advance idempotency: an `ended`-driven skip names the media that
        // finished. If the room has already advanced past it (another viewer's
        // `ended` won the race), ignore this one — otherwise N viewers finishing
        // the same video would skip N items at once.
        if let Some(src) = &ended_media {
            let current = room.video.media.as_ref().map(|m| m.source.as_str());
            if current != Some(src.as_str()) {
                return;
            }
        }
        let nick = nick_of(room, &client_id);
        match room.shift_queue() {
            Some(next) => {
                let proxy = install_media(&self.state, room, next.clone());
                room.system_message(format!("{nick} skipped to the next video"), history_limit);
                room.broadcast_state(Some(self.conn_id.clone()));
                drop(rooms);
                match proxy {
                    Some((generation, offset, m)) => {
                        start_proxy_stream(self.state.clone(), room_id.clone(), m, generation, offset)
                    }
                    None => self.state.streams.stop(&room_id).await,
                }
                self.spawn_enrich(room_id, next);
            }
            None => {
                room.clear_media();
                room.system_message(format!("{nick} skipped — queue empty"), history_limit);
                room.broadcast_state(Some(self.conn_id.clone()));
                drop(rooms);
                self.state.streams.stop(&room_id).await;
            }
        }
    }

    async fn on_lock_room(&mut self, locked: bool) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let history_limit = self.cfg().chat_history_limit;
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if !room.is_host(&client_id) {
            return;
        }
        room.locked = locked;
        let word = if locked { "locked" } else { "unlocked" };
        room.system_message(format!("Host {word} controls"), history_limit);
        room.broadcast_state(Some(self.conn_id.clone()));
    }

    async fn on_set_persistent(&mut self, persistent: bool) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let history_limit = self.cfg().chat_history_limit;
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if !room.is_host(&client_id) {
            return;
        }
        room.set_persistent(persistent);
        let word = if persistent { "persistent" } else { "ephemeral" };
        room.system_message(format!("Room is now {word}"), history_limit);
        room.broadcast_state(Some(self.conn_id.clone()));
    }

    /// Host-only moderation: remove `target` (kick), optionally recording a ban
    /// that blocks their rejoin. The target's socket is notified then force-closed.
    async fn on_moderate(&mut self, target: String, ban: bool) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let target = match sanitize_client_id(&target) {
            Some(t) => t,
            None => return,
        };
        if target == client_id {
            return; // a host can't kick themselves
        }
        let history_limit = self.cfg().chat_history_limit;
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        if !room.is_host(&client_id) {
            return;
        }
        let Some(user) = room.users.get(&target) else { return };
        let nick = user.nickname.clone();
        let target_conn = user.conn_id.clone();

        // Notify then force-close the target's live connection (if any).
        let reason = if ban {
            "You were banned by the host"
        } else {
            "You were removed by the host"
        };
        if let Some(handle) = room.connections.get_mut(&target_conn) {
            let _ = handle
                .out
                .send(Message::Text(ServerMsg::Kicked { reason: reason.to_string() }.to_json()));
            if let Some(kill) = handle.kill.take() {
                let _ = kill.send(());
            }
        }

        if ban {
            room.ban(&target);
        }
        room.remove_user(&target);
        let word = if ban { "banned" } else { "removed" };
        room.system_message(format!("{nick} was {word} by the host"), history_limit);
        // A departing user may have been the only one buffering.
        room.reconcile_auto_pause();
        room.broadcast_state(None);
    }

    async fn on_media_title(&mut self, title: String) {
        // Same sanitation as every other client-echoed string, and the same
        // lock gate as the rest of the playback intents.
        let title = sanitize_text(&title, 200);
        if title.is_empty() {
            return;
        }
        self.with_room_unlocked(|room, conn_id| {
            if room.video.media.is_none() {
                return;
            }
            if room.update_media_title(&title) {
                room.broadcast_state(Some(conn_id));
            }
        })
        .await;
    }

    async fn on_chat(&mut self, text: String) {
        let Some(room_id) = self.room_id.clone() else { return };
        let Some(client_id) = self.client_id.clone() else { return };
        if !self.chat_bucket.take(1.0) {
            return;
        }
        let text = sanitize_chat(&text, self.cfg().chat_max_len);
        if text.is_empty() {
            return;
        }
        let history_limit = self.cfg().chat_history_limit;
        let ts = now_ms();
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        let (nickname, color) = match room.users.get(&client_id) {
            Some(u) => (u.nickname.clone(), Some(u.color.clone())),
            None => ("guest".to_string(), None),
        };
        room.push_chat(
            ChatEntry {
                kind: "chat",
                nickname: Some(nickname.clone()),
                color: color.clone(),
                text: text.clone(),
                client_id: Some(client_id.clone()),
                ts,
            },
            history_limit,
        );
        room.broadcast(&ServerMsg::ChatMessage {
            nickname,
            color,
            text,
            client_id,
            ts,
        });
    }

    async fn on_reaction(&mut self, emoji: String) {
        let Some(room_id) = self.room_id.clone() else { return };
        let Some(client_id) = self.client_id.clone() else { return };
        if !self.reaction_bucket.take(1.0) {
            return;
        }
        let Some(emoji) = sanitize_reaction(&emoji) else { return };
        let rooms = self.state.rooms.read().await;
        let Some(room) = rooms.get(&room_id) else { return };
        let (nickname, color) = match room.users.get(&client_id) {
            Some(u) => (u.nickname.clone(), Some(u.color.clone())),
            None => ("guest".to_string(), None),
        };
        room.broadcast(&ServerMsg::Reaction {
            emoji,
            nickname,
            color,
            client_id,
            ts: now_ms(),
        });
    }

    async fn on_typing(&mut self, typing: bool) {
        if !self.allow() {
            return;
        }
        let Some(room_id) = self.room_id.clone() else { return };
        let Some(client_id) = self.client_id.clone() else { return };
        let rooms = self.state.rooms.read().await;
        let Some(room) = rooms.get(&room_id) else { return };
        let Some(user) = room.users.get(&client_id) else { return };
        room.broadcast(&ServerMsg::Typing {
            client_id: user.client_id.clone(),
            nickname: user.nickname.clone(),
            typing,
        });
    }

    async fn on_sync_request(&mut self) {
        let Some(room_id) = self.room_id.clone() else { return };
        let rooms = self.state.rooms.read().await;
        if let Some(room) = rooms.get(&room_id) {
            self.send(ServerMsg::SyncSnapshot {
                snapshot: room.snapshot(),
            });
        }
    }

    /// Shared helper for intents gated by the room lock that mutate then
    /// broadcast. The closure runs with `&mut Room` and this connection's id.
    async fn with_room_unlocked<F: FnOnce(&mut crate::state::Room, String)>(&mut self, f: F) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        // Lock gate applies to all callers; media requirements (if any) are
        // checked inside the closure since they differ per intent.
        if !room.is_host(&client_id) && room.locked {
            return;
        }
        f(room, self.conn_id.clone());
    }

    /// Resolve a YouTube title in the background and rebroadcast when it lands.
    fn spawn_enrich(&self, room_id: String, media: Media) {
        if media.kind != "youtube" {
            return;
        }
        // Already has a real (non-placeholder) title.
        if !media.title.is_empty() && media.title != media.source {
            return;
        }
        let Some(id) = media.id.clone() else { return };
        let state = self.state.clone();
        let source = media.source.clone();
        tokio::spawn(async move {
            let cached = { state.title_cache.lock().await.get(&id) };
            let title = match cached {
                Some(t) => t,
                None => {
                    let Some(t) = crate::media::fetch_youtube_title(&state.http, &source).await
                    else {
                        return;
                    };
                    state.title_cache.lock().await.put(id.clone(), t.clone());
                    t
                }
            };

            let mut rooms = state.rooms.write().await;
            let Some(room) = rooms.get_mut(&room_id) else { return };
            let mut changed = false;
            if let Some(m) = room.video.media.as_mut() {
                if m.source == source && m.title != title {
                    m.title = title.clone();
                    changed = true;
                }
            }
            for item in room.queue.iter_mut() {
                if item.id.as_deref() == Some(id.as_str()) && item.title != title {
                    item.title = title.clone();
                    changed = true;
                }
            }
            if changed {
                room.broadcast_state(None);
            }
        });
    }

    /// Socket closed: free the connection, grey out the seat, and schedule the
    /// grace-window "left" announcement (which a quick reconnect cancels).
    async fn cleanup(&mut self) {
        let (Some(room_id), Some(client_id)) = (self.room_id.clone(), self.client_id.clone()) else {
            return;
        };
        let mut rooms = self.state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        room.connections.remove(&self.conn_id);

        // Stale socket from a same-client takeover (a newer tab won the seat).
        match room.users.get(&client_id) {
            Some(u) if u.conn_id == self.conn_id => {}
            _ => return,
        }

        room.mark_disconnected(&client_id);
        room.broadcast_state(None); // others immediately see the seat grey out
        drop(rooms);

        schedule_leave(self.state.clone(), room_id, client_id);
    }
}

fn err(msg: &str) -> ServerMsg {
    ServerMsg::ActionError {
        error: msg.to_string(),
    }
}

/// Override a media's title with a client-supplied one (e.g. a resolved title),
/// after sanitizing it.
fn apply_title(media: &mut Media, title: Option<String>) {
    if let Some(t) = title {
        let t = sanitize_text(&t, 200);
        if !t.is_empty() {
            media.title = t;
        }
    }
}

/// Flag media as live when the resolver reported a live stream. We only ever
/// promote to live (never clear an already-detected live flag).
fn apply_is_live(media: &mut Media, is_live: Option<bool>) {
    if is_live == Some(true) {
        media.is_live = true;
    }
}

fn nick_of(room: &crate::state::Room, client_id: &str) -> String {
    room.users
        .get(client_id)
        .map(|u| u.nickname.clone())
        .unwrap_or_else(|| "someone".to_string())
}

/// Make `media` the room's current video and, for non-YouTube media, arm a fresh
/// proxy-stream generation. Returns `Some((generation, offset, media))` for the
/// caller to (re)spawn ffmpeg once the rooms lock is released, or `None` for
/// YouTube (which the caller handles by stopping any running ffmpeg). Kept a
/// free fn so it borrows only `&mut Room`, not the whole `Conn`.
fn install_media(
    state: &AppState,
    room: &mut crate::state::Room,
    media: Media,
) -> Option<(u64, f64, Media)> {
    room.set_media(media.clone());
    if media.kind == "youtube" {
        room.clear_stream();
        None
    } else {
        let generation = state.streams.next_generation();
        // Always mux the whole source from its start as a growing VOD (offset 0).
        // Seeks are handled client-side, so ffmpeg is spawned once per media and
        // never respawned mid-playback. (A `?t=` deep-link start is applied as a
        // client-side seek via the room's initial `current_time`.)
        room.begin_stream(generation, 0.0);
        Some((generation, 0.0, media))
    }
}

/// Background: resolve a non-YouTube source (separate video+audio via the yt-dlp
/// resolver, or a direct URL) and (re)spawn its ffmpeg → HLS stream. The
/// `generation`/`offset` were already recorded on the room by `begin_stream`, so
/// a superseding change/seek makes this a no-op via the generation guard.
fn start_proxy_stream(
    state: SharedState,
    room_id: String,
    media: Media,
    generation: u64,
    offset: f64,
) {
    tokio::spawn(async move {
        match crate::stream::prepare_source(&state, &media).await {
            Ok(prepared) => {
                let live = prepared.is_live || media.is_live;
                // Fold the resolver's real title / live flag into the room before
                // the (slower) ffmpeg spawn — if we're still the current stream.
                if prepared.title.is_some() || prepared.is_live {
                    let mut rooms = state.rooms.write().await;
                    let Some(room) = rooms.get_mut(&room_id) else { return };
                    if room.stream_generation() != Some(generation) {
                        return; // superseded while resolving
                    }
                    let mut changed = false;
                    if let Some(t) = &prepared.title {
                        if room.update_media_title(t) {
                            changed = true;
                        }
                    }
                    if prepared.is_live && room.set_media_live() {
                        changed = true;
                    }
                    if changed {
                        room.broadcast_state(None);
                    }
                }
                state
                    .streams
                    .start(state.clone(), room_id, generation, offset, prepared.source, live)
                    .await;
            }
            Err(e) => {
                tracing::warn!("stream {room_id}: source prep failed: {e}");
                let mut rooms = state.rooms.write().await;
                if let Some(room) = rooms.get_mut(&room_id) {
                    if room.mark_stream_error(generation) {
                        room.broadcast_state(None);
                    }
                }
            }
        }
    });
}

/// After the grace window, if the user is still gone: announce "left", migrate
/// host if needed, reconcile auto-pause, and reap the room if it is now empty.
fn schedule_leave(state: SharedState, room_id: String, client_id: String) {
    let grace = Duration::from_millis(state.config.reconnect_grace_ms);
    let history_limit = state.config.chat_history_limit;
    tokio::spawn(async move {
        sleep(grace).await;
        let mut rooms = state.rooms.write().await;
        let Some(room) = rooms.get_mut(&room_id) else { return };
        match room.users.get(&client_id) {
            Some(u) if u.disconnected => {}
            _ => return, // reconnected (or already removed) in the meantime
        }

        let was_host = room.is_host(&client_id);
        let nick = nick_of(room, &client_id);
        room.remove_user(&client_id);
        room.system_message(format!("{nick} left"), history_limit);
        if was_host {
            if let Some(new_host) = room.migrate_host() {
                room.system_message(format!("{new_host} is now the host"), history_limit);
            }
        }
        room.reconcile_auto_pause();

        if room.live_user_count() == 0 {
            drop(rooms);
            schedule_reap(state, room_id);
        } else {
            room.broadcast_state(None);
        }
    });
}

/// Reap an empty, non-persistent room after the TTL, killing its ffmpeg and
/// wiping its RAM-disk directory.
fn schedule_reap(state: SharedState, room_id: String) {
    let ttl = Duration::from_millis(state.config.empty_room_ttl_ms);
    tokio::spawn(async move {
        sleep(ttl).await;
        let mut rooms = state.rooms.write().await;
        let reap =
            matches!(rooms.get(&room_id), Some(room) if room.live_user_count() == 0 && !room.persistent);
        if reap {
            rooms.remove(&room_id);
            drop(rooms);
            // Free the ffmpeg child + reclaim the RAM disk.
            state.streams.stop(&room_id).await;
        }
    });
}

/// Periodic drift-correction tick to every room that has live users and media.
pub fn spawn_heartbeat(state: SharedState) {
    let period = Duration::from_millis(state.config.heartbeat_ms);
    tokio::spawn(async move {
        let mut tick = interval(period);
        loop {
            tick.tick().await;
            let rooms = state.rooms.read().await;
            for room in rooms.values() {
                if room.live_user_count() == 0 || room.video.media.is_none() {
                    continue;
                }
                room.broadcast(&ServerMsg::Heartbeat {
                    current_time: room.compute_live_time(),
                    paused: room.video.paused,
                    rate: room.video.rate.max(0.0),
                    server_time: now_ms(),
                });
            }
        }
    });
}
