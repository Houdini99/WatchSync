import { useEffect, useState } from 'react';
import { client } from '../client';
import { toggleFullscreen } from '../lib/fullscreen';
import { useStore } from '../store';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import UrlForm from './UrlForm';
import VideoPlayer from './VideoPlayer';

export default function Room() {
  const mediaWarning = useStore((s) => s.mediaWarning);
  const status = useStore((s) => s.status);
  const [showKeys, setShowKeys] = useState(false);

  // Keyboard shortcuts (ignored while typing or when controls are locked).
  useEffect(() => {
    let flashTimer: number | null = null;
    /** What the status line said before the current burst of hints. */
    let beforeFlash: { text: string; warn: boolean } | null = null;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      // Let Space activate whatever is focused. These shortcuts preventDefault
      // on Space, which otherwise swallowed the activation key for every
      // button in the room (Send, reactions, the sidebar tabs) whenever a
      // player was mounted — making the UI unusable by keyboard.
      if (e.key === ' ' && (tag === 'button' || tag === 'a' || tag === 'select')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Help works for everyone, player or not, locked or not.
      if (e.key === '?') {
        e.preventDefault();
        setShowKeys((open) => !open);
        return;
      }
      if (e.key === 'Escape') {
        setShowKeys(false);
        return;
      }
      const { isHost, locked } = useStore.getState();
      const player = client.player;
      if (!player) return;
      if (locked && !isHost) return;

      // Show a transient hint, then restore whatever was there before rather
      // than blanking unconditionally: an action_error or stream error
      // arriving inside the 800ms window used to be wiped by this timer. The
      // handle is kept so the effect's cleanup can cancel it on unmount.
      // "Before" means before the first hint of a burst: a second key press
      // inside the window used to record the first hint as the status to
      // restore, which then stayed on screen for good.
      const flash = (text: string) => {
        if (flashTimer === null) beforeFlash = useStore.getState().status;
        useStore.getState().setStatus(text);
        if (flashTimer !== null) clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          flashTimer = null;
          const current = useStore.getState().status;
          // Only restore if our own hint is still the one on screen.
          if (current.text === text && beforeFlash) {
            useStore.getState().setStatus(beforeFlash.text, beforeFlash.warn);
          }
          beforeFlash = null;
        }, 800);
      };

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          player.togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          player.seekBy(-5);
          flash('⏪ -5s');
          break;
        case 'arrowright':
          e.preventDefault();
          player.seekBy(5);
          flash('⏩ +5s');
          break;
        case 'j':
          e.preventDefault();
          player.seekBy(-10);
          flash('⏪ -10s');
          break;
        case 'l':
          e.preventDefault();
          player.seekBy(10);
          flash('⏩ +10s');
          break;
        case 'm':
          e.preventDefault();
          player.toggleMute();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (flashTimer !== null) clearTimeout(flashTimer);
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden">
      <TopBar />
      <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4 lg:col-start-1 lg:row-start-2">
        <VideoPlayer />
        <UrlForm />
        {mediaWarning && (
          <div className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm leading-relaxed text-warn">
            {mediaWarning}
          </div>
        )}
        <div className={`min-h-[1.2em] text-sm ${status.warn ? 'text-warn' : 'text-dim'}`}>{status.text}</div>
      </section>
      <Sidebar />
      {showKeys && <ShortcutsHelp onClose={() => setShowKeys(false)} />}
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Space / K', 'Play or pause'],
  ['← / →', 'Back / forward 5 seconds'],
  ['J / L', 'Back / forward 10 seconds'],
  ['M', 'Mute'],
  ['F', 'Fullscreen'],
  ['?', 'Show or hide this list'],
];

/** The keyboard shortcuts, which the UI otherwise mentioned nowhere. */
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="w-full max-w-xs rounded-[10px] border border-border bg-surface p-6 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="shortcuts-title" className="mb-4 text-lg font-semibold">
          Keyboard shortcuts
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-surface2 px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
              </dt>
              <dd className="text-dim">{what}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="mt-5 w-full rounded-lg border border-border px-4 py-2 text-sm transition hover:bg-surface2"
        >
          Close
        </button>
      </div>
    </div>
  );
}
