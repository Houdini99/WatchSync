import { useEffect, useRef, useState } from 'react';
import { client } from '../client';
import { toggleFullscreen } from '../lib/fullscreen';
import { useStore } from '../store';

const iconBtn =
  'rounded-md border border-border bg-transparent px-2.5 py-1.5 text-base leading-none transition hover:border-accent hover:bg-surface2';

export default function TopBar() {
  const media = useStore((s) => s.media);
  const rate = useStore((s) => s.rate);
  const ping = useStore((s) => s.ping);
  const pingClass = useStore((s) => s.pingClass);
  const isHost = useStore((s) => s.isHost);
  const locked = useStore((s) => s.locked);
  const persistent = useStore((s) => s.persistent);
  const soundEnabled = useStore((s) => s.soundEnabled);
  const theme = useStore((s) => s.theme);
  const roomId = useStore((s) => s.roomId);
  const registered = useStore((s) => s.registered);

  const [resyncing, setResyncing] = useState(false);

  const pingColor =
    pingClass === 'good' ? 'text-success' : pingClass === 'warn' ? 'text-warn' : pingClass === 'bad' ? 'text-danger' : 'text-dim';

  const showPip = !!media && media.kind !== 'youtube';

  async function resync() {
    setResyncing(true);
    const ok = await client.resync();
    useStore.getState().showToast(ok ? 'Resynced' : 'Resync failed');
    setResyncing(false);
  }

  async function copyLink() {
    const url = `${location.origin}/r/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      useStore.getState().showToast('Link copied');
    } catch {
      useStore.getState().showToast(url);
    }
  }

  return (
    <header className="flex min-w-0 items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2.5 lg:col-span-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5 text-base font-bold leading-none">
          <span className="text-accent">▶</span> WatchSync
        </div>
        {(registered || media?.title) && (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-dim">
            {registered && (
              <span className="flex-shrink-0" title="Permanent room — this URL always works">
                📌 {roomId}
              </span>
            )}
            {media?.title && (
              <span className="truncate" title={media.title}>
                {registered && '· '}
                {media.title}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">
        <span className={`min-w-[3.2em] px-1 text-right font-mono text-xs ${pingColor}`} title="Round-trip latency">
          {ping !== null ? `${ping}ms` : '…'}
        </span>

        <SpeedMenu rate={rate} />

        {showPip && (
          <button className={iconBtn} title="Picture-in-picture" onClick={() => client.player?.togglePiP()}>
            ⧉
          </button>
        )}
        <button className={`${iconBtn} ${resyncing ? 'spinning' : ''}`} title="Resync to room" onClick={resync} disabled={resyncing}>
          ⟳
        </button>
        <button
          className={`${iconBtn} ${soundEnabled ? '' : 'opacity-40'}`}
          title="Toggle chat sound"
          onClick={() => useStore.getState().toggleSound()}
        >
          {soundEnabled ? '🔔' : '🔕'}
        </button>
        <button
          className={iconBtn}
          title="Toggle theme"
          onClick={() => useStore.getState().setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? '☀️' : '🌙'}
        </button>
        <button className={iconBtn} title="Fullscreen (F)" onClick={() => toggleFullscreen()}>
          ⛶
        </button>
        <button
          className="rounded-md border border-border bg-transparent px-3 py-1.5 text-sm transition hover:bg-surface2"
          title="Copy invite link"
          onClick={copyLink}
        >
          Copy link
        </button>

        {isHost && (
          <>
            <label className="flex cursor-pointer items-center gap-1.5 px-1 text-sm text-dim">
              <input
                type="checkbox"
                checked={locked}
                onChange={(e) => client.lockRoom(e.target.checked)}
                className="accent-accent"
              />
              <span>Lock</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 px-1 text-sm text-dim">
              <input
                type="checkbox"
                checked={persistent}
                onChange={(e) => client.setPersistent(e.target.checked)}
                className="accent-accent"
              />
              <span>Persist</span>
            </label>
          </>
        )}
      </div>
    </header>
  );
}

function SpeedMenu({ rate }: { rate: number }) {
  const allowedRates = useStore((s) => s.allowedRates);
  const locked = useStore((s) => s.locked);
  const isHost = useStore((s) => s.isHost);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  function choose(r: number) {
    if (!client.setRate(r)) useStore.getState().showToast('Host has locked controls');
    setOpen(false);
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        className={`${iconBtn} min-w-[2.6em] font-mono text-xs ${rate !== 1 ? 'border-accent bg-accent text-white' : ''}`}
        title="Playback speed"
        onClick={() => {
          if (locked && !isHost) return useStore.getState().showToast('Host has locked controls');
          setOpen((o) => !o);
        }}
      >
        {rate}×
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+0.35rem)] z-50 flex min-w-[4.5rem] flex-col gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-panel">
          {allowedRates.map((r) => (
            <button
              key={r}
              onClick={() => choose(r)}
              className={`rounded px-2.5 py-1.5 text-left font-mono text-sm transition hover:bg-surface2 ${
                r === rate ? 'bg-accent text-white' : ''
              }`}
            >
              {r}×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
