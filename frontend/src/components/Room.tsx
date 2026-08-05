import { useEffect } from 'react';
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

  // Keyboard shortcuts (ignored while typing or when controls are locked).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const { isHost, locked } = useStore.getState();
      const player = client.player;
      if (!player) return;
      if (locked && !isHost) return;

      const flash = (text: string) => {
        useStore.getState().setStatus(text);
        setTimeout(() => useStore.getState().setStatus(''), 800);
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
    return () => window.removeEventListener('keydown', onKey);
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
    </div>
  );
}
