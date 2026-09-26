import type { Media } from '../../types';
import { PlayerEvents, type Player, type VideoStateApply } from './types';

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';
/** An `onPlaybackRateChange` matching a rate we set ourselves this recently is
 *  ours. Generous: the event crosses the iframe boundary via postMessage. */
const OWN_RATE_WINDOW_MS = 2000;
/** Shared across adapter instances: the API is a page-global, loaded once. */
let apiPromise: Promise<boolean> | null = null;

/** Fetch the IFrame API, on demand and exactly once.
 *
 *  It is deliberately not in index.html: loading it eagerly sends every
 *  visitor's IP to Google before they have played anything, which is neither
 *  necessary for the page nor easy to justify under Art. 6(1)(f) GDPR (see the
 *  privacy policy, §7.1). Here the request only happens once someone actually
 *  puts a YouTube video on — the function they asked for.
 *
 *  Resolves `false` if the script can't be fetched (a content blocker, or no
 *  network), so the caller can surface an error instead of hanging forever. */
function loadApi(): Promise<boolean> {
  if (window.YT?.Player) return Promise.resolve(true);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<boolean>((resolve) => {
    // The API invokes this global once it has finished initialising. Chain any
    // previously registered handler rather than clobbering it.
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(true);
    };
    const tag = document.createElement('script');
    tag.src = IFRAME_API_SRC;
    tag.async = true;
    tag.onerror = () => {
      apiPromise = null; // let a later attempt retry
      resolve(false);
    };
    document.head.appendChild(tag);
  });
  return apiPromise;
}

/** YouTube playback via the IFrame API (fetched on demand — see `loadApi`). */
export class YouTubePlayer implements Player {
  readonly events = new PlayerEvents();
  private yt: YTPlayer | null = null;
  private suppress = false;
  private ready = false;
  private pollTimer: number | null = null;
  private blockCheckTimer: number | null = null;
  /** True while we're playing muted because the browser blocked unmuted autoplay. */
  private mutedFallback = false;
  /** Rate we last set ourselves, and when — see `setRate`. */
  private ownRate: number | null = null;
  private ownRateAt = 0;
  /** Bumped per `load()`; `unload()` disposes. Both are checked after the API
   *  await so a superseded or torn-down load doesn't build an iframe anyway. */
  private loadSeq = 0;
  private disposed = false;

  private readonly mount: HTMLElement;

  constructor(mount: HTMLElement) {
    this.mount = mount;
  }

  async load(media: Media) {
    const seq = ++this.loadSeq;
    this.disposed = false;
    this.mount.innerHTML = '<div id="yt-iframe-target"></div>';
    const ok = await this.waitForApi();

    // On the first YouTube video of a session that await spans a real network
    // round trip, so the adapter may have been torn down or replaced meanwhile.
    if (this.disposed || seq !== this.loadSeq) return;
    if (!ok) {
      this.events.fire('mediaerror', { code: -1 });
      return;
    }

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
          if (this.suppress || this.isOwnRate(e.data)) return;
          this.events.fire('ratechange', { rate: e.data });
        },
        onError: (e) => this.events.fire('mediaerror', { code: e.data }),
      },
    });
  }

  private waitForApi(): Promise<boolean> {
    return loadApi();
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
    this.disposed = true;
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
  isEnded() {
    try {
      return this.yt?.getPlayerState() === window.YT!.PlayerState.ENDED;
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

  /** YouTube only accepts the speeds in `getAvailablePlaybackRates()` — coarse
   *  steps like 1.25× — so it cannot play *slightly* fast to close drift. The
   *  engine falls back to a (cooled-down) seek for this player. */
  canNudgeRate() {
    return false;
  }

  /** The IFrame player owns its buffer and seeks anywhere in the video on its
   *  own, so there is no hole to protect the engine from here. */
  canPlayAt() {
    return true;
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
      // Bail rather than wait. SyncEngine.onHeartbeat calls this on EVERY
      // heartbeat, and for a video that never becomes ready (blocked embed,
      // content blocker, deleted video — onError fires, 'ready' never does)
      // every call used to add a permanent 'ready' listener plus a promise
      // that never settled. Nothing collected them: the engine does not await
      // the return value, since Player.applyState is typed `void |
      // Promise<void>`. They accumulated for as long as the room stayed on
      // that video, and if 'ready' ever did arrive, a burst of queued seekTo
      // calls with long-stale timestamps ran at once.
      //
      // Dropping the update costs nothing: the next heartbeat re-sends it, and
      // SyncEngine.applyInitial already re-applies on 'ready'.
      return;
    }
    if (Math.abs(this.getRate() - rate) > 0.001) this.setRate(rate);
    this.withSuppression(() => {
      try {
        let seeked = false;
        if (Math.abs(this.getTime() - currentTime) > 0.6) {
          this.yt!.seekTo(currentTime, true);
          seeked = true;
        }
        if (paused) this.yt!.pauseVideo();
        // playVideo() on an ENDED player starts over from 0 — never what the
        // room means. A seek back into the video above leaves ENDED first.
        else if (seeked || !this.isEnded()) this.yt!.playVideo();
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

  /** Programmatic rate: the engine tracking the room, never the viewer picking
   *  a speed (the speed menu sends its own set_rate). Its change event is
   *  filtered by value (`isOwnRate`) rather than through `withSuppression`,
   *  whose window would also swallow a genuine play/pause landing inside it. */
  setRate(rate: number) {
    this.ownRate = rate;
    this.ownRateAt = Date.now();
    try {
      this.yt?.setPlaybackRate(rate);
    } catch {
      /* ignore */
    }
  }

  private isOwnRate(rate: number) {
    return (
      this.ownRate !== null &&
      Math.abs(rate - this.ownRate) < 0.001 &&
      Date.now() - this.ownRateAt < OWN_RATE_WINDOW_MS
    );
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
