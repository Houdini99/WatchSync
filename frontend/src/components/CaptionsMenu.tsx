import { useEffect, useMemo, useState } from 'react';
import { captions } from '../lib/captions';
import { useStore } from '../store';
import type { SubtitleTrack } from '../types';

/** CC button + language menu, floating over the player surface. Only rendered
 *  for (non-live) YouTube media — that's where the embed hides languages the
 *  watch page offers; other media plays through the HLS proxy without subs. */
export default function CaptionsMenu() {
  const media = useStore((s) => s.media);
  const tracks = useStore((s) => s.captionTracks);
  const loading = useStore((s) => s.captionsLoading);
  const active = useStore((s) => s.captionLang);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  // Localized language names ("Deutsch" for a German viewer) with the
  // resolver-provided English name as fallback for exotic codes.
  const displayNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([navigator.language], { type: 'language' });
    } catch {
      return null;
    }
  }, []);

  const label = (t: SubtitleTrack) => {
    try {
      const name = displayNames?.of(t.lang);
      if (name && name.toLowerCase() !== t.lang.toLowerCase()) return name;
    } catch {
      /* structurally invalid tag — fall through */
    }
    return t.name;
  };

  const items = useMemo(() => {
    if (!tracks) return [];
    const collator = new Intl.Collator(navigator.language);
    const named = tracks.map((t) => ({ ...t, label: label(t) }));
    named.sort(
      (a, b) =>
        Number(a.kind !== 'manual') - Number(b.kind !== 'manual') ||
        collator.compare(a.label, b.label),
    );
    const q = filter.trim().toLowerCase();
    return q
      ? named.filter((t) => t.label.toLowerCase().includes(q) || t.lang.toLowerCase().includes(q))
      : named;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, filter, displayNames]);

  // New media → collapse the menu and clear the search.
  useEffect(() => {
    setOpen(false);
    setFilter('');
  }, [media?.source]);

  if (!media || media.kind !== 'youtube' || media.is_live) return null;

  const toggle = () => {
    setOpen((prev) => {
      if (!prev) void captions.loadTracks();
      return !prev;
    });
  };

  const pick = (lang: string | null) => {
    setOpen(false);
    void captions.select(lang);
  };

  return (
    <div className="absolute right-2 top-2 z-[8]">
      <button
        className={`rounded-md px-2 py-1 text-xs font-bold tracking-wider transition-colors ${
          active ? 'bg-accent text-white' : 'bg-black/60 text-white hover:bg-black/85'
        }`}
        title="Subtitles"
        aria-label="Subtitles"
        onClick={toggle}
      >
        CC
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[8] cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-[9] flex max-h-80 w-64 flex-col overflow-hidden rounded-lg border border-border bg-surface text-text shadow-panel">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search language…"
              className="m-2 rounded-md border border-border bg-surface2 px-2 py-1 text-sm outline-none placeholder:text-dim"
            />
            <div className="overflow-y-auto pb-1">
              <Item selected={!active} label="Off" onClick={() => pick(null)} />
              {loading && <div className="px-3 py-2 text-sm text-dim">Loading languages…</div>}
              {!loading && tracks && items.length === 0 && (
                <div className="px-3 py-2 text-sm text-dim">
                  {tracks.length === 0 ? 'No subtitles available' : 'No match'}
                </div>
              )}
              {items.map((t) => (
                <Item
                  key={t.lang}
                  selected={active === t.lang}
                  label={t.label}
                  hint={t.kind === 'manual' ? undefined : 'auto'}
                  onClick={() => pick(t.lang)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Item({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface2 ${
        selected ? 'font-semibold text-accent' : ''
      }`}
    >
      <span className="truncate">
        {selected ? '✓ ' : ''}
        {label}
      </span>
      {hint && <span className="flex-shrink-0 text-[10px] uppercase text-dim">{hint}</span>}
    </button>
  );
}
