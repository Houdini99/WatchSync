import type { Media } from '../../types';
import { PlayerEvents, type Player, type VideoStateApply } from './types';

/** YouTube playback via the IFrame API (loaded by a <script> in index.html). */
export class YouTubePlayer implements Player {
  readonly events = new PlayerEvents();
  private yt: YTPlayer | null = null;
  private suppress = false;
  private ready = false;
  private pollTimer: number | null = null;
  private blockCheckTimer: number | null = null;
  /** True while we're playing muted because the browser blocked unmuted autoplay. */
  private mutedFallback = false;

  constructor(private readonly mount: HTMLElement) {}

  async load(media: Media) {
    this.mount.innerHTML = '<div id="yt-iframe-target"></div>';
    await this.waitForApi();

    if (this.yt) {
      try {
        this.yt.destroy();
      } catch {
        /* ignore */
      }
    }
    this.ready = false;

    this.yt = new window.YT!.Player('yt-iframe-target', {
      videoId: media.id ?? '',
      playerVars: {
        autoplay: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        controls: 1,
        // Embeds get a reduced caption dataset from YouTube (no auto-translate
        // catalog), so at least steer the player's UI + default caption track
        // to the viewer's language. The full fix is the app-level caption
        // overlay (see lib/captions.ts).
        hl: navigator.language || 'en',
        cc_lang_pref: (navigator.language || 'en').split('-')[0],
        // For a live stream, omitting `start` lets YouTube open at the live edge;
        // passing start:0 would rewind to the beginning of the DVR buffer.
        ...(media.is_live ? {} : { start: Number.isFinite(media.start) ? Math.floor(media.start) : 0 }),
      },
      events: {
        onReady: () => {
          this.ready = true;
          this.events.fire('ready');
          this.startPolling();
        },
        onStateChange: (e) => this.onStateChange(e.data),
        onPlaybackRateChange: (e) => {
          if (!this.suppress) this.events.fire('ratechange', { rate: e.data });
        },
        onError: (e) => this.events.fire('mediaerror', { code: e.data }),
      },
    });
  }

  private waitForApi(): Promise<void> {
    return new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
    });
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => {
      if (!this.ready) return;
      this.events.fire('timeupdate', { currentTime: this.getTime() });
      // If the viewer unmuted through YouTube's own volume control, the muted
      // fallback is over — let the UI drop its "tap for sound" overlay.
      if (this.mutedFallback && this.yt && !this.yt.isMuted()) {
        this.mutedFallback = false;
        this.events.fire('autoplayblocked', { blocked: false });
      }
    }, 1000);
  }

  /** Browsers only allow unmuted autoplay after a qualifying user gesture, and a
   *  blocked `playVideo()` fails silently: the iframe just sits UNSTARTED — a
   *  black screen. So after asking for playback, verify it actually started; if
   *  not, fall back to muted playback (always allowed) and tell the UI. */
  private scheduleBlockCheck() {
    if (this.blockCheckTimer) clearTimeout(this.blockCheckTimer);
    this.blockCheckTimer = window.setTimeout(() => {
      this.blockCheckTimer = null;
      if (!this.ready || !this.yt || this.mutedFallback) return;
      const S = window.YT!.PlayerState;
      const state = this.yt.getPlayerState();
      // BUFFERING/PLAYING mean playback genuinely started; UNSTARTED or CUED
      // this long after a play request means the browser refused it.
      if (state !== S.UNSTARTED && state !== S.CUED) return;
      this.mutedFallback = true;
      this.withSuppression(() => {
        try {
          this.yt!.mute();
          this.yt!.playVideo();
        } catch {
          /* ignore */
        }
      });
      this.events.fire('autoplayblocked', { blocked: true });
    }, 1500);
  }

  private onStateChange(data: number) {
    if (this.suppress) return;
    const S = window.YT!.PlayerState;
    const ct = this.getTime();
    if (data === S.PLAYING) {
      this.events.fire('buffering', { buffering: false });
      this.events.fire('play', { currentTime: ct });
    } else if (data === S.PAUSED) {
      this.events.fire('pause', { currentTime: ct });
    } else if (data === S.BUFFERING) {
      this.events.fire('buffering', { buffering: true });
    } else if (data === S.ENDED) {
      this.events.fire('ended');
    }
  }

  unload() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.blockCheckTimer) {
      clearTimeout(this.blockCheckTimer);
      this.blockCheckTimer = null;
    }
    this.mutedFallback = false;
    if (this.yt) {
      try {
        this.yt.destroy();
      } catch {
        /* ignore */
      }
      this.yt = null;
    }
    this.mount.innerHTML = '';
    this.ready = false;
  }

  getTime() {
    try {
      return this.ready && this.yt ? this.yt.getCurrentTime() : 0;
    } catch {
      return 0;
    }
  }
  getRate() {
    try {
      return this.yt?.getPlaybackRate() || 1;
    } catch {
      return 1;
    }
  }
  isPaused() {
    try {
      return this.yt?.getPlayerState() !== window.YT!.PlayerState.PLAYING;
    } catch {
      return true;
    }
  }
  isSeeking() {
    try {
      return this.yt?.getPlayerState() === window.YT!.PlayerState.BUFFERING;
    } catch {
      return false;
    }
  }
  getTitle() {
    try {
      return this.yt?.getVideoData().title || null;
    } catch {
      return null;
    }
  }

  private withSuppression(fn: () => void) {
    this.suppress = true;
    try {
      fn();
    } finally {
      setTimeout(() => {
        this.suppress = false;
      }, 200);
    }
  }

  async applyState({ currentTime, paused, rate }: VideoStateApply) {
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        const h = () => {
          this.events.removeEventListener('ready', h);
          resolve();
        };
        this.events.addEventListener('ready', h);
      });
    }
    this.withSuppression(() => {
      try {
        if (Math.abs(this.getRate() - rate) > 0.001) this.yt!.setPlaybackRate(rate);
        if (Math.abs(this.getTime() - currentTime) > 0.6) this.yt!.seekTo(currentTime, true);
        if (paused) this.yt!.pauseVideo();
        else this.yt!.playVideo();
      } catch {
        /* ignore */
      }
    });
    if (!paused) this.scheduleBlockCheck();
  }

  resumeUnmuted() {
    this.mutedFallback = false;
    this.withSuppression(() => {
      try {
        this.yt!.unMute();
        this.yt!.playVideo();
      } catch {
        /* ignore */
      }
    });
    this.events.fire('autoplayblocked', { blocked: false });
  }

  setRate(rate: number) {
    try {
      this.yt?.setPlaybackRate(rate);
    } catch {
      /* ignore */
    }
  }

  setEnabled(enabled: boolean) {
    this.mount.style.pointerEvents = enabled ? '' : 'none';
  }

  toggleMute() {
    try {
      if (this.yt!.isMuted()) {
        this.yt!.unMute();
        return false;
      }
      this.yt!.mute();
      return true;
    } catch {
      return false;
    }
  }

  setVolume(v: number) {
    try {
      this.yt!.unMute();
      this.yt!.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100));
    } catch {
      /* ignore */
    }
  }

  seekBy(deltaSec: number) {
    try {
      this.yt!.seekTo(Math.max(0, this.getTime() + deltaSec), true);
    } catch {
      /* ignore */
    }
  }

  togglePlay() {
    try {
      if (this.isPaused()) this.yt!.playVideo();
      else this.yt!.pauseVideo();
    } catch {
      /* ignore */
    }
  }

  supportsPiP() {
    return false;
  }
  async togglePiP() {
    /* not supported for YouTube */
  }
}
