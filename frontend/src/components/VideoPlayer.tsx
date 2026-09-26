import { useEffect, useRef } from 'react';
import { client } from '../client';
import { PLAYER_SURFACE_ID } from '../lib/fullscreen';
import { useStore } from '../store';
import CaptionsMenu from './CaptionsMenu';

/** Safety net for reaction removal when animationend never fires. */
const REACTION_TTL_MS = 6000;

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
  // Also a reconcile trigger, not just a readout: setStreamOffset() is only
  // called from reconcilePlayer, so an offset change that did NOT come with a
  // new stream path left SyncEngine converting content<->stream time with a
  // stale offset — and drift correction then seeks to the wrong second on
  // every heartbeat. Subscribed as a scalar rather than depending on the whole
  // `stream` object, whose identity changes on every snapshot.
  const streamOffset = useStore((s) => s.stream?.offset ?? 0);

  // React owns which surface is visible (see index.css for why inline display).
  const showVideo = !!media && media.kind !== 'youtube';
  const showYt = !!media && media.kind === 'youtube';

  // Register the DOM mount points with the controller (once).
  useEffect(() => {
    if (videoRef.current && ytRef.current) client.setMounts(videoRef.current, ytRef.current);
  }, []);

  // Reconcile the active player with the room's current media + proxy stream.
  // `client` and `reconcilePlayer` are stable singletons, hence the disable.
  useEffect(() => {
    client.reconcilePlayer();
  }, [media?.source, media?.kind, streamPath, streamReady, streamError, streamOffset]);

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
      {media && <WaitingIndicator />}

      {lockedForViewer && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[6] rounded-md bg-black/65 px-2.5 py-1 text-sm text-slate-300">
          🔒 Host has locked controls
        </div>
      )}
    </div>
  );
}

/** Who the room is waiting on. The server pauses everyone while any viewer is
 *  buffering and resumes once all are ready — without this the video simply
 *  stopped, and nobody could tell why or for whom. */
function WaitingIndicator() {
  const users = useStore((s) => s.users);
  const waiting = users.filter((u) => u.buffering && !u.disconnected);
  if (waiting.length === 0) return null;
  const names = waiting.map((u) => (u.client_id === client.clientId ? 'you' : u.nickname));
  const text =
    names.length === 1 && names[0] === 'you'
      ? 'Buffering…'
      : names.length <= 2
        ? `Waiting for ${names.join(' and ')}…`
        : `Waiting for ${names.length} viewers…`;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-3 top-3 z-[7] flex max-w-[60%] items-center gap-2 rounded-md bg-black/65 px-2.5 py-1 text-sm text-slate-200"
    >
      <span className="spinning inline-block leading-none" aria-hidden>
        ◌
      </span>
      <span className="truncate">{text}</span>
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

  // Timer fallback for removal. animationend is the normal path, but CSS
  // animations are throttled or paused in a background tab and this layer is
  // not mounted outside the room view, so the event can simply never arrive.
  // The store caps the list as a second line of defence.
  useEffect(() => {
    if (reactions.length === 0) return;
    const timers = reactions.map((r) => window.setTimeout(() => remove(r.id), REACTION_TTL_MS));
    return () => timers.forEach(clearTimeout);
  }, [reactions, remove]);

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
