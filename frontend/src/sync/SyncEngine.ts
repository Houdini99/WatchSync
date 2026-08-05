// Sync engine. Translates authoritative server state → player state,
// drift-corrects against the heartbeat, and forwards player intents → server.
// The server is the source of truth; this engine only nudges the local player
// toward it, ignoring jitter below the drift tolerance to avoid stutter.

import type { ClientMsg, VideoView } from '../types';
import type { Player } from './players';

const LOCAL_ACTION_GRACE_MS = 2000;
const BUFFER_DEBOUNCE_MS = 500;
const LOAD_SETTLE_MS = 1500;
const READY_TAIL_MS = 800;

export class SyncEngine {
  player: Player | null = null;
  latencyMs = 0;
  /** This connection's id, so we can ignore the echo of our own actions. */
  connId: string | null = null;

  private driftTolerance = 1.5;
  /** Live streams have no shared scrub position — only play/pause + rate sync. */
  private live = false;
  // The server is authoritative in *content* time. For media played through the
  // server-side HLS proxy, ffmpeg is (re)started at `-ss streamOffset`, so the
  // local player timeline starts at 0 == content-second `streamOffset`. We map
  // content↔stream time by this offset at every boundary (0 for YouTube/native).
  private streamOffset = 0;
  /** Source of the media currently loaded, tagged onto the auto-advance skip so
   *  the server can ignore duplicate `ended` skips from other viewers. */
  private mediaSource: string | null = null;
  private lastLocalChange = 0;
  private bufferTimer: number | null = null;
  private bufferState = false;
  // While a freshly loaded player seeks/autoplays into position it fires
  // play/seek/rate events that are NOT user intent. Suppress *outgoing* intents
  // until things settle, or a late joiner's autoplay-at-0 echo would clobber the
  // room's real position. Incoming sync still applies normally.
  private suspendOutgoingUntil = 0;

  constructor(private readonly send: (msg: ClientMsg) => void) {}

  setDriftTolerance(sec: number) {
    if (Number.isFinite(sec) && sec > 0) this.driftTolerance = sec;
  }

  /** Flag the active media as a live stream (set before `setPlayer`). */
  setLive(live: boolean) {
    this.live = live;
  }

  /** Record the current media's source, tagged onto the auto-advance skip. */
  setMediaSource(source: string | null) {
    this.mediaSource = source;
  }

  /** Content-second the local stream timeline starts at (proxy `-ss` offset).
   *  0 for YouTube and direct native playback. Set before `setPlayer`/heartbeats
   *  whenever the active stream's offset changes (i.e. after a seek-respawn). */
  setStreamOffset(offset: number) {
    this.streamOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  }

  /** content time (server) → local player/stream time. */
  private toStreamTime(contentTime: number) {
    return contentTime - this.streamOffset;
  }
  /** local player/stream time → content time (server). */
  private toContentTime(streamTime: number) {
    return streamTime + this.streamOffset;
  }

  setPlayer(player: Player) {
    this.player = player;
    this.cancelBufferTimer();
    this.bufferState = false;
    // Suspend outgoing intents while the new player loads and seeks into place.
    this.suspendOutgoingUntil = Date.now() + LOAD_SETTLE_MS;
    const onReady = () => {
      player.events.removeEventListener('ready', onReady);
      this.suspendOutgoingUntil = Math.max(this.suspendOutgoingUntil, Date.now() + READY_TAIL_MS);
    };
    player.events.addEventListener('ready', onReady);
    this.bindPlayer(player);
  }

  clearPlayer() {
    this.cancelBufferTimer();
    this.player = null;
  }

  private markLocalChange() {
    this.lastLocalChange = Date.now();
  }
  private inLocalGrace() {
    return Date.now() - this.lastLocalChange < LOCAL_ACTION_GRACE_MS;
  }
  private outgoingSuspended() {
    return Date.now() < this.suspendOutgoingUntil;
  }
  private cancelBufferTimer() {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  private bindPlayer(player: Player) {
    const ev = player.events;
    ev.addEventListener('play', (e) => {
      if (this.outgoingSuspended()) return;
      this.markLocalChange();
      this.send({ type: 'play_pause', paused: false, current_time: this.toContentTime(detail(e).currentTime) });
    });
    ev.addEventListener('pause', (e) => {
      if (this.outgoingSuspended()) return;
      this.markLocalChange();
      this.send({ type: 'play_pause', paused: true, current_time: this.toContentTime(detail(e).currentTime) });
    });
    ev.addEventListener('seek', (e) => {
      if (this.outgoingSuspended()) return;
      this.markLocalChange();
      // Report the seek target in content time. The server respawns ffmpeg at
      // this offset for proxied media, which reloads the stream client-side.
      this.send({ type: 'seek', current_time: this.toContentTime(detail(e).currentTime) });
    });
    ev.addEventListener('ratechange', (e) => {
      if (this.outgoingSuspended()) return;
      this.markLocalChange();
      this.send({ type: 'set_rate', rate: detail(e).rate });
    });
    ev.addEventListener('buffering', (e) => {
      const buffering = !!detail(e).buffering;
      this.cancelBufferTimer();
      if (buffering) {
        this.bufferTimer = window.setTimeout(() => {
          if (this.bufferState) return;
          this.bufferState = true;
          this.send({ type: 'buffering_start' });
        }, BUFFER_DEBOUNCE_MS);
      } else if (this.bufferState) {
        this.bufferState = false;
        this.send({ type: 'buffering_end' });
      }
    });
    // Every viewer's player fires `ended`; tag the skip with the media that
    // finished so the server advances the queue only once (see on_queue_skip).
    ev.addEventListener('ended', () =>
      this.send({ type: 'queue_skip', ended_media: this.mediaSource ?? undefined }),
    );
  }

  /** Apply a full room_state broadcast. `causedBy` lets us skip our own echo. */
  onRoomState(video: VideoView, causedBy: string | null) {
    if (!this.player || !video.media) return;
    if (causedBy && causedBy === this.connId) return;
    if (this.inLocalGrace()) {
      // Mid local action: respect a pause flip by others, but don't trust their position.
      if (this.player.isPaused() !== video.paused) {
        this.player.applyState({
          currentTime: this.player.getTime(),
          paused: video.paused,
          rate: video.rate,
        });
      }
      return;
    }
    this.apply(video);
  }

  onHeartbeat(state: { current_time: number; paused: boolean; rate: number }) {
    if (!this.player) return;
    if (this.inLocalGrace()) return;
    if (this.player.isSeeking()) return;
    const rate = state.rate || 1;
    if (this.live) {
      // Don't drift-correct position on a live stream (seeking to the server's
      // extrapolated time throws the player off the live edge and stalls it);
      // only mirror pause + rate.
      const rateOff = Math.abs(this.player.getRate() - rate) > 0.001;
      if (this.player.isPaused() !== state.paused || rateOff) {
        this.player.applyState({ currentTime: this.player.getTime(), paused: state.paused, rate });
      }
      return;
    }
    const live =
      this.toStreamTime(state.current_time) + (state.paused ? 0 : (this.latencyMs / 1000) * rate);
    const diff = Math.abs(this.player.getTime() - live);
    const rateOff = Math.abs(this.player.getRate() - rate) > 0.001;
    if (diff > this.driftTolerance || this.player.isPaused() !== state.paused || rateOff) {
      this.player.applyState({ currentTime: live, paused: state.paused, rate });
    }
  }

  private apply(video: VideoView) {
    const rate = video.rate || 1;
    if (this.live) {
      // Keep the live edge: pass the player's own time so no seek fires, while
      // pause + rate still track the room.
      this.player!.applyState({ currentTime: this.player!.getTime(), paused: video.paused, rate });
      return;
    }
    const live =
      this.toStreamTime(video.current_time) + (video.paused ? 0 : (this.latencyMs / 1000) * rate);
    this.player!.applyState({ currentTime: live, paused: video.paused, rate });
  }

  /** Snap straight to a given state once the player is ready (used on join). */
  applyInitial(video: VideoView) {
    if (!this.player || !video) return;
    const apply = () => this.apply(video);
    const ready = () => {
      this.player!.events.removeEventListener('ready', ready);
      apply();
    };
    this.player.events.addEventListener('ready', ready);
    // Some players may already be ready — try once now too.
    apply();
  }
}

// CustomEvent detail accessor with a permissive shape (player events are loose).
function detail(e: Event): { currentTime: number; rate: number; buffering: boolean } {
  return ((e as CustomEvent).detail || {}) as { currentTime: number; rate: number; buffering: boolean };
}
