import type { Media } from '../../types';

export interface VideoStateApply {
  currentTime: number;
  paused: boolean;
  rate: number;
}

/** Typed event bus shared by both player adapters. */
export class PlayerEvents extends EventTarget {
  fire(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/**
 * Common surface over the HTML5/HLS and YouTube players. The sync engine talks
 * to this interface only — it never knows which concrete player is mounted.
 *
 * Emitted events: play, pause, seek, ratechange, buffering, timeupdate, ready,
 * ended, mediaerror, autoplayblocked (detail: { blocked: boolean } — fired with
 * blocked:true when the browser refused unmuted autoplay and the player fell
 * back to muted playback, and with blocked:false once sound is restored).
 */
export interface Player {
  readonly events: PlayerEvents;
  load(media: Media): void | Promise<void>;
  unload(): void;
  getTime(): number;
  getRate(): number;
  isPaused(): boolean;
  isSeeking(): boolean;
  /** At the end of the media. Such a player must not be told to "play": both
   *  adapters would restart from 0 rather than resume. */
  isEnded(): boolean;
  getTitle(): string | null;
  applyState(state: VideoStateApply): void | Promise<void>;
  /** Set the playback rate programmatically. Must NOT surface as a `ratechange`
   *  intent — the sync engine calls this to track the room and to nudge the rate
   *  while closing drift, and neither is the viewer asking for a speed change. */
  setRate(rate: number): void;
  /** True when arbitrary fractional rates are usable, so the engine can close
   *  small drift by playing slightly fast/slow instead of seeking. False for
   *  players that snap to a fixed list of speeds (YouTube). */
  canNudgeRate(): boolean;
  /** Whether `time` is buffered well enough to play from right now. Guards the
   *  engine against "correcting" into a hole: for the server-side HLS proxy the
   *  room's position can be ahead of what ffmpeg has muxed, and seeking there
   *  and playing on just stalls. When this is false the engine holds the room
   *  and waits at that position, paused, until it turns true. Players that
   *  manage their own buffer and handle arbitrary seeks return true. */
  canPlayAt(time: number): boolean;
  setEnabled(enabled: boolean): void;
  toggleMute(): boolean;
  setVolume(v: number): void;
  /** Unmute and resume playback. Call from a user gesture (e.g. the "tap for
   *  sound" overlay) after an `autoplayblocked` muted fallback. */
  resumeUnmuted(): void;
  seekBy(deltaSec: number): void;
  togglePlay(): void;
  supportsPiP(): boolean;
  togglePiP(): void | Promise<void>;
}
