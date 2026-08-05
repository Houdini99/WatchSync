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
  getTitle(): string | null;
  applyState(state: VideoStateApply): void | Promise<void>;
  setRate(rate: number): void;
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
