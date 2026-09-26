import type { Media } from '../types';
import { client } from '../client';
import { useStore } from '../store';

/** YouTube items expose an `id` we can build a thumbnail from; other kinds don't. */
function thumbnailUrl(item: Media): string | null {
  if (item.kind === 'youtube' && item.id) {
    return `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`;
  }
  return null;
}

export default function QueuePanel() {
  const queue = useStore((s) => s.queue);
  const hasMedia = useStore((s) => !!s.media);
  const isHost = useStore((s) => s.isHost);
  const locked = useStore((s) => s.locked);
  const editable = isHost || !locked;

  const actionBtn = 'rounded px-1 text-base text-dim transition hover:bg-bg hover:text-text';

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <ul className="flex flex-1 list-none flex-col gap-1.5 overflow-y-auto p-0">
        {queue.map((item, idx) => {
          const thumb = thumbnailUrl(item);
          return (
            <li key={`${idx}-${item.source}`} className="flex items-start gap-2.5 rounded-lg bg-surface2 p-2">
              <span className="mt-0.5 min-w-[1.2em] text-center font-mono text-xs text-dim">{idx + 1}</span>
              <div className="relative aspect-video w-24 flex-shrink-0 overflow-hidden rounded bg-bg">
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-lg text-dim">▶</span>
                )}
              </div>
              <span className="line-clamp-3 min-w-0 flex-1 break-words text-sm" title={item.source}>
                {item.title || item.source}
              </span>
              {editable && (
                <span className="flex flex-shrink-0 gap-0.5">
                  <button
                    className={`${actionBtn} hover:text-accent`}
                    title="Play now"
                    aria-label={`Play ${item.title || item.source} now`}
                    onClick={() => client.queuePlay(idx)}
                  >
                    ▶
                  </button>
                  {idx > 0 && (
                    <button className={actionBtn} title="Move up" onClick={() => client.queueMove(idx, idx - 1)}>
                      ↑
                    </button>
                  )}
                  {idx < queue.length - 1 && (
                    <button className={actionBtn} title="Move down" onClick={() => client.queueMove(idx, idx + 1)}>
                      ↓
                    </button>
                  )}
                  <button
                    className={`${actionBtn} hover:text-danger`}
                    title="Remove"
                    onClick={() => client.queueRemove(idx)}
                  >
                    ×
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {queue.length === 0 && (
        <p className="px-2 py-4 text-center text-sm text-dim">
          Queue is empty. Add videos with <strong>+ Queue</strong>.
        </p>
      )}

      {/* With nothing queued, a skip ends the current video for everyone —
          say so rather than calling it "Skip to next"; with nothing playing it
          starts the queue. Hidden from viewers the host has locked out, whose
          skips the server ignores anyway. */}
      {editable && (hasMedia || queue.length > 0) && (
        <button
          onClick={() => {
            if (queue.length === 0 && !window.confirm('Stop the video for everyone?')) return;
            client.queueSkip();
          }}
          className="mt-2 w-full rounded-lg border border-border bg-transparent px-5 py-2.5 transition hover:bg-surface2"
        >
          {queue.length === 0 ? 'Stop video' : hasMedia ? 'Skip to next' : 'Start the queue'}
        </button>
      )}
    </div>
  );
}
