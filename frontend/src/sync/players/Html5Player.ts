import type Hls from 'hls.js';
import type { Media } from '../../types';
import { PlayerEvents, type Player, type VideoStateApply } from './types';

/** How often the stall watchdog samples the playback clock. */
const STALL_POLL_MS = 500;
/** Playback frozen this long, while it should be running, counts as buffering. */
const STALL_AFTER_MS = 1000;
/** A correction seek needs this much buffered past its target to be worth it. */
const SEEK_RUNWAY_SEC = 1;
/** `seeked` events closer together than this are one gesture (a scrub, or an
 *  arrow key pressed twice); the room hears where it started and where it ended. */
const SEEK_BURST_MS = 250;
/** A `ratechange` matching a rate we set ourselves this recently is ours. */
const OWN_RATE_WINDOW_MS = 1500;
/** HTMLMediaElement.HAVE_FUTURE_DATA, spelled out so this module does not need
 *  the DOM constructor at load time. */
const HAVE_FUTURE_DATA = 3;
/** A `currentTime` write is followed by its `seeking` event within a task or
 *  two. If none has come after this long, none is coming. */
const OWN_SEEK_EXPIRY_MS = 10000;

/** Whether Media Source Extensions exist, i.e. hls.js has something to run on. */
function hasMediaSource() {
  return typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window);
}

/** Native `<video>` playback, with HLS.js for `.m3u8` (the browser's own HLS
 *  support only where hls.js cannot run). */
export class Html5Player implements Player {
  readonly events = new PlayerEvents();
  private suppress = false;
  private hls: Hls | null = null;
  private lastSeek = 0;
  private seekTrailTimer: number | null = null;
  private destroyed = false;
  // Seeks that are not the viewer's: our own corrections, and hls.js stepping
  // over buffer holes. Their `seeked` must not be reported, or the room is
  // dragged to wherever the correction happened to land. On HLS that `seeked`
  // comes only once the target segment has buffered — seconds later on a slow
  // link — so it is matched by counting `seeking` events, not by a timer: the
  // old 4s timer let a correction that took longer land as a "user seek" that
  // pulled the whole room back to the stalled viewer's position.
  /** `seeking` events still due from writes of ours. */
  private ownSeeksDue = 0;
  /** The seek in progress is one of ours. */
  private ownSeekInFlight = false;
  private ownSeeksTimer: number | null = null;
  private programmaticSeekAt = 0;
  /** Rate we last set ourselves, and when. Its `ratechange` is filtered by value
   *  rather than by the blanket `suppress` window: the engine adjusts the rate
   *  often while it closes drift, and that window also swallows any real
   *  play/pause/seek that happens to land inside it. */
  private ownRate: number | null = null;
  private ownRateAt = 0;
  /** True while we're playing muted because the browser blocked unmuted autoplay. */
  private mutedFallback = false;
  /** Last buffering state reported, so listeners only ever see transitions. */
  private buffering = false;
  // Stall watchdog. `waiting` is suppressed right after our own correction seeks
  // (see below) and some stalls never fire it at all, so a starving player could
  // sit frozen while the room kept counting — and every heartbeat then aimed a
  // seek further past the end of the data. Watching the clock catches all of it:
  // playback that is meant to be running but is not advancing is buffering,
  // whatever the element chose to report.
  private stallTimer: number | null = null;
  private lastPos = 0;
  private lastPosAt = 0;

  /**
   * Every listener this instance attached, so `unload()` can detach them.
   *
   * This matters more than ordinary hygiene: the <video> element is created
   * once by React and SHARED by every Html5Player, and client.mountPlayer
   * builds a fresh instance on each media change *and each seek* (the server
   * respawns ffmpeg, so stream.path gains a new ?g=). A stale instance left
   * listening on the shared element still fires into SyncEngine's long-lived
   * handlers, and its own `suppress` flag is false — so when a REMOTE pause
   * was applied under withSuppression(), only the current instance stayed
   * quiet and every stale one echoed a play_pause back to the server with its
   * own currentTime. Drift corrections looped the same way: stale instances
   * reported them as user seeks, the server respawned ffmpeg, which minted yet
   * another stale instance.
   */
  private readonly listeners: Array<[string, EventListener]> = [];

  private on(type: string, handler: EventListener) {
    this.listeners.push([type, handler]);
    this.video.addEventListener(type, handler);
  }

  private readonly video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    this.on('play', () => {
      if (this.suppress || video.seeking) return;
      this.events.fire('play', { currentTime: video.currentTime });
    });
    this.on('pause', () => {
      // A failing element pauses itself; that is a broken player, not the
      // viewer asking the room to stop — forwarded, it paused everyone.
      if (this.suppress || video.seeking || video.error) return;
      this.events.fire('pause', { currentTime: video.currentTime });
    });
    this.on('seeking', () => {
      if (this.ownSeeksDue > 0) {
        this.ownSeeksDue--;
        this.ownSeekInFlight = true;
      } else {
        // The viewer seeking — possibly over one of ours still in flight,
        // which it then supersedes.
        this.ownSeekInFlight = false;
      }
    });
    this.on('seeked', () => {
      if (this.ownSeekInFlight) {
        this.ownSeekInFlight = false;
        return;
      }
      if (this.suppress) return;
      this.reportSeek();
    });
    // A reset element has no seeks in flight.
    this.on('emptied', () => {
      this.ownSeeksDue = 0;
      this.ownSeekInFlight = false;
    });
    this.on('ratechange', () => {
      if (this.suppress) return;
      const own =
        this.ownRate !== null &&
        Math.abs(video.playbackRate - this.ownRate) < 0.001 &&
        Date.now() - this.ownRateAt < OWN_RATE_WINDOW_MS;
      if (own) return;
      this.events.fire('ratechange', { rate: video.playbackRate });
    });
    this.on('waiting', () => {
      // A short re-buffer right after our own correction seek is expected — don't
      // report it, or the room would auto-pause itself on every drift fix. A
      // paused element "waits" while it loads a seek target, which is not a stall
      // either; checkStall decides for a paused player.
      if (video.paused || Date.now() - this.programmaticSeekAt < 2000) return;
      this.setBuffering(true);
    });
    this.on('playing', () => this.setBuffering(false));
    this.on('ended', () => this.events.fire('ended'));
    this.on('volumechange', () => {
      // Viewer unmuted via the native controls — the muted fallback is over.
      if (this.mutedFallback && !video.muted) {
        this.mutedFallback = false;
        this.events.fire('autoplayblocked', { blocked: false });
      }
    });
    this.on('loadedmetadata', () => this.events.fire('ready'));
    this.on('error', () => this.events.fire('mediaerror', { code: video.error?.code }));

    this.lastPos = video.currentTime || 0;
    this.lastPosAt = Date.now();
    this.stallTimer = window.setInterval(() => this.checkStall(), STALL_POLL_MS);
  }

  private setBuffering(buffering: boolean) {
    if (this.buffering === buffering) return;
    this.buffering = buffering;
    this.events.fire('buffering', { buffering });
  }

  /** Derive buffering from the position clock rather than trusting `waiting`. */
  private checkStall() {
    if (this.destroyed) return;
    const v = this.video;
    const now = Date.now();
    const t = v.currentTime || 0;
    if (v.paused || v.ended) {
      this.lastPos = t;
      this.lastPosAt = now;
      // Paused — quite possibly by the room, waiting for us. Only a player that
      // could actually resume counts as recovered: clearing on the pause itself
      // released the room straight back into the same stall, over and over.
      if (v.ended || (!v.seeking && v.readyState >= HAVE_FUTURE_DATA)) this.setBuffering(false);
      return;
    }
    if (Math.abs(t - this.lastPos) > 0.02) {
      this.lastPos = t;
      this.lastPosAt = now;
      // A seek moves the clock without playing anything; only real progress
      // ends a stall.
      if (!v.seeking) this.setBuffering(false);
      return;
    }
    // Includes a seek that takes this long to land: the room is playing on
    // without us either way.
    if (now - this.lastPosAt > STALL_AFTER_MS) this.setBuffering(true);
  }

  /** Report a user seek. The first of a burst goes out at once; the rest
   *  collapse into one trailing report of where the burst ended. They used to
   *  be dropped outright, so a quick second arrow-key press never reached the
   *  room and the next heartbeat yanked the viewer back. */
  private reportSeek() {
    const now = Date.now();
    if (this.seekTrailTimer === null && now - this.lastSeek >= SEEK_BURST_MS) {
      this.lastSeek = now;
      this.events.fire('seek', { currentTime: this.video.currentTime });
      return;
    }
    if (this.seekTrailTimer !== null) clearTimeout(this.seekTrailTimer);
    this.seekTrailTimer = window.setTimeout(() => {
      this.seekTrailTimer = null;
      if (this.destroyed) return;
      this.lastSeek = Date.now();
      this.events.fire('seek', { currentTime: this.video.currentTime });
    }, SEEK_BURST_MS);
  }

  load(media: Media) {
    this.destroyHls();
    if (media.kind !== 'hls') {
      this.video.src = media.source;
      return;
    }
    // hls.js first, wherever it can run. Checking the browser's own HLS support
    // first used to mean "Safari", but Chrome now answers canPlayType for HLS
    // with "maybe" too — and its built-in player fails on the proxy's playlists
    // while ffmpeg is still writing them (an EVENT playlist, no ENDLIST yet):
    // it jumps to the live edge and dies with DEMUXER_ERROR_COULD_NOT_PARSE.
    // The browser's player remains the fallback where hls.js has no MSE to run
    // on (older iOS), and HLS.js itself stays lazy — fetched only when an HLS
    // stream actually plays.
    if (hasMediaSource()) void this.loadHls(media.source);
    else this.loadNativeHls(media.source);
  }

  private loadNativeHls(source: string) {
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) this.video.src = source;
    else this.events.fire('mediaerror', { code: 'hls-unsupported' });
  }

  private async loadHls(source: string) {
    const { default: Hls } = await import('hls.js');
    // The player may have been torn down while the chunk was loading.
    if (this.destroyed) return;
    if (!Hls.isSupported()) {
      this.loadNativeHls(source);
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
      if (this.hls !== hls) return;
      // hls.js stepping the playhead over a hole in the buffer. It raises
      // these right after writing currentTime, before the resulting `seeking`
      // event, so the seek can be claimed as not the viewer's.
      if (
        data.details === Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE ||
        data.details === Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL
      ) {
        this.expectOwnSeek();
      }
      if (!data.fatal) return;
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
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.seekTrailTimer !== null) {
      clearTimeout(this.seekTrailTimer);
      this.seekTrailTimer = null;
    }
    // Detach first: everything below (removeAttribute + load()) provokes
    // events on the shared element, and this instance must not report them.
    for (const [type, handler] of this.listeners) {
      this.video.removeEventListener(type, handler);
    }
    this.listeners.length = 0;
    if (this.ownSeeksTimer !== null) {
      clearTimeout(this.ownSeeksTimer);
      this.ownSeeksTimer = null;
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
  isEnded() {
    return this.video.ended;
  }
  getTitle() {
    return null;
  }
  canNudgeRate() {
    return true;
  }

  /** True when `time` sits inside a buffered range with some runway left.
   *  With the server-side proxy the playlist is still growing, so the room's
   *  position is routinely ahead of the last muxed segment; seeking there and
   *  playing on stalls the element instead of catching up. */
  canPlayAt(time: number) {
    const b = this.video.buffered;
    if (!b || b.length === 0) return false;
    for (let i = 0; i < b.length; i++) {
      if (time >= b.start(i) && time <= b.end(i) - SEEK_RUNWAY_SEC) return true;
    }
    return false;
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

  /** Claim the `seeking` event the next `currentTime` write will cause, so the
   *  `seeked` ending it — however late — is not reported as the viewer's. The
   *  expiry only forgets writes that never produced a `seeking` at all, so a
   *  later genuine seek is never swallowed. */
  private expectOwnSeek() {
    this.ownSeeksDue++;
    if (this.ownSeeksTimer !== null) clearTimeout(this.ownSeeksTimer);
    this.ownSeeksTimer = window.setTimeout(() => {
      this.ownSeeksDue = 0;
      this.ownSeeksTimer = null;
    }, OWN_SEEK_EXPIRY_MS);
  }

  applyState({ currentTime, paused, rate }: VideoStateApply) {
    if (Math.abs(this.video.playbackRate - rate) > 0.001) this.setRate(rate);
    this.withSuppression(() => {
      let seeked = false;
      if (Math.abs(this.video.currentTime - currentTime) > 0.4) {
        this.programmaticSeekAt = Date.now();
        this.expectOwnSeek();
        try {
          this.video.currentTime = currentTime;
          seeked = true;
        } catch {
          this.ownSeeksDue = Math.max(0, this.ownSeeksDue - 1);
        }
      }
      if (paused && !this.video.paused) {
        this.video.pause();
      } else if (!paused && this.video.paused && (seeked || !this.video.ended)) {
        // play() on an ended element restarts from 0, which is never what the
        // room means; a seek back into the video above clears `ended` first.
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

  /** Programmatic rate: the engine tracking the room or nudging to close drift,
   *  never the viewer picking a speed (the speed menu sends its own set_rate).
   *  Without the filter every nudge was broadcast to the room as a speed change. */
  setRate(rate: number) {
    if (Math.abs(this.video.playbackRate - rate) < 0.001) return; // no event coming
    this.ownRate = rate;
    this.ownRateAt = Date.now();
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
