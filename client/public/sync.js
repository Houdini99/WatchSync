// Sync engine. Translates server state -> player state, drift-corrects,
// and forwards player intents -> server. Owns latency estimation.

const DRIFT_TOLERANCE = 1.5;
const LOCAL_ACTION_GRACE_MS = 2000;
const BUFFER_DEBOUNCE_MS = 500;

export class SyncEngine extends EventTarget {
  constructor(socket) {
    super();
    this.socket = socket;
    this.player = null;
    this.media = null;
    this.latencyMs = 0;
    this._pingTimer = null;
    this._lastLocalChange = 0;
    this._bufferTimer = null;
    this._bufferState = false;
    this._mySocketId = null;

    socket.on('connect', () => { this._mySocketId = socket.id; });
    socket.on('heartbeat', (state) => this.onHeartbeat(state));
    socket.on('room_state', (state) => this.onRoomState(state));

    this._startPinging();
  }

  _startPinging() {
    this._ping();
    this._pingTimer = setInterval(() => this._ping(), 15000);
  }

  _ping() {
    const clientTime = Date.now();
    this.socket.timeout(3000).emit('ping_time', { clientTime }, (err, resp) => {
      if (err || !resp) return;
      const rtt = Date.now() - resp.clientTime;
      this.latencyMs = rtt / 2;
      this.dispatchEvent(new CustomEvent('latency', { detail: { rtt, latencyMs: this.latencyMs } }));
    });
  }

  setPlayer(player, media) {
    this.player = player;
    this.media = media;
    this._cancelBufferTimer();
    this._bufferState = false;
    this._bindPlayer(player);
  }

  _markLocalChange() { this._lastLocalChange = Date.now(); }
  _inLocalGrace() { return Date.now() - this._lastLocalChange < LOCAL_ACTION_GRACE_MS; }
  _cancelBufferTimer() {
    if (this._bufferTimer) { clearTimeout(this._bufferTimer); this._bufferTimer = null; }
  }

  _bindPlayer(player) {
    player.events.addEventListener('play', (e) => {
      this._markLocalChange();
      this.socket.emit('play_pause', { paused: false, currentTime: e.detail.currentTime });
    });
    player.events.addEventListener('pause', (e) => {
      this._markLocalChange();
      this.socket.emit('play_pause', { paused: true, currentTime: e.detail.currentTime });
    });
    player.events.addEventListener('seek', (e) => {
      this._markLocalChange();
      this.socket.emit('seek', { currentTime: e.detail.currentTime });
    });
    player.events.addEventListener('buffering', (e) => {
      const buffering = !!e.detail.buffering;
      this._cancelBufferTimer();
      if (buffering) {
        this._bufferTimer = setTimeout(() => {
          if (this._bufferState) return;
          this._bufferState = true;
          this.socket.emit('buffering_start');
        }, BUFFER_DEBOUNCE_MS);
      } else if (this._bufferState) {
        this._bufferState = false;
        this.socket.emit('buffering_end');
      }
    });
    player.events.addEventListener('ended', () => {
      this.socket.emit('queue_skip');
    });
  }

  onRoomState(state) {
    if (!this.player || !state.video?.media) return;
    // Ignore broadcasts caused by ourselves — the local player already has the truth.
    if (state.causedBy && state.causedBy === this._mySocketId) return;
    if (this._inLocalGrace()) {
      // Mid local action: respect pause flips initiated by others, but DON'T trust their position.
      if (this.player.isPaused() !== state.video.paused) {
        this.player.applyState({ currentTime: this.player.getTime(), paused: state.video.paused });
      }
      return;
    }
    this._apply(state.video);
  }

  onHeartbeat(state) {
    if (!this.player) return;
    if (this._inLocalGrace()) return;
    if (this.player.isSeeking?.()) return;
    const live = state.currentTime + (state.paused ? 0 : this.latencyMs / 1000);
    const diff = Math.abs(this.player.getTime() - live);
    if (diff > DRIFT_TOLERANCE) {
      this.player.applyState({ currentTime: live, paused: state.paused });
    } else if (this.player.isPaused() !== state.paused) {
      this.player.applyState({ currentTime: live, paused: state.paused });
    }
  }

  _apply(videoState) {
    const live = videoState.currentTime + (videoState.paused ? 0 : this.latencyMs / 1000);
    this.player.applyState({ currentTime: live, paused: videoState.paused });
  }

  // Public: apply a state explicitly (used right after media load on join).
  applyInitial(videoState) {
    if (!this.player || !videoState) return;
    const apply = () => {
      const live = videoState.currentTime + (videoState.paused ? 0 : this.latencyMs / 1000);
      this.player.applyState({ currentTime: live, paused: videoState.paused });
    };
    // If the player isn't ready yet (no metadata), wait for it.
    const ready = () => {
      this.player.events.removeEventListener('ready', ready);
      apply();
    };
    this.player.events.addEventListener('ready', ready);
    // Some players may already be ready by the time we call this — try once now too.
    apply();
  }

  resync() {
    return new Promise((resolve) => {
      this.socket.timeout(3000).emit('sync_request', (err, snap) => {
        if (err || !snap?.video?.media || !this.player) return resolve(false);
        this._apply(snap.video);
        resolve(true);
      });
    });
  }
}
