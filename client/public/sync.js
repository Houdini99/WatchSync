// Sync engine. Translates server state -> player state, drift-corrects,
// and forwards player intents -> server. Owns latency estimation.

const DRIFT_TOLERANCE = 1.5;
const LOCAL_ACTION_GRACE_MS = 2000;
const BUFFER_DEBOUNCE_MS = 500;
const LOAD_SETTLE_MS = 1500;
const READY_TAIL_MS = 800;

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
    // While a freshly loaded player seeks/autoplays into position it fires
    // play/seek/rate events that are NOT user intent. Suppress *outgoing*
    // intents until things settle, or a late joiner's autoplay-at-0 echo would
    // clobber the room's real position. Incoming sync still applies normally.
    this._suspendOutgoingUntil = 0;

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
    // Suspend outgoing intents while the new player loads and seeks into place.
    this._suspendOutgoingUntil = Date.now() + LOAD_SETTLE_MS;
    // Extend the window a little past "ready" to cover the post-ready seek/play
    // echo on slow loads (esp. YouTube, where ready can take a second or two).
    const onReady = () => {
      player.events.removeEventListener('ready', onReady);
      this._suspendOutgoingUntil = Math.max(this._suspendOutgoingUntil, Date.now() + READY_TAIL_MS);
    };
    player.events.addEventListener('ready', onReady);
    this._bindPlayer(player);
  }

  _markLocalChange() { this._lastLocalChange = Date.now(); }
  _inLocalGrace() { return Date.now() - this._lastLocalChange < LOCAL_ACTION_GRACE_MS; }
  _outgoingSuspended() { return Date.now() < this._suspendOutgoingUntil; }
  _cancelBufferTimer() {
    if (this._bufferTimer) { clearTimeout(this._bufferTimer); this._bufferTimer = null; }
  }

  _bindPlayer(player) {
    player.events.addEventListener('play', (e) => {
      if (this._outgoingSuspended()) return;
      this._markLocalChange();
      this.socket.emit('play_pause', { paused: false, currentTime: e.detail.currentTime });
    });
    player.events.addEventListener('pause', (e) => {
      if (this._outgoingSuspended()) return;
      this._markLocalChange();
      this.socket.emit('play_pause', { paused: true, currentTime: e.detail.currentTime });
    });
    player.events.addEventListener('seek', (e) => {
      if (this._outgoingSuspended()) return;
      this._markLocalChange();
      this.socket.emit('seek', { currentTime: e.detail.currentTime });
    });
    player.events.addEventListener('ratechange', (e) => {
      if (this._outgoingSuspended()) return;
      this._markLocalChange();
      this.socket.emit('set_rate', { rate: e.detail.rate });
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
        this.player.applyState({
          currentTime: this.player.getTime(),
          paused: state.video.paused,
          rate: state.video.rate,
        });
      }
      return;
    }
    this._apply(state.video);
  }

  onHeartbeat(state) {
    if (!this.player) return;
    if (this._inLocalGrace()) return;
    if (this.player.isSeeking?.()) return;
    const rate = state.rate || 1;
    const live = state.currentTime + (state.paused ? 0 : (this.latencyMs / 1000) * rate);
    const diff = Math.abs(this.player.getTime() - live);
    const rateOff = Math.abs((this.player.getRate?.() ?? 1) - rate) > 0.001;
    if (diff > DRIFT_TOLERANCE || this.player.isPaused() !== state.paused || rateOff) {
      this.player.applyState({ currentTime: live, paused: state.paused, rate });
    }
  }

  _apply(videoState) {
    const rate = videoState.rate || 1;
    const live = videoState.currentTime + (videoState.paused ? 0 : (this.latencyMs / 1000) * rate);
    this.player.applyState({ currentTime: live, paused: videoState.paused, rate });
  }

  // Public: apply a state explicitly (used right after media load on join).
  applyInitial(videoState) {
    if (!this.player || !videoState) return;
    const apply = () => this._apply(videoState);
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
