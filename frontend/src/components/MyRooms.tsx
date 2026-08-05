import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../store';
import type { MyRoomEntry } from '../types';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

/** The signed-in user's permanent rooms: claim a name, open, copy, release.
 *  Rendered on the landing page below the ad-hoc "Create a Room" button. */
export default function MyRooms() {
  const [rooms, setRooms] = useState<MyRoomEntry[] | null>(null);
  const [max, setMax] = useState(5);
  const [slug, setSlug] = useState('');
  const [availability, setAvailability] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState<string | null>(null);
  const checkTimer = useRef<number | null>(null);

  const reload = useCallback(() => {
    api
      .myRooms()
      .then((r) => {
        setRooms(r.rooms);
        setMax(r.max);
      })
      .catch(() => setRooms([]));
  }, []);

  useEffect(reload, [reload]);

  // Debounced availability feedback while typing.
  useEffect(() => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const s = slug.trim().toLowerCase();
    if (!s) {
      setAvailability(null);
      return;
    }
    if (!SLUG_RE.test(s)) {
      setAvailability({ ok: false, reason: '3–32 chars: a–z, 0–9, hyphens' });
      return;
    }
    checkTimer.current = window.setTimeout(() => {
      api
        .checkSlug(s)
        .then((r) => setAvailability({ ok: r.available, reason: r.reason }))
        .catch(() => setAvailability(null));
    }, 350);
    return () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    };
  }, [slug]);

  function open(s: string) {
    const store = useStore.getState();
    store.setRoomId(s);
    history.pushState(null, '', `/r/${s}`);
    store.setView('nickname');
  }

  async function copyLink(s: string) {
    const url = `${location.origin}/r/${s}`;
    try {
      await navigator.clipboard.writeText(url);
      useStore.getState().showToast('Link copied');
    } catch {
      useStore.getState().showToast(url);
    }
  }

  async function claim() {
    const s = slug.trim().toLowerCase();
    if (!s || busy) return;
    setBusy(true);
    try {
      await api.claimRoom(s);
      setSlug('');
      setAvailability(null);
      useStore.getState().showToast(`/r/${s} is yours`);
      reload();
    } catch (e) {
      useStore.getState().showToast(e instanceof Error ? e.message : 'Could not claim room');
    } finally {
      setBusy(false);
    }
  }

  async function release(s: string) {
    setConfirmRelease(null);
    try {
      await api.releaseRoom(s);
      useStore.getState().showToast(`/r/${s} released`);
      reload();
    } catch (e) {
      useStore.getState().showToast(e instanceof Error ? e.message : 'Could not release room');
    }
  }

  const atCap = (rooms?.length ?? 0) >= max;

  return (
    <div className="mt-7 border-t border-border pt-6 text-left">
      <h3 className="mb-3 flex items-baseline justify-between text-sm font-semibold">
        <span>My rooms</span>
        <span className="font-normal text-dim">
          {rooms ? `${rooms.length}/${max}` : '…'}
        </span>
      </h3>

      {rooms && rooms.length > 0 && (
        <ul className="mb-4 flex flex-col gap-1.5">
          {rooms.map((r) => (
            <li
              key={r.slug}
              className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2"
            >
              <button
                onClick={() => open(r.slug)}
                className="min-w-0 flex-1 truncate text-left text-sm transition hover:text-accent"
                title={`Open /r/${r.slug}`}
              >
                <span className="text-dim">/r/</span>
                {r.slug}
              </button>
              {r.live && (
                <span className="rounded-full bg-surface2 px-2 py-0.5 text-[10px] text-success" title="Room is live">
                  ● {r.userCount}
                </span>
              )}
              <button className="text-xs text-dim transition hover:text-text" title="Copy link" onClick={() => copyLink(r.slug)}>
                Copy
              </button>
              {confirmRelease === r.slug ? (
                <button className="text-xs font-semibold text-danger" title="Click again to confirm" onClick={() => release(r.slug)}>
                  Sure?
                </button>
              ) : (
                <button
                  className="text-xs text-dim transition hover:text-danger"
                  title="Release this name"
                  onClick={() => {
                    setConfirmRelease(r.slug);
                    setTimeout(() => setConfirmRelease((c) => (c === r.slug ? null : c)), 3000);
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {rooms && rooms.length === 0 && (
        <p className="mb-4 text-xs text-dim">
          Claim a permanent room name — the link works forever, and you're always the host there.
        </p>
      )}

      {!atCap && (
        <>
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-bg px-3">
              <span className="flex-shrink-0 whitespace-nowrap font-mono text-sm text-dim">/r/</span>
              <input
                value={slug}
                maxLength={32}
                placeholder="movie-night"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                onKeyDown={(e) => e.key === 'Enter' && availability?.ok && claim()}
                className="w-full min-w-0 bg-transparent py-2 text-sm outline-none"
              />
            </div>
            <button
              onClick={claim}
              disabled={busy || !availability?.ok}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              Claim
            </button>
          </div>
          {slug.trim() && availability && (
            <p className={`mt-1.5 text-xs ${availability.ok ? 'text-success' : 'text-warn'}`}>
              {availability.ok ? `/r/${slug.trim().toLowerCase()} is available` : availability.reason || 'Not available'}
            </p>
          )}
        </>
      )}
      {atCap && (
        <p className="text-xs text-dim">Room limit reached — release one to claim another.</p>
      )}
    </div>
  );
}
