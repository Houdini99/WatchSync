import { useEffect, useRef } from 'react';
import { client } from '../client';
import { PLAYER_SURFACE_ID } from '../lib/fullscreen';
import { useStore } from '../store';
import CaptionsMenu from './CaptionsMenu';

export default function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytRef = useRef<HTMLDivElement>(null);

  const media = useStore((s) => s.media);
  const locked = useStore((s) => s.locked);
  const isHost = useStore((s) => s.isHost);
  const lockedForViewer = locked && !isHost;

  // Proxy-stream signals: a new path means a (re)spawn (e.g. seek); ready/error
  // gate when the HLS playlist can actually be loaded.
  const streamPath = useStore((s) => s.stream?.path ?? null);
  const streamReady = useStore((s) => s.stream?.ready ?? false);
  const streamError = useStore((s) => s.stream?.error ?? false);

  // React owns which surface is visible (see index.css for why inline display).
  const showVideo = !!media && media.kind !== 'youtube';
  const showYt = !!media && media.kind === 'youtube';

  // Register the DOM mount points with the controller (once).
  useEffect(() => {
    if (videoRef.current && ytRef.current) client.setMounts(videoRef.current, ytRef.current);
  }, []);

  // Reconcile the active player with the room's current media + proxy stream.
  useEffect(() => {
    client.reconcilePlayer();
  }, [media?.source, media?.kind, streamPath, streamReady, streamError]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply control lock to the live player.
  useEffect(() => {
    client.applyLockToPlayer();
  }, [locked, isHost]);

  return (
    <div
      id={PLAYER_SURFACE_ID}
      className={`player-surface relative min-h-0 flex-1 overflow-hidden rounded-[10px] bg-black ${
        lockedForViewer ? 'locked-controls' : ''
      }`}
    >
      <video ref={videoRef} controls playsInline style={{ display: showVideo ? 'block' : 'none' }} />
      <div ref={ytRef} className="yt-mount" style={{ display: showYt ? 'block' : 'none' }} />

      {!media && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-dim">
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-border text-xl">
              ▶
            </div>
            <p>Paste a YouTube or direct video URL below to begin.</p>
          </div>
        </div>
      )}

      <CaptionOverlay />
      <CaptionsMenu />
      <ReactionLayer />
      <UnmuteOverlay />

      {lockedForViewer && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[6] rounded-md bg-black/65 px-2.5 py-1 text-sm text-slate-300">
          🔒 Host has locked controls
        </div>
      )}
    </div>
  );
}

/** Shown when the browser blocked unmuted autoplay and the player fell back to
 *  muted playback. The click is the user gesture that lets us restore sound. */
function UnmuteOverlay() {
  const blocked = useStore((s) => s.autoplayBlocked);
  if (!blocked) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-[7] flex justify-center">
      <button
        type="button"
        onClick={() => client.resumeWithSound()}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/75 px-4 py-2 font-medium text-white shadow-lg backdrop-blur-sm transition hover:bg-black/90"
      >
        🔇 Playing muted — tap for sound
      </button>
    </div>
  );
}

/** The active subtitle cue, rendered above the player (lib/captions.ts drives
 *  the text). Sits inside the fullscreen surface so it survives fullscreen. */
function CaptionOverlay() {
  const text = useStore((s) => s.captionText);
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[9%] z-[6] flex justify-center px-4">
      <div
        className="max-w-[88%] whitespace-pre-line rounded bg-black/75 px-2.5 py-1 text-center font-medium text-white"
        style={{ fontSize: 'clamp(13px, 2.2vw, 26px)', lineHeight: 1.35, textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}
      >
        {text}
      </div>
    </div>
  );
}

function ReactionLayer() {
  const reactions = useStore((s) => s.reactions);
  const remove = useStore((s) => s.removeReaction);
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-hidden>
      {reactions.map((r) => (
        <div
          key={r.id}
          className="floating-reaction"
          style={{ left: `${r.left}%`, ['--drift' as string]: `${r.drift}px` }}
          onAnimationEnd={() => remove(r.id)}
        >
          {r.emoji}
          <span className="reaction-name" style={r.color ? { color: r.color } : undefined}>
            {r.nickname}
          </span>
        </div>
      ))}
    </div>
  );
}
