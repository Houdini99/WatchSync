import { customAlphabet } from 'nanoid';
import { config } from './config.js';

const idAlphabet = '23456789abcdefghjkmnpqrstuvwxyz';
const newRoomId = customAlphabet(idAlphabet, 10);
const newHostToken = customAlphabet(idAlphabet, 32);

// Distinct, readable nick colors. Picked deterministically per user so a given
// person keeps the same color across the whole room.
const USER_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee',
  '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#fb7185',
];

function colorFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

function clampRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  // Snap to the nearest allowed rate within a small tolerance.
  const match = config.allowedRates.find((a) => Math.abs(a - r) < 0.001);
  return match ?? null;
}

export class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    if (this.rooms.size >= config.maxRooms) {
      // Reap the oldest empty room to make space rather than refuse outright.
      this._evictOldestEmpty();
    }
    const id = newRoomId();
    const hostToken = newHostToken();
    const room = {
      id,
      hostToken,
      hostClientId: null,
      locked: false,
      persistent: false,
      // Map<clientId, user>. clientId is a stable per-browser identity so a
      // reconnecting socket keeps its seat, nickname, color, and host status.
      users: new Map(),
      video: {
        media: null,
        currentTime: 0,
        paused: true,
        rate: 1,
        lastUpdateAt: Date.now(),
        autoPaused: false,
      },
      queue: [],
      chatHistory: [],
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }
  delete(id) { this.rooms.delete(id); }

  _evictOldestEmpty() {
    let oldest = null;
    for (const room of this.rooms.values()) {
      if (room.persistent) continue;
      const live = [...room.users.values()].some((u) => !u.disconnected);
      if (live) continue;
      if (!oldest || room.createdAt < oldest.createdAt) oldest = room;
    }
    if (oldest) this.rooms.delete(oldest.id);
  }

  liveUserCount(room) {
    let n = 0;
    for (const u of room.users.values()) if (!u.disconnected) n++;
    return n;
  }

  // Elapsed playback advances by wall-clock * playback rate while playing.
  computeLiveTime(room) {
    const v = room.video;
    if (!v.media) return 0;
    if (v.paused) return v.currentTime;
    return v.currentTime + ((Date.now() - v.lastUpdateAt) / 1000) * (v.rate || 1);
  }

  snapshot(room) {
    return {
      id: room.id,
      locked: room.locked,
      persistent: room.persistent,
      hostClientId: room.hostClientId,
      hostSocketId: this._hostSocketId(room),
      users: [...room.users.values()].map((u) => ({
        clientId: u.clientId,
        socketId: u.socketId,
        nickname: u.nickname,
        color: u.color,
        isHost: u.clientId === room.hostClientId,
        buffering: u.buffering,
        disconnected: !!u.disconnected,
      })),
      video: {
        media: room.video.media,
        currentTime: this.computeLiveTime(room),
        paused: room.video.paused,
        rate: room.video.rate || 1,
        serverTime: Date.now(),
      },
      queue: room.queue,
    };
  }

  _hostSocketId(room) {
    if (!room.hostClientId) return null;
    return room.users.get(room.hostClientId)?.socketId || null;
  }

  // Returns { user, reconnected }. Reuses the existing seat if this clientId is
  // already known (a reconnect or second tab takeover).
  addUser(room, clientId, socketId, nickname) {
    const existing = room.users.get(clientId);
    if (existing) {
      existing.socketId = socketId;
      existing.disconnected = false;
      existing.disconnectedAt = null;
      if (nickname) existing.nickname = nickname;
      return { user: existing, reconnected: true };
    }
    const user = {
      clientId,
      socketId,
      nickname,
      color: colorFor(clientId),
      buffering: false,
      disconnected: false,
      disconnectedAt: null,
      joinedAt: Date.now(),
    };
    room.users.set(clientId, user);
    return { user, reconnected: false };
  }

  // Flag the seat as gone without freeing it, so a quick reconnect is seamless.
  markDisconnected(room, clientId) {
    const user = room.users.get(clientId);
    if (!user) return null;
    user.disconnected = true;
    user.disconnectedAt = Date.now();
    user.buffering = false;
    return user;
  }

  removeUser(room, clientId) {
    room.users.delete(clientId);
    if (room.hostClientId === clientId) room.hostClientId = null;
  }

  setHost(room, clientId) { room.hostClientId = clientId; }

  isHostToken(room, token) {
    return typeof token === 'string' && token.length > 0 && token === room.hostToken;
  }

  // Pick a live, connected user to inherit host. Returns the new host or null.
  migrateHost(room) {
    for (const u of room.users.values()) {
      if (!u.disconnected) { room.hostClientId = u.clientId; return u; }
    }
    room.hostClientId = null;
    return null;
  }

  updateVideoState(room, { paused, currentTime }) {
    const v = room.video;
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0) {
      v.currentTime = currentTime;
    } else {
      v.currentTime = this.computeLiveTime(room);
    }
    if (typeof paused === 'boolean') v.paused = paused;
    v.lastUpdateAt = Date.now();
    v.autoPaused = false;
  }

  setRate(room, rate) {
    const r = clampRate(rate);
    if (r === null || r === room.video.rate) return false;
    // Freeze the current position before changing the multiplier.
    room.video.currentTime = this.computeLiveTime(room);
    room.video.rate = r;
    room.video.lastUpdateAt = Date.now();
    return true;
  }

  setMedia(room, media) {
    room.video.media = media;
    room.video.currentTime = Number.isFinite(media?.start) ? media.start : 0;
    room.video.paused = false;
    room.video.rate = 1;
    room.video.lastUpdateAt = Date.now();
    room.video.autoPaused = false;
  }

  clearMedia(room) {
    room.video.media = null;
    room.video.paused = true;
    room.video.currentTime = 0;
    room.video.rate = 1;
    room.video.lastUpdateAt = Date.now();
    room.video.autoPaused = false;
  }

  setBuffering(room, clientId, buffering) {
    const user = room.users.get(clientId);
    if (!user) return { changed: false };
    if (user.buffering === buffering) return { changed: false };
    user.buffering = buffering;

    const anyBuffering = [...room.users.values()].some((u) => !u.disconnected && u.buffering);
    const v = room.video;
    if (anyBuffering && !v.paused) {
      v.currentTime = this.computeLiveTime(room);
      v.paused = true;
      v.autoPaused = true;
      v.lastUpdateAt = Date.now();
      return { changed: true, kind: 'auto-pause' };
    }
    if (!anyBuffering && v.paused && v.autoPaused) {
      v.paused = false;
      v.autoPaused = false;
      v.lastUpdateAt = Date.now();
      return { changed: true, kind: 'auto-resume' };
    }
    return { changed: true, kind: 'buffer-state' };
  }

  // Re-evaluate auto-pause after someone leaves: if the only buffering users are
  // gone, resume. Returns true if state changed.
  reconcileAutoPause(room) {
    const anyBuffering = [...room.users.values()].some((u) => !u.disconnected && u.buffering);
    const v = room.video;
    if (!anyBuffering && v.paused && v.autoPaused) {
      v.paused = false;
      v.autoPaused = false;
      v.lastUpdateAt = Date.now();
      return true;
    }
    return false;
  }

  enqueue(room, media) {
    if (room.queue.length >= config.maxQueueLength) return false;
    room.queue.push(media);
    return true;
  }
  dequeueAt(room, index) {
    if (index < 0 || index >= room.queue.length) return null;
    return room.queue.splice(index, 1)[0];
  }
  moveQueueItem(room, from, to) {
    const n = room.queue.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [item] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, item);
    return true;
  }
  shiftQueue(room) { return room.queue.shift() || null; }

  updateMediaTitle(room, title) {
    if (room.video.media && typeof title === 'string') {
      const t = title.trim().slice(0, 200);
      if (t) room.video.media.title = t;
    }
  }

  setPersistent(room, persistent) { room.persistent = !!persistent; }

  pushChat(room, entry) {
    room.chatHistory.push(entry);
    if (room.chatHistory.length > config.chatHistoryLimit) {
      room.chatHistory.splice(0, room.chatHistory.length - config.chatHistoryLimit);
    }
  }
}

export { colorFor, clampRate };
