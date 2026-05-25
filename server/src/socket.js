import { sanitizeNickname, sanitizeChat, sanitizeUrl } from './sanitize.js';
import { TokenBucket } from './rateLimiter.js';
import { detectMedia, enrichMedia } from './media.js';

const HEARTBEAT_MS = 4000;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;

export function attachSockets(io, rooms) {
  const buckets = new WeakMap();
  const reapTimers = new Map();

  function scheduleReap(roomId) {
    if (reapTimers.has(roomId)) return;
    const room = rooms.get(roomId);
    if (room?.persistent) return;
    const t = setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && r.users.size === 0 && !r.persistent) rooms.delete(roomId);
      reapTimers.delete(roomId);
    }, EMPTY_ROOM_TTL_MS);
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

  function systemMessage(roomId, text) {
    io.to(roomId).emit('system_message', { text, ts: Date.now() });
  }

  setInterval(() => {
    for (const room of rooms.rooms.values()) {
      if (room.users.size === 0 || !room.video.media) continue;
      io.to(room.id).emit('heartbeat', {
        currentTime: rooms.computeLiveTime(room),
        paused: room.video.paused,
        serverTime: Date.now(),
      });
    }
  }, HEARTBEAT_MS);

  io.on('connection', (socket) => {
    buckets.set(socket, new TokenBucket(5, 0.5));
    let joinedRoomId = null;

    socket.on('join_room', (payload, ack) => {
      const roomId = String(payload?.roomId || '').trim();
      const nickname = sanitizeNickname(payload?.nickname);
      const hostToken = String(payload?.hostToken || '');
      const room = rooms.get(roomId);
      if (!room) return ack?.({ ok: false, error: 'Room not found' });
      if (room.users.size >= 50) return ack?.({ ok: false, error: 'Room is full' });

      socket.join(roomId);
      joinedRoomId = roomId;
      cancelReap(roomId);
      rooms.addUser(room, socket.id, nickname);

      if (!room.hostSocketId || (hostToken && hostToken === room.hostToken)) {
        rooms.setHost(room, socket.id);
      }

      systemMessage(roomId, `${nickname} joined`);
      broadcastState(room, socket.id);
      ack?.({ ok: true, snapshot: rooms.snapshot(room), youAreHost: room.hostSocketId === socket.id });
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
      const nickname = room.users.get(socket.id)?.nickname || 'someone';
      systemMessage(room.id, `${nickname} changed the video`);
      broadcastState(room, socket.id);
      ack?.({ ok: true });
      enrichMedia(media).then((changed) => {
        if (changed && room.video.media === media) broadcastState(room, null);
      }).catch(() => {});
    });

    socket.on('play_pause', (payload) => {
      const room = currentRoom();
      if (!room || !room.video.media) return;
      if (!isHost(room) && room.locked) return;
      rooms.updateVideoState(room, {
        paused: !!payload?.paused,
        currentTime: Number(payload?.currentTime),
      });
      broadcastState(room, socket.id);
    });

    socket.on('seek', (payload) => {
      const room = currentRoom();
      if (!room || !room.video.media) return;
      if (!isHost(room) && room.locked) return;
      rooms.updateVideoState(room, {
        currentTime: Number(payload?.currentTime),
        paused: room.video.paused,
      });
      broadcastState(room, socket.id);
    });

    socket.on('buffering_start', () => {
      const room = currentRoom();
      if (!room || !room.video.media) return;
      const r = rooms.setBuffering(room, socket.id, true);
      if (r.changed) broadcastState(room, socket.id);
    });

    socket.on('buffering_end', () => {
      const room = currentRoom();
      if (!room || !room.video.media) return;
      const r = rooms.setBuffering(room, socket.id, false);
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
      rooms.enqueue(room, media);
      broadcastState(room, socket.id);
      ack?.({ ok: true });
      enrichMedia(media).then((changed) => {
        if (!changed) return;
        if (room.queue.includes(media) || room.video.media === media) {
          broadcastState(room, null);
        }
      }).catch(() => {});
    });

    socket.on('queue_remove', (payload) => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return;
      rooms.dequeueAt(room, Number(payload?.index));
      broadcastState(room, socket.id);
    });

    socket.on('queue_skip', () => {
      const room = currentRoom();
      if (!room) return;
      if (!isHost(room) && room.locked) return;
      const next = rooms.shiftQueue(room);
      const nickname = room.users.get(socket.id)?.nickname || 'host';
      if (next) {
        rooms.setMedia(room, next);
        systemMessage(room.id, `${nickname} skipped to the next video`);
      } else {
        room.video.media = null;
        room.video.paused = true;
        room.video.currentTime = 0;
        room.video.lastUpdateAt = Date.now();
        systemMessage(room.id, `${nickname} skipped — queue empty`);
      }
      broadcastState(room, socket.id);
    });

    socket.on('lock_room', (payload) => {
      const room = currentRoom();
      if (!room || !isHost(room)) return;
      room.locked = !!payload?.locked;
      systemMessage(room.id, `Host ${room.locked ? 'locked' : 'unlocked'} controls`);
      broadcastState(room, socket.id);
    });

    socket.on('set_persistent', (payload) => {
      const room = currentRoom();
      if (!room || !isHost(room)) return;
      rooms.setPersistent(room, !!payload?.persistent);
      if (room.persistent) cancelReap(room.id);
      systemMessage(room.id, `Room is now ${room.persistent ? 'persistent' : 'ephemeral'}`);
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
      const bucket = buckets.get(socket);
      if (!bucket || !bucket.take(1)) return;
      const text = sanitizeChat(payload?.text);
      if (!text) return;
      const nickname = room.users.get(socket.id)?.nickname || 'guest';
      io.to(room.id).emit('chat_message', {
        nickname,
        text,
        socketId: socket.id,
        ts: Date.now(),
      });
    });

    socket.on('sync_request', (ack) => {
      const room = currentRoom();
      if (!room) return;
      ack?.(rooms.snapshot(room));
    });

    socket.on('ping_time', (payload, ack) => {
      ack?.({ clientTime: payload?.clientTime, serverTime: Date.now() });
    });

    socket.on('disconnect', () => {
      if (!joinedRoomId) return;
      const room = rooms.get(joinedRoomId);
      if (!room) return;
      const wasHost = room.hostSocketId === socket.id;
      const user = room.users.get(socket.id);
      rooms.removeUser(room, socket.id);
      if (user) systemMessage(joinedRoomId, `${user.nickname} left`);

      if (wasHost) {
        const next = room.users.values().next().value;
        if (next) {
          rooms.setHost(room, next.socketId);
          systemMessage(joinedRoomId, `${next.nickname} is now the host`);
        }
      }

      const any = [...room.users.values()].some(u => u.buffering);
      if (!any && room.video.paused && room.video.autoPaused) {
        room.video.paused = false;
        room.video.autoPaused = false;
        room.video.lastUpdateAt = Date.now();
      }

      if (room.users.size === 0) scheduleReap(joinedRoomId);
      else broadcastState(room, null);
    });

    function currentRoom() { return joinedRoomId ? rooms.get(joinedRoomId) : null; }
    function isHost(room) { return room.hostSocketId === socket.id; }
  });
}
