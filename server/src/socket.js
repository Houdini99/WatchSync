import { sanitizeNickname, sanitizeChat, sanitizeUrl, sanitizeClientId, sanitizeReaction } from './sanitize.js';
import { TokenBucket } from './rateLimiter.js';
import { detectMedia, enrichMedia } from './media.js';
import { config } from './config.js';

export function attachSockets(io, rooms) {
  // Per-socket rate limiters and bookkeeping live keyed by the socket object.
  const meta = new WeakMap();
  const reapTimers = new Map();
  // Pending "user left" timers, keyed `${roomId}:${clientId}`, so a quick
  // reconnect cancels the announcement and host migration.
  const leaveTimers = new Map();

  const leaveKey = (roomId, clientId) => `${roomId}:${clientId}`;

  function scheduleReap(roomId) {
    if (reapTimers.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room?.persistent) return;
    const t = setTimeout(() => {
      reapTimers.delete(roomId);
      const r = rooms.get(roomId);
      if (r && rooms.liveUserCount(r) === 0 && !r.persistent) rooms.delete(roomId);
    }, config.emptyRoomTtlMs);
    if (t.unref) t.unref();
    reapTimers.set(roomId, t);
  }

  function cancelReap(roomId) {
    const t = reapTimers.get(roomId);
    if (t) { clearTimeout(t); reapTimers.delete(roomId); }
  }

  function broadcastState(room, causedBy = null) {
    const snap = rooms.snapshot(room);
    snap.causedBy = causedBy;
    io.to(room.id).emit('room_state', snap);
  }

  function systemMessage(room, text) {
    const entry = { kind: 'system', text, ts: Date.now() };
    rooms.pushChat(room, entry);
    io.to(room.id).emit('system_message', { text: entry.text, ts: entry.ts });
  }

  setInterval(() => {
    for (const room of rooms.rooms.values()) {
      if (rooms.liveUserCount(room) === 0 || !room.video.media) continue;
      io.to(room.id).emit('heartbeat', {
        currentTime: rooms.computeLiveTime(room),
        paused: room.video.paused,
        rate: room.video.rate || 1,
        serverTime: Date.now(),
      });
    }
  }, config.heartbeatMs).unref?.();

  io.on('connection', (socket) => {
    meta.set(socket, {
      chat: new TokenBucket(config.chatBucket.capacity, config.chatBucket.refillPerSec),
      reaction: new TokenBucket(config.reactionBucket.capacity, config.reactionBucket.refillPerSec),
      global: new TokenBucket(config.globalBucket.capacity, config.globalBucket.refillPerSec),
      roomId: null,
      clientId: null,
    });

    // Cheap flood guard applied to the chatty real-time events.
    function allow() {
      const m = meta.get(socket);
      return m ? m.global.take(1) : false;
    }

    socket.on('join_room', (payload, ack) => {
      const roomId = String(payload?.roomId || '').trim();
      const nickname = sanitizeNickname(payload?.nickname);
      const clientId = sanitizeClientId(payload?.clientId) || `s_${socket.id}`;
      const hostToken = String(payload?.hostToken || '');
      const room = rooms.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'Room not found' });

      const m = meta.get(socket);
      const already = room.users.get(clientId);
      // Block only genuinely new seats once full; reconnects always get back in.
      if (!already && rooms.liveUserCount(room) >= config.maxUsersPerRoom) {
        return ack?.({ ok: false, error: 'Room is full' });
      }

      socket.join(roomId);
      m.roomId = roomId;
      m.clientId = clientId;
      cancelReap(roomId);

      // A pending "left" announcement means this is a reconnect within grace.
      const pending = leaveTimers.get(leaveKey(roomId, clientId));
      if (pending) { clearTimeout(pending); leaveTimers.delete(leaveKey(roomId, clientId)); }

      const { user, reconnected } = rooms.addUser(room, clientId, socket.id, nickname);

      if (!room.hostClientId || rooms.isHostToken(room, hostToken)) {
        rooms.setHost(room, clientId);
      }

      if (!reconnected) systemMessage(room, `${user.nickname} joined`);
      broadcastState(room, socket.id);

      ack?.({
        ok: true,
        youAreHost: room.hostClientId === clientId,
        clientId,
        snapshot: rooms.snapshot(room),
        chatHistory: room.chatHistory.slice(-config.chatHistoryLimit),
        config: { allowedRates: config.allowedRates, maxQueueLength: config.maxQueueLength },
      });
    });

    socket.on('change_video', (payload, ack) => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return ack?.({ ok: false, error: 'Locked' });
      const url = sanitizeUrl(payload?.url);
      if (!url) return ack?.({ ok: false, error: 'Invalid URL' });
      const media = detectMedia(url);
      if (!media) return ack?.({ ok: false, error: 'Unsupported media' });
      rooms.setMedia(room, media);
      systemMessage(room, `${nickOf(room)} changed the video`);
      broadcastState(room, socket.id);
      ack?.({ ok: true });
      enrichMedia(media).then((changed) => {
        if (changed && room.video.media === media) broadcastState(room, null);
      }).catch(() => {});
    });

    socket.on('play_pause', (payload) => {
      const room = currentRoom();
      if (!room || !room.video.media || !allow()) return;
      if (!isHost(room) && room.locked) return;
      rooms.updateVideoState(room, {
        paused: !!payload?.paused,
        currentTime: Number(payload?.currentTime),
      });
      broadcastState(room, socket.id);
    });

    socket.on('seek', (payload) => {
      const room = currentRoom();
      if (!room || !room.video.media || !allow()) return;
      if (!isHost(room) && room.locked) return;
      rooms.updateVideoState(room, {
        currentTime: Number(payload?.currentTime),
        paused: room.video.paused,
      });
      broadcastState(room, socket.id);
    });

    socket.on('set_rate', (payload) => {
      const room = currentRoom();
      if (!room || !room.video.media) return;
      if (!isHost(room) && room.locked) return;
      if (rooms.setRate(room, payload?.rate)) {
        systemMessage(room, `${nickOf(room)} set speed to ${room.video.rate}×`);
        broadcastState(room, socket.id);
      }
    });

    socket.on('buffering_start', () => {
      const room = currentRoom();
      if (!room || !room.video.media || !allow()) return;
      const r = rooms.setBuffering(room, meta.get(socket)?.clientId, true);
      if (r.changed) broadcastState(room, socket.id);
    });

    socket.on('buffering_end', () => {
      const room = currentRoom();
      if (!room || !room.video.media || !allow()) return;
      const r = rooms.setBuffering(room, meta.get(socket)?.clientId, false);
      if (r.changed) broadcastState(room, socket.id);
    });

    socket.on('queue_add', (payload, ack) => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return ack?.({ ok: false, error: 'Locked' });
      const url = sanitizeUrl(payload?.url);
      if (!url) return ack?.({ ok: false, error: 'Invalid URL' });
      const media = detectMedia(url);
      if (!media) return ack?.({ ok: false, error: 'Unsupported media' });
      if (!rooms.enqueue(room, media)) return ack?.({ ok: false, error: 'Queue is full' });
      broadcastState(room, socket.id);
      ack?.({ ok: true });
      enrichMedia(media).then((changed) => {
        if (!changed) return;
        if (room.queue.includes(media) || room.video.media === media) broadcastState(room, null);
      }).catch(() => {});
    });

    socket.on('queue_remove', (payload) => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return;
      if (rooms.dequeueAt(room, Number(payload?.index)) !== null) broadcastState(room, socket.id);
    });

    socket.on('queue_move', (payload) => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return;
      if (rooms.moveQueueItem(room, Number(payload?.from), Number(payload?.to))) {
        broadcastState(room, socket.id);
      }
    });

    socket.on('queue_skip', () => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return;
      const next = rooms.shiftQueue(room);
      if (next) {
        rooms.setMedia(room, next);
        systemMessage(room, `${nickOf(room)} skipped to the next video`);
        broadcastState(room, socket.id);
        enrichMedia(next).then((changed) => {
          if (changed && room.video.media === next) broadcastState(room, null);
        }).catch(() => {});
      } else {
        rooms.clearMedia(room);
        systemMessage(room, `${nickOf(room)} skipped — queue empty`);
        broadcastState(room, socket.id);
      }
    });

    socket.on('lock_room', (payload) => {
      const room = currentRoom();
      if (!room || !isHost(room)) return;
      room.locked = !!payload?.locked;
      systemMessage(room, `Host ${room.locked ? 'locked' : 'unlocked'} controls`);
      broadcastState(room, socket.id);
    });

    socket.on('set_persistent', (payload) => {
      const room = currentRoom();
      if (!room || !isHost(room)) return;
      rooms.setPersistent(room, !!payload?.persistent);
      if (room.persistent) cancelReap(room.id);
      systemMessage(room, `Room is now ${room.persistent ? 'persistent' : 'ephemeral'}`);
      broadcastState(room, socket.id);
    });

    socket.on('media_title', (payload) => {
      const room = currentRoom();
      if (!room || !room.video.media) return;
      const before = room.video.media.title;
      rooms.updateMediaTitle(room, payload?.title);
      if (room.video.media.title !== before) broadcastState(room, socket.id);
    });

    socket.on('chat_message', (payload) => {
      const room = currentRoom();
      if (!room) return;
      const m = meta.get(socket);
      if (!m || !m.chat.take(1)) return;
      const text = sanitizeChat(payload?.text);
      if (!text) return;
      const user = room.users.get(m.clientId);
      const entry = {
        kind: 'chat',
        nickname: user?.nickname || 'guest',
        color: user?.color || null,
        text,
        clientId: m.clientId,
        ts: Date.now(),
      };
      rooms.pushChat(room, entry);
      io.to(room.id).emit('chat_message', {
        nickname: entry.nickname,
        color: entry.color,
        text: entry.text,
        clientId: entry.clientId,
        socketId: socket.id,
        ts: entry.ts,
      });
    });

    socket.on('reaction', (payload) => {
      const room = currentRoom();
      if (!room) return;
      const m = meta.get(socket);
      if (!m || !m.reaction.take(1)) return;
      const emoji = sanitizeReaction(payload?.emoji);
      if (!emoji) return;
      const user = room.users.get(m.clientId);
      io.to(room.id).emit('reaction', {
        emoji,
        nickname: user?.nickname || 'guest',
        color: user?.color || null,
        clientId: m.clientId,
        ts: Date.now(),
      });
    });

    socket.on('typing', (payload) => {
      const room = currentRoom();
      if (!room || !allow()) return;
      const m = meta.get(socket);
      const user = room.users.get(m?.clientId);
      if (!user) return;
      socket.to(room.id).emit('typing', {
        clientId: user.clientId,
        nickname: user.nickname,
        typing: !!payload?.typing,
      });
    });

    socket.on('sync_request', (ack) => {
      const room = currentRoom();
      if (!room) return ack?.(null);
      ack?.(rooms.snapshot(room));
    });

    socket.on('ping_time', (payload, ack) => {
      ack?.({ clientTime: payload?.clientTime, serverTime: Date.now() });
    });

    socket.on('disconnect', () => {
      const m = meta.get(socket);
      meta.delete(socket);
      if (!m?.roomId || !m.clientId) return;
      const room = rooms.get(m.roomId);
      if (!room) return;
      const user = room.users.get(m.clientId);
      // Stale socket from a same-clientId takeover (newer tab won the seat).
      if (!user || user.socketId !== socket.id) return;

      rooms.markDisconnected(room, m.clientId);
      broadcastState(room, null); // others immediately see the seat grey out

      const key = leaveKey(m.roomId, m.clientId);
      if (leaveTimers.has(key)) return;
      const timer = setTimeout(() => {
        leaveTimers.delete(key);
        const r = rooms.get(m.roomId);
        if (!r) return;
        const u = r.users.get(m.clientId);
        if (!u || !u.disconnected) return; // reconnected in the meantime

        const wasHost = r.hostClientId === m.clientId;
        rooms.removeUser(r, m.clientId);
        systemMessage(r, `${u.nickname} left`);
        if (wasHost) {
          const next = rooms.migrateHost(r);
          if (next) systemMessage(r, `${next.nickname} is now the host`);
        }
        rooms.reconcileAutoPause(r);

        if (rooms.liveUserCount(r) === 0) scheduleReap(m.roomId);
        else broadcastState(r, null);
      }, config.reconnectGraceMs);
      if (timer.unref) timer.unref();
      leaveTimers.set(key, timer);
    });

    function currentRoom() {
      const m = meta.get(socket);
      return m?.roomId ? rooms.get(m.roomId) : null;
    }
    function isHost(room) { return room.hostClientId === meta.get(socket)?.clientId; }
    function nickOf(room) {
      return room.users.get(meta.get(socket)?.clientId)?.nickname || 'someone';
    }
  });
}
