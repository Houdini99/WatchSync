// Sync engine. Translates authoritative server state → player state,
// drift-corrects against the heartbeat, and forwards player intents → server.
// The server is the source of truth; this engine only nudges the local player
// toward it, ignoring jitter below the drift tolerance to avoid stutter.
//
// Correcting position is deliberately graded. A seek is the most violent tool
// available: it drops the decoder back to the nearest keyframe *before* the
// target and re-buffers, so even a seek *forward* shows up as a visible jump
// backwards plus a stall. Seeking on every heartbeat therefore does not
// converge — the seek costs more playback time than the drift it repaired, so
// the next heartbeat sees a larger gap and seeks again. So:
//
//   • drift within tolerance          → leave it alone
//   • drift up to HARD_SEEK_SEC       → close it by playing fractionally
//                                       faster/slower (inaudible, no re-buffer)
//   • beyond that                     → one seek, then a cooldown long enough
//                                       for it to land before measuring again
//   • target not buffered yet         → we are starved, not desynced: hold the
//                                       room and wait for the data at its
//                                       position, paused
//   • room paused                     → line up on its position; a seek costs
//                                       nothing while nothing is playing

import type { ClientMsg, VideoView } from '../types';
import type { Player } from './players';

const LOCAL_ACTION_GRACE_MS = 2000;
const BUFFER_DEBOUNCE_MS = 500;
const LOAD_SETTLE_MS = 1500;
const READY_TAIL_MS = 800;

/** Drift above this is worth a seek; below it, the rate nudge does the work. */
const HARD_SEEK_SEC = 5;
/** After a corrective seek, ignore drift until it has landed and playback has
 *  re-established itself. Without this the next heartbeat measures a player
 *  that is still re-buffering, reads the gap the seek itself created, and seeks
 *  again — the runaway this constant exists to break. */
const SEEK_COOLDOWN_MS = 5000;
/** Largest deviation from the room's rate used to close drift smoothly. 10% is
 *  well below the threshold where pitch correction becomes audible. */
const MAX_NUDGE = 0.1;
/** Stop nudging once drift is inside this fraction of the tolerance, so the
 *  correction settles instead of oscillating around the tolerance boundary.
 *  Also the bar for lining up with a paused room. */
const NUDGE_RELEASE = 0.3;
/** A nudge has to close at least this much drift to count as making progress. */
const NUDGE_PROGRESS_SEC = 0.25;
/** Nudging this long without progress means the player cannot catch up under
 *  its own steam — the proxy is still muxing, or the connection is starved. */
const NUDGE_GIVE_UP_MS = 15000;

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
  // Buffering as the server sees it. Two things can hold the room for us: the
  // player reporting a stall, and the engine finding the room's position out of
  // reach (`starved`). The server hears their union, once per transition — two
  // sources writing one flag independently let either clear the other's hold.
  private playerBuffering = false;
  private starved = false;
  /** What the server was last told (buffering_start / buffering_end). */
  private bufferReported = false;
  private bufferTimer: number | null = null;
  /** True while we are deliberately off the room's rate to close drift. */
  private nudging = false;
  /** When the current nudge run last made progress, and how close it got — so a
   *  nudge that is not working escalates instead of running forever. */
  private nudgeSince = 0;
  private nudgeBest = Infinity;
  /** Set after a corrective seek; no further position work until it passes. */
  private seekCooldownUntil = 0;
  // While a freshly loaded player seeks/autoplays into position it fires
  // play/seek/rate events that are NOT user intent. Suppress *outgoing* intents
  // until things settle, or a late joiner's autoplay-at-0 echo would clobber the
  // room's real position. Incoming sync still applies normally.
  private suspendOutgoingUntil = 0;
  /** Newest room video state seen, so a late `ready` applies current state
   *  rather than replaying the snapshot captured when applyInitial was called. */
  private lastVideo: VideoView | null = null;
  /** Whether the room was paused as of the latest heartbeat or broadcast. */
  private roomPaused: boolean | null = null;
  /** Pending applyInitial 'ready' listener, so it can be removed. */
  private initialHook: { player: Player; ready: () => void } | null = null;

  private readonly send: (msg: ClientMsg) => void;

  constructor(send: (msg: ClientMsg) => void) {
    this.send = send;
  }

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
    // Normally the teardown before a mount already did this; it is idempotent.
    if (this.player) this.clearPlayer();
    this.player = player;
    this.nudging = false;
    this.seekCooldownUntil = 0;
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
    this.clearInitialHook();
    this.nudging = false;
    // Whatever held the room belonged to this player. Without it we are not
    // buffering anything, and the room must not go on waiting for us — a torn
    // down player (stream error, media change) never reports recovering.
    this.playerBuffering = false;
    this.starved = false;
    this.syncBuffering(true);
    this.player = null;
  }

  /** Call after every (re)join. The server forgets a seat's buffering state when
   *  its socket drops, and another tab of the same seat may have left it set, so
   *  state ours afresh rather than assume either survived. */
  onJoined() {
    this.cancelBufferTimer();
    this.bufferReported = this.playerBuffering || this.starved;
    this.send({ type: this.bufferReported ? 'buffering_start' : 'buffering_end' });
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

  /** Bring the server's view of our buffering in line with what holds us. Going
   *  into buffering is debounced, so a hiccup of a few hundred ms does not pause
   *  the whole room; coming out is immediate. */
  private syncBuffering(immediate = false) {
    const want = this.playerBuffering || this.starved;
    if (want === this.bufferReported) {
      this.cancelBufferTimer();
      return;
    }
    if (want && !immediate) {
      if (this.bufferTimer === null) {
        this.bufferTimer = window.setTimeout(() => {
          this.bufferTimer = null;
          this.syncBuffering(true);
        }, BUFFER_DEBOUNCE_MS);
      }
      return;
    }
    this.cancelBufferTimer();
    this.bufferReported = want;
    this.send({ type: want ? 'buffering_start' : 'buffering_end' });
  }

  private bindPlayer(player: Player) {
    const ev = player.events;
    // Events from a player that has since been replaced are history, not intent.
    const current = () => this.player === player;
    ev.addEventListener('play', (e) => {
      if (!current() || this.outgoingSuspended()) return;
      this.markLocalChange();
      this.send({ type: 'play_pause', paused: false, current_time: this.toContentTime(detail(e).currentTime) });
    });
    ev.addEventListener('pause', (e) => {
      if (!current() || this.outgoingSuspended()) return;
      // A page going into the background (phone locked, app switched) has its
      // media paused by the browser. That is not the viewer asking the room to
      // stop — forwarding it paused everyone the moment one person pocketed
      // their phone. The room plays on, and coming back resyncs (see
      // needsResyncOnVisible). The cost: pausing from a lock screen stays local.
      if (pageHidden()) return;
      this.markLocalChange();
      this.send({ type: 'play_pause', paused: true, current_time: this.toContentTime(detail(e).currentTime) });
    });
    ev.addEventListener('seek', (e) => {
      if (!current() || this.outgoingSuspended()) return;
      this.markLocalChange();
      // Report the seek target in content time. The server respawns ffmpeg at
      // this offset for proxied media, which reloads the stream client-side.
      this.send({ type: 'seek', current_time: this.toContentTime(detail(e).currentTime) });
    });
    ev.addEventListener('ratechange', (e) => {
      if (!current() || this.outgoingSuspended()) return;
      this.markLocalChange();
      this.send({ type: 'set_rate', rate: detail(e).rate });
    });
    ev.addEventListener('buffering', (e) => {
      if (!current()) return;
      this.playerBuffering = !!detail(e).buffering;
      this.syncBuffering();
    });
    // Every viewer's player fires `ended`; tag the skip with the media that
    // finished so the server advances the queue only once (see on_queue_skip).
    ev.addEventListener('ended', () => {
      if (!current()) return;
      this.send({ type: 'queue_skip', ended_media: this.mediaSource ?? undefined });
    });
  }

  /** Apply a full room_state broadcast. `causedBy` lets us skip our own echo. */
  onRoomState(video: VideoView, causedBy: string | null) {
    if (!this.player || !video.media) return;
    // Recorded even for our own echo: it is still the room's newest state, and a
    // late `ready` replaying anything older would undo our own action.
    this.lastVideo = video;
    this.roomPaused = video.paused;
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
    // A broadcast someone deliberately caused (play/pause/seek/rate/new media)
    // is intent — snap to it exactly. One with no actor is incidental: a viewer
    // joining or leaving, a title landing, the proxy going ready, the room
    // pausing for someone's buffering. Those carry no new position, and snapping
    // to their timestamp used to yank the player on every unrelated room event,
    // so they go through the drift gate instead.
    if (causedBy) this.apply(video);
    else this.track(video.current_time, video.paused, video.rate);
  }

  onHeartbeat(state: { current_time: number; paused: boolean; rate: number }) {
    this.roomPaused = state.paused;
    this.track(state.current_time, state.paused, state.rate);
  }

  /** Seek the room from the UI rather than from the player's own controls (a
   *  chat timestamp). Sent as intent directly — a seek made through the
   *  player API is not reliably reported by every adapter (YouTube raises no
   *  event for one made while paused) — and applied as our own, so the player
   *  does not echo it back as a second seek. */
  jumpTo(contentTime: number): boolean {
    const player = this.player;
    if (!player || this.live || !Number.isFinite(contentTime) || contentTime < 0) return false;
    this.markLocalChange();
    this.send({ type: 'seek', current_time: contentTime });
    player.applyState({
      currentTime: this.toStreamTime(contentTime),
      paused: this.roomPaused ?? player.isPaused(),
      rate: player.getRate(),
    });
    return true;
  }

  /** Call when the page becomes visible again. True if the browser paused us in
   *  the background while the room played on — the caller should then fetch a
   *  fresh snapshot and snap to it, rather than resume from where we stopped. */
  needsResyncOnVisible() {
    const player = this.player;
    return !!player && this.roomPaused === false && player.isPaused() && !player.isEnded();
  }

  /** Move the player toward the room's state as gently as the gap allows. */
  private track(contentTime: number, paused: boolean, rawRate: number) {
    const player = this.player;
    if (!player) return;
    if (this.inLocalGrace()) return;
    if (player.isSeeking()) return;
    const rate = rawRate || 1;
    const target =
      this.toStreamTime(contentTime) + (paused ? 0 : (this.latencyMs / 1000) * rate);
    const settled = this.driftTolerance * NUDGE_RELEASE;

    // Finished ahead of the room: hold the last frame. play() on an ended
    // element starts over from 0, so obeying "the room is playing" here
    // restarted the video for whoever reached the end first — and kept doing
    // so for as long as the room took to move on (a viewer's own skip is
    // refused in a locked room). The queue moves the room along; only a room
    // still well short of the end pulls us back into it.
    if (!paused && player.isEnded()) {
      if (!this.live && player.getTime() - target > HARD_SEEK_SEC && this.cooledDown()) {
        this.seekTo(target, false, rate);
      }
      return;
    }

    // Pause tracks the room immediately. Stopping is the one moment everyone
    // agrees on a position, and a seek costs nothing while paused, so a player
    // that is noticeably off lines up there — that is what lets a viewer the
    // room waited for rejoin exactly in step. Resuming starts from wherever we
    // are instead: a play disagreement is not evidence that the position is
    // wrong, and correcting both at once turned momentary flaps into jumps.
    if (player.isPaused() !== paused) {
      // Paused by the browser in the background while the room plays: leave it.
      // play() from a hidden page is refused or forced muted on mobile, and the
      // position is stale by the time anyone looks — needsResyncOnVisible
      // brings us back in one step when the page returns.
      if (!paused && pageHidden()) return;
      this.endNudge(rate);
      const lineUp = paused && !this.live && Math.abs(player.getTime() - target) > settled;
      player.applyState({ currentTime: lineUp ? target : player.getTime(), paused, rate });
      return; // measure again next tick, once the player has settled
    }

    // Rate tracks the room too, unless we are deliberately off-rate to converge.
    if (!this.nudging && Math.abs(player.getRate() - rate) > 0.001) player.setRate(rate);

    // A live stream has no shared scrub position — seeking to the server's
    // extrapolated time throws the player off the live edge and stalls it.
    if (this.live) return;

    // Let go of a starvation hold as soon as the room's position is playable —
    // typically while the room sits paused *because* of that hold, which is
    // precisely when nothing else would tell us to release it.
    if (this.starved && player.canPlayAt(target)) this.releaseStarved();
    if (!this.cooledDown()) return;

    const drift = player.getTime() - target; // > 0: we are ahead of the room
    const mag = Math.abs(drift);

    if (paused) {
      // Nothing is playing, so lining up costs a frame change at most — and if
      // we are the viewer being waited for, sitting at the room's position is
      // what makes the player fetch the data for it.
      if (mag > settled) this.seekTo(target, true, rate);
      return;
    }

    if (mag <= settled) {
      this.endNudge(rate);
      return;
    }
    if (mag <= this.driftTolerance) return;

    // Close a moderate gap by playing fractionally fast or slow: inaudible, and
    // with none of a seek's cost. A player that cannot vary its rate finely
    // (YouTube snaps to a fixed list of speeds) just tolerates drift this small
    // instead — with a correspondingly lower threshold before it does seek.
    if (player.canNudgeRate()) {
      if (mag <= HARD_SEEK_SEC && !this.nudgeExhausted(mag)) {
        this.nudge(drift, rate);
        return;
      }
    } else if (mag <= this.driftTolerance * 2) {
      return;
    }

    // Big gap, or a nudge that is getting nowhere: only a seek closes it.
    this.endNudge(rate);
    if (!player.canPlayAt(target)) {
      // Starved, not desynced: the proxy has not muxed that far yet, or the
      // network cannot keep up. Seeking there and playing on would stall, and
      // every later heartbeat would aim further ahead. Hold the room instead —
      // the server auto-pauses while anyone is buffering, which also stops its
      // clock running away — and wait at its position, paused: the player only
      // fetches around its own position, so this is what brings the data in.
      this.reportStarved();
      this.seekTo(target, true, rate);
      return;
    }
    this.seekTo(target, false, rate);
  }

  private cooledDown() {
    return Date.now() >= this.seekCooldownUntil;
  }

  /** One corrective seek, then leave the player alone while it lands. */
  private seekTo(time: number, paused: boolean, rate: number) {
    this.seekCooldownUntil = Date.now() + SEEK_COOLDOWN_MS;
    this.player?.applyState({ currentTime: time, paused, rate });
  }

  /** True once a nudge has run long enough without closing the gap. A player
   *  pinned to the edge of what has been muxed or downloaded keeps playing — it
   *  just cannot play *faster* — so leaning on the rate would hold it behind the
   *  room indefinitely with nobody any the wiser. */
  private nudgeExhausted(mag: number) {
    const now = Date.now();
    if (!this.nudging) {
      this.nudgeSince = now;
      this.nudgeBest = mag;
      return false;
    }
    if (mag < this.nudgeBest - NUDGE_PROGRESS_SEC) {
      this.nudgeBest = mag;
      this.nudgeSince = now;
      return false;
    }
    return now - this.nudgeSince > NUDGE_GIVE_UP_MS;
  }

  /** Close drift by playing fractionally fast or slow. Proportional to the gap
   *  and clamped, so it is never audible and never overshoots into a correction
   *  in the other direction. */
  private nudge(drift: number, roomRate: number) {
    const player = this.player;
    if (!player) return;
    const strength = Math.max(0.25, Math.min(1, Math.abs(drift) / HARD_SEEK_SEC));
    // Ahead of the room → play slower; behind → play faster.
    const wanted = roomRate * (1 + MAX_NUDGE * strength * (drift > 0 ? -1 : 1));
    this.nudging = true;
    if (Math.abs(player.getRate() - wanted) > 0.005) player.setRate(wanted);
  }

  /** Drop back to the room's rate after a nudge. */
  private endNudge(roomRate: number) {
    if (!this.nudging) return;
    this.nudging = false;
    this.nudgeBest = Infinity;
    const player = this.player;
    if (player && Math.abs(player.getRate() - roomRate) > 0.001) player.setRate(roomRate);
  }

  /** We cannot play the room's position because the data is not there yet. Tell
   *  the room at once, so it waits for us rather than running further ahead of
   *  a picture that is standing still. */
  private reportStarved() {
    if (this.starved) return;
    this.starved = true;
    this.syncBuffering(true);
  }

  /** Drop the hold from `reportStarved`. */
  private releaseStarved() {
    if (!this.starved) return;
    this.starved = false;
    this.syncBuffering();
  }

  private apply(video: VideoView) {
    const player = this.player;
    if (!player) return;
    this.lastVideo = video;
    this.roomPaused = video.paused;
    const rate = video.rate || 1;
    this.nudging = false;
    // A deliberate action supersedes the position we were holding out for. If
    // the new one is out of reach too, the player's stall detection says so.
    this.releaseStarved();
    if (this.live) {
      // Keep the live edge: pass the player's own time so no seek fires, while
      // pause + rate still track the room.
      player.applyState({ currentTime: player.getTime(), paused: video.paused, rate });
      return;
    }
    const target =
      this.toStreamTime(video.current_time) + (video.paused ? 0 : (this.latencyMs / 1000) * rate);
    // An intentional jump restarts the clock: don't let the heartbeat that lands
    // mid-seek read the gap as drift and stack a second correction on top.
    this.seekTo(target, video.paused, rate);
  }

  /** Snap straight to a given state once the player is ready (used on join). */
  applyInitial(video: VideoView) {
    if (!this.player || !video) return;
    const player = this.player;

    // Drop any pending 'ready' hook from a previous call. applyInitial runs on
    // joined, on sync_snapshot and on every mountPlayer, so without this each
    // call left another listener behind on players that never become ready.
    this.clearInitialHook();

    const ready = () => {
      this.clearInitialHook();
      // Re-read from the engine's live state instead of replaying the captured
      // snapshot. On slow media (hls.js playlist + first chunk) 'ready' can
      // arrive seconds after the snapshot was taken, and applying the stale
      // current_time produced a visible jump backwards that only the next
      // heartbeat repaired. Bind against the player this hook was registered
      // on, too — `this.player` may have been replaced by the time it fires.
      if (this.player === player) this.apply(this.lastVideo ?? video);
    };
    this.initialHook = { player, ready };
    player.events.addEventListener('ready', ready);

    // Some players are ready already — try once now too.
    this.apply(video);
  }

  /** Remove a pending applyInitial 'ready' listener, if one is registered. */
  private clearInitialHook() {
    if (!this.initialHook) return;
    this.initialHook.player.events.removeEventListener('ready', this.initialHook.ready);
    this.initialHook = null;
  }
}

function pageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// CustomEvent detail accessor with a permissive shape (player events are loose).
function detail(e: Event): { currentTime: number; rate: number; buffering: boolean } {
  return ((e as CustomEvent).detail || {}) as { currentTime: number; rate: number; buffering: boolean };
}
