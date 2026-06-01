// Player abstraction: HTML5 video (native + HLS) and YouTube IFrame API.
// Emits events: play, pause, seek, ratechange, buffering, timeupdate, ready, ended.

export class PlayerEvents extends EventTarget {
  fire(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// --- HTML5 / HLS ---
export class Html5Player {
  constructor(videoEl) {
    this.video = videoEl;
    this.events = new PlayerEvents();
    this._suppress = false;
    this._hls = null;
    this._lastSeek = 0;

    videoEl.addEventListener('play', () => {
      if (this._suppress || videoEl.seeking) return;
      this.events.fire('play', { currentTime: videoEl.currentTime });
    });
    videoEl.addEventListener('pause', () => {
      if (this._suppress || videoEl.seeking) return;
      this.events.fire('pause', { currentTime: videoEl.currentTime });
    });
    videoEl.addEventListener('seeked', () => {
      const now = Date.now();
      if (this._suppress || now - this._lastSeek < 250) return;
      this._lastSeek = now;
      this.events.fire('seek', { currentTime: videoEl.currentTime });
    });
    videoEl.addEventListener('ratechange', () => {
      if (this._suppress) return;
      this.events.fire('ratechange', { rate: videoEl.playbackRate });
    });
    videoEl.addEventListener('waiting', () => this.events.fire('buffering', { buffering: true }));
    videoEl.addEventListener('canplay', () => this.events.fire('buffering', { buffering: false }));
    videoEl.addEventListener('playing', () => this.events.fire('buffering', { buffering: false }));
    videoEl.addEventListener('ended', () => this.events.fire('ended'));
    videoEl.addEventListener('loadedmetadata', () => this.events.fire('ready'));
    videoEl.addEventListener('error', () => this.events.fire('mediaerror', { code: videoEl.error?.code }));
  }

  load(media) {
    if (this._hls) { try { this._hls.destroy(); } catch {} this._hls = null; }
    this.video.classList.remove('hidden');

    if (media.type === 'hls') {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = media.source; // Safari plays HLS natively
      } else if (window.Hls && window.Hls.isSupported()) {
        this._hls = new window.Hls({ maxBufferLength: 30, enableWorker: true });
        this._hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (data?.fatal) this.events.fire('mediaerror', { code: data.type });
        });
        this._hls.loadSource(media.source);
        this._hls.attachMedia(this.video);
      } else {
        this.events.fire('mediaerror', { code: 'hls-unsupported' });
      }
    } else {
      this.video.src = media.source;
    }
  }

  unload() {
    if (this._hls) { try { this._hls.destroy(); } catch {} this._hls = null; }
    try { if (document.pictureInPictureElement === this.video) document.exitPictureInPicture(); } catch {}
    this.video.removeAttribute('src');
    this.video.load();
    this.video.classList.add('hidden');
  }

  getTime() { return this.video.currentTime || 0; }
  getRate() { return this.video.playbackRate || 1; }
  isPaused() { return this.video.paused; }
  isSeeking() { return this.video.seeking; }
  getTitle() { return null; }

  withSuppression(fn) {
    this._suppress = true;
    try { fn(); } finally {
      setTimeout(() => { this._suppress = false; }, 50);
    }
  }

  async applyState({ currentTime, paused, rate }) {
    this.withSuppression(() => {
      if (typeof rate === 'number' && Math.abs(this.video.playbackRate - rate) > 0.001) {
        try { this.video.playbackRate = rate; } catch {}
      }
      if (typeof currentTime === 'number' && Math.abs(this.video.currentTime - currentTime) > 0.4) {
        try { this.video.currentTime = currentTime; } catch {}
      }
      if (paused && !this.video.paused) this.video.pause();
      else if (!paused && this.video.paused) {
        const p = this.video.play();
        if (p && p.catch) p.catch(() => {});
      }
    });
  }

  setRate(rate) {
    try { this.video.playbackRate = rate; } catch {}
  }

  setEnabled(enabled) {
    this.video.controls = enabled;
    this.video.style.pointerEvents = enabled ? '' : 'none';
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    return this.video.muted;
  }

  setVolume(v) { this.video.volume = Math.max(0, Math.min(1, v)); this.video.muted = false; }

  seekBy(deltaSec) {
    try { this.video.currentTime = Math.max(0, this.video.currentTime + deltaSec); } catch {}
  }

  togglePlay() {
    if (this.video.paused) {
      const p = this.video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      this.video.pause();
    }
  }

  supportsPiP() { return !!document.pictureInPictureEnabled && !this.video.disablePictureInPicture; }
  async togglePiP() {
    try {
      if (document.pictureInPictureElement === this.video) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {}
  }
}

// --- YouTube ---
export class YouTubePlayer {
  constructor(mountEl) {
    this.mount = mountEl;
    this.events = new PlayerEvents();
    this._yt = null;
    this._suppress = false;
    this._ready = false;
    this._pollTimer = null;
    this._lastState = -99;
  }

  async load(media) {
    this.mount.classList.remove('hidden');
    this.mount.innerHTML = '<div id="yt-iframe-target"></div>';
    await this._waitForYTApi();

    if (this._yt) { try { this._yt.destroy(); } catch {} }
    this._ready = false;

    this._yt = new window.YT.Player('yt-iframe-target', {
      videoId: media.id,
      playerVars: {
        autoplay: 1, modestbranding: 1, rel: 0, playsinline: 1, controls: 1,
        start: Number.isFinite(media.start) ? Math.floor(media.start) : 0,
      },
      events: {
        onReady: () => { this._ready = true; this.events.fire('ready'); this._startPolling(); },
        onStateChange: (e) => this._onStateChange(e),
        onPlaybackRateChange: (e) => { if (!this._suppress) this.events.fire('ratechange', { rate: e.data }); },
        onError: (e) => this.events.fire('mediaerror', { code: e?.data }),
      },
    });
  }

  _waitForYTApi() {
    return new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
    });
  }

  _startPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => {
      if (!this._ready) return;
      this.events.fire('timeupdate', { currentTime: this.getTime() });
    }, 1000);
  }

  _onStateChange(e) {
    if (this._suppress) return;
    const YT = window.YT.PlayerState;
    const ct = this.getTime();
    if (e.data === YT.PLAYING) {
      this.events.fire('buffering', { buffering: false });
      this.events.fire('play', { currentTime: ct });
    } else if (e.data === YT.PAUSED) {
      this.events.fire('pause', { currentTime: ct });
    } else if (e.data === YT.BUFFERING) {
      this.events.fire('buffering', { buffering: true });
    } else if (e.data === YT.ENDED) {
      this.events.fire('ended');
    }
    this._lastState = e.data;
  }

  unload() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._yt) { try { this._yt.destroy(); } catch {} this._yt = null; }
    this.mount.innerHTML = '';
    this.mount.classList.add('hidden');
    this._ready = false;
  }

  getTime() {
    try { return this._ready ? this._yt.getCurrentTime() : 0; } catch { return 0; }
  }
  getRate() {
    try { return this._yt.getPlaybackRate() || 1; } catch { return 1; }
  }
  isPaused() {
    try { return this._yt.getPlayerState() !== window.YT.PlayerState.PLAYING; } catch { return true; }
  }
  isSeeking() {
    try { return this._yt.getPlayerState() === window.YT.PlayerState.BUFFERING; } catch { return false; }
  }
  getTitle() {
    try {
      const data = this._yt && this._yt.getVideoData && this._yt.getVideoData();
      return data?.title || null;
    } catch { return null; }
  }

  withSuppression(fn) {
    this._suppress = true;
    try { fn(); } finally { setTimeout(() => { this._suppress = false; }, 200); }
  }

  async applyState({ currentTime, paused, rate }) {
    if (!this._ready) {
      await new Promise((r) => {
        const h = () => { this.events.removeEventListener('ready', h); r(); };
        this.events.addEventListener('ready', h);
      });
    }
    this.withSuppression(() => {
      try {
        if (typeof rate === 'number' && Math.abs(this.getRate() - rate) > 0.001) {
          this._yt.setPlaybackRate(rate);
        }
        if (typeof currentTime === 'number' && Math.abs(this.getTime() - currentTime) > 0.6) {
          this._yt.seekTo(currentTime, true);
        }
        if (paused) this._yt.pauseVideo();
        else this._yt.playVideo();
      } catch {}
    });
  }

  setRate(rate) { try { this._yt.setPlaybackRate(rate); } catch {} }

  setEnabled(enabled) {
    this.mount.style.pointerEvents = enabled ? '' : 'none';
  }

  toggleMute() {
    try {
      if (this._yt.isMuted()) { this._yt.unMute(); return false; }
      this._yt.mute(); return true;
    } catch { return false; }
  }

  setVolume(v) { try { this._yt.unMute(); this._yt.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100)); } catch {} }

  seekBy(deltaSec) {
    try {
      const t = Math.max(0, this.getTime() + deltaSec);
      this._yt.seekTo(t, true);
    } catch {}
  }

  togglePlay() {
    try {
      if (this.isPaused()) this._yt.playVideo();
      else this._yt.pauseVideo();
    } catch {}
  }

  supportsPiP() { return false; }
  async togglePiP() {}
}

export function pickPlayer(media, { videoEl, ytMount }) {
  if (media.type === 'youtube') return new YouTubePlayer(ytMount);
  return new Html5Player(videoEl);
}
