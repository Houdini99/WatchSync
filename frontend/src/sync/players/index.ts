import type { Media } from '../../types';
import { Html5Player } from './Html5Player';
import { YouTubePlayer } from './YouTubePlayer';
import type { Player } from './types';

export type { Player } from './types';

/** Pick the right player adapter for a given media kind. */
export function pickPlayer(
  media: Media,
  mounts: { video: HTMLVideoElement; ytMount: HTMLElement },
): Player {
  if (media.kind === 'youtube') return new YouTubePlayer(mounts.ytMount);
  return new Html5Player(mounts.video);
}
