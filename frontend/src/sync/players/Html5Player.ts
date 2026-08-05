import type Hls from 'hls.js';
import type { Media } from '../../types';
import { PlayerEvents, type Player, type VideoStateApply } from './types';

/** Native `<video>` playback, with HLS.js for `.m3u8` where unsupported natively. */
export class Html5Player implements Player {
  readonly events = new PlayerEvents();
  private suppress = false;
  private hls: Hls | null = null;
  private lastSeek = 0;
  private destroyed = false;
  // A drift-correction seek we issued ourselves. On HLS the resulting `seeked`
  // fires only after the target segment buffers — long after the 50ms `suppress`
  // window — so we track it with a flag cleared by `seeked` (not a timer). This
  // stops our own corrections from being misread as user seeks (which would tell
  // the server to respawn ffmpeg, yanking every client and looping endlessly).
  private programmaticSeek = false;
  private programmaticSeekAt = 0;
  private programmaticSeekTimer: number | null = null;
  /** True while we're playing muted because the browser blocked unmuted autoplay. */
  private mutedFallback = false;

  constructor(private readonly video: HTMLVideoElement) {
    video.addEventListener('play', () => {
      if (this.suppress || video.seeking) return;
      this.events.fire('play', { currentTime: video.currentTime });
    });
    video.addEventListener('pause', () => {
      if (this.suppress || video.seeking) return;
      this.events.fire('pause', { currentTime: video.currentTime });
    });
    video.addEventListener('seeked', () => {
      // Our own correction — swallow it (and only it), regardless of how long
      // the HLS seek took to complete.
      if (this.programmaticSeek) {
        this.programmaticSeek = false;
        if (this.programmaticSeekTimer) {
          clearTimeout(this.programmaticSeekTimer);
          this.programmaticSeekTimer = null;
        }
        return;
      }
      const now = Date.now();
      if (this.suppress || now - this.lastSeek < 250) return;
      this.lastSeek = now;
      this.events.fire('seek', { currentTime: video.currentTime });
    });
    video.addEventListener('ratechange', () => {
      if (this.suppress) return;
      this.events.fire('ratechange', { rate: video.playbackRate });
    });
    video.addEventListener('waiting', () => {
      // A short re-buffer right after our own correction seek is expected — don't
      // report it, or the room would auto-pause itself on every drift fix.
      if (Date.now() - this.programmaticSeekAt < 2000) return;
      this.events.fire('buffering', { buffering: true });
    });
    video.addEventListener('canplay', () => this.events.fire('buffering', { buffering: false }));
    video.addEventListener('playing', () => this.events.fire('buffering', { buffering: false }));
    video.addEventListener('ended', () => this.events.fire('ended'));
    video.addEventListener('volumechange', () => {
      // Viewer unmuted via the native controls — the muted fallback is over.
      if (this.mutedFallback && !video.muted) {
        this.mutedFallback = false;
        this.events.fire('autoplayblocked', { blocked: false });
      }
    });
    video.addEventListener('loadedmetadata', () => this.events.fire('ready'));
    video.addEventListener('error', () => this.events.fire('mediaerror', { code: video.error?.code }));
  }

  load(media: Media) {
    this.destroyHls();

    if (media.kind === 'hls') {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = media.source; // Safari plays HLS natively
      } else {
        // Lazy-load HLS.js — only pulled in when an .m3u8 actually plays.
        void this.loadHls(media.source);
      }
    } else {
      this.video.src = media.source;
    }
  }

  private async loadHls(source: string) {
    const { default: Hls } = await import('hls.js');
    // The player may have been torn down while the chunk was loading.
    if (this.destroyed) return;
    if (!Hls.isSupported()) {
      this.events.fire('mediaerror', { code: 'hls-unsupported' });
      return;
    }
    this.destroyHls();
    const hls = new Hls({ maxBufferLength: 30, enableWorker: true });
    this.hls = hls;
    // Recover from transient network/media errors (common on live HLS like
    // Twitch) instead of giving up or buffering forever; only surface a real
    // error once recovery has failed repeatedly, so a dead stream reports back
    // rather than spinning indefinitely.
    let recoverAttempts = 0;
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      recoverAttempts = 0;
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || this.hls !== hls) return;
      if (recoverAttempts < 3 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        recoverAttempts++;
        hls.startLoad();
      } else if (recoverAttempts < 3 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        recoverAttempts++;
        hls.recoverMediaError();
      } else {
        this.events.fire('mediaerror', { code: data.details || data.type });
      }
    });
    hls.loadSource(source);
    hls.attachMedia(this.video);
  }

  private destroyHls() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
  }

  unload() {
    this.destroyed = true;
    if (this.programmaticSeekTimer) {
      clearTimeout(this.programmaticSeekTimer);
      this.programmaticSeekTimer = null;
    }
    this.destroyHls();
    try {
      if (document.pictureInPictureElement === this.video) document.exitPictureInPicture();
    } catch {
      /* ignore */
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  getTime() {
    return this.video.currentTime || 0;
  }
  getRate() {
    return this.video.playbackRate || 1;
  }
  isPaused() {
    return this.video.paused;
  }
  isSeeking() {
    return this.video.seeking;
  }
  getTitle() {
    return null;
  }

  private withSuppression(fn: () => void) {
    this.suppress = true;
    try {
      fn();
    } finally {
      setTimeout(() => {
        this.suppress = false;
      }, 50);
    }
  }

  /** Mark that the upcoming `currentTime` write is our own correction, so the
   *  `seeked` it eventually produces (possibly seconds later on HLS) is not
   *  reported as a user seek. A safety timer clears the flag if no `seeked`
   *  arrives, so a later genuine user seek is never swallowed. */
  private markProgrammaticSeek() {
    this.programmaticSeek = true;
    this.programmaticSeekAt = Date.now();
    if (this.programmaticSeekTimer) clearTimeout(this.programmaticSeekTimer);
    this.programmaticSeekTimer = window.setTimeout(() => {
      this.programmaticSeek = false;
      this.programmaticSeekTimer = null;
    }, 4000);
  }

  applyState({ currentTime, paused, rate }: VideoStateApply) {
    this.withSuppression(() => {
      if (Math.abs(this.video.playbackRate - rate) > 0.001) {
        try {
          this.video.playbackRate = rate;
        } catch {
          /* ignore */
        }
      }
      if (Math.abs(this.video.currentTime - currentTime) > 0.4) {
        this.markProgrammaticSeek();
        try {
          this.video.currentTime = currentTime;
        } catch {
          this.programmaticSeek = false;
        }
      }
      if (paused && !this.video.paused) {
        this.video.pause();
      } else if (!paused && this.video.paused) {
        this.video.play()?.catch(() => this.fallBackToMuted());
      }
    });
  }

  /** The browser refused unmuted playback (no qualifying user gesture). Muted
   *  playback is always allowed — use it so the viewer sees video instead of a
   *  black frame, and tell the UI to offer a "tap for sound" gesture. */
  private fallBackToMuted() {
    if (this.destroyed || this.mutedFallback) return;
    this.video.muted = true;
    const p = this.video.play();
    if (!p) return;
    p.then(() => {
      this.mutedFallback = true;
      this.events.fire('autoplayblocked', { blocked: true });
    }).catch(() => {
      // Even muted playback failed — a real playback problem, not autoplay
      // policy. Undo the mute and let the usual error/buffering paths report it.
      this.video.muted = false;
    });
  }

  resumeUnmuted() {
    this.mutedFallback = false;
    this.withSuppression(() => {
      this.video.muted = false;
      this.video.play()?.catch(() => {});
    });
    this.events.fire('autoplayblocked', { blocked: false });
  }

  setRate(rate: number) {
    try {
      this.video.playbackRate = rate;
    } catch {
      /* ignore */
    }
  }

  setEnabled(enabled: boolean) {
    this.video.controls = enabled;
    this.video.style.pointerEvents = enabled ? '' : 'none';
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    return this.video.muted;
  }

  setVolume(v: number) {
    this.video.volume = Math.max(0, Math.min(1, v));
    this.video.muted = false;
  }

  seekBy(deltaSec: number) {
    try {
      this.video.currentTime = Math.max(0, this.video.currentTime + deltaSec);
    } catch {
      /* ignore */
    }
  }

  togglePlay() {
    if (this.video.paused) this.video.play()?.catch(() => {});
    else this.video.pause();
  }

  supportsPiP() {
    return !!document.pictureInPictureEnabled && !this.video.disablePictureInPicture;
  }

  async togglePiP() {
    try {
      if (document.pictureInPictureElement === this.video) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      /* ignore */
    }
  }
}
