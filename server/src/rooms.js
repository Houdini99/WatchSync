import { customAlphabet } from 'nanoid';

const idAlphabet = '23456789abcdefghjkmnpqrstuvwxyz';
const newRoomId = customAlphabet(idAlphabet, 10);
const newHostToken = customAlphabet(idAlphabet, 32);

const DRIFT_TOLERANCE_SEC = 1.5;

export class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    const id = newRoomId();
    const hostToken = newHostToken();
    const room = {
      id,
      hostToken,
      hostSocketId: null,
      locked: false,
      persistent: false,
      users: new Map(),
      video: {
        media: null,
        currentTime: 0,
        paused: true,
        lastUpdateAt: Date.now(),
        autoPaused: false,
      },
      queue: [],
      createdAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }
  delete(id) { this.rooms.delete(id); }

  computeLiveTime(room) {
    const v = room.video;
    if (!v.media) return 0;
    if (v.paused) return v.currentTime;
    return v.currentTime + (Date.now() - v.lastUpdateAt) / 1000;
  }

  snapshot(room) {
    return {
      id: room.id,
      locked: room.locked,
      persistent: room.persistent,
      hostSocketId: room.hostSocketId,
      users: [...room.users.values()].map(u => ({
        socketId: u.socketId,
        nickname: u.nickname,
        isHost: u.socketId === room.hostSocketId,
        buffering: u.buffering,
      })),
      video: {
        media: room.video.media,
        currentTime: this.computeLiveTime(room),
        paused: room.video.paused,
        serverTime: Date.now(),
      },
      queue: room.queue,
    };
  }

  addUser(room, socketId, nickname) {
    room.users.set(socketId, { socketId, nickname, buffering: false, joinedAt: Date.now() });
  }

  removeUser(room, socketId) {
    room.users.delete(socketId);
    if (room.hostSocketId === socketId) room.hostSocketId = null;
  }

  setHost(room, socketId) { room.hostSocketId = socketId; }

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

  setMedia(room, media) {
    room.video.media = media;
    room.video.currentTime = 0;
    room.video.paused = false;
    room.video.lastUpdateAt = Date.now();
    room.video.autoPaused = false;
  }

  setBuffering(room, socketId, buffering) {
    const user = room.users.get(socketId);
    if (!user) return { changed: false };
    if (user.buffering === buffering) return { changed: false };
    user.buffering = buffering;

    const anyBuffering = [...room.users.values()].some(u => u.buffering);
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

  enqueue(room, media) { room.queue.push(media); }
  dequeueAt(room, index) {
    if (index < 0 || index >= room.queue.length) return null;
    return room.queue.splice(index, 1)[0];
  }
  shiftQueue(room) { return room.queue.shift() || null; }

  updateMediaTitle(room, title) {
    if (room.video.media && typeof title === 'string') {
      const t = title.trim().slice(0, 200);
      if (t) room.video.media.title = t;
    }
  }

  setPersistent(room, persistent) { room.persistent = !!persistent; }
}

export { DRIFT_TOLERANCE_SEC };
