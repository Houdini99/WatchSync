import { useEffect } from 'react';
import AuthModal from './components/AuthModal';
import Landing from './components/Landing';
import NicknameModal from './components/NicknameModal';
import Privacy from './components/Privacy';
import Room from './components/Room';
import Toast from './components/Toast';
import { api } from './lib/api';
import { applyRoute } from './lib/nav';
import { useStore } from './store';

export default function App() {
  const view = useStore((s) => s.view);
  const unread = useStore((s) => s.unread);
  const mediaTitle = useStore((s) => s.media?.title);
  const theme = useStore((s) => s.theme);

  // Route from the URL on first load, and fetch the server version.
  useEffect(() => {
    const store = useStore.getState();
    applyRoute();
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        if (h?.version) store.setAppVersion(`v${h.version}`);
      })
      .catch(() => {});
    // Restore the signed-in session, if any (guests just get null).
    api
      .me()
      .then(({ user }) => store.setAccount(user))
      .catch(() => {});
  }, []);

  // Back/forward buttons re-route the SPA.
  useEffect(() => {
    window.addEventListener('popstate', applyRoute);
    return () => window.removeEventListener('popstate', applyRoute);
  }, []);

  // Keep <html data-theme> in sync.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Tab title: surface the video title and an unread badge.
  useEffect(() => {
    if (view === 'privacy') {
      document.title = 'Datenschutz / Privacy — WatchSync';
      return;
    }
    const base = mediaTitle ? `${mediaTitle} — WatchSync` : 'WatchSync';
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
  }, [unread, mediaTitle, view]);

  // Lock body scroll while in a room.
  useEffect(() => {
    document.body.classList.toggle('room-open', view === 'room');
  }, [view]);

  return (
    <>
      {view === 'landing' && <Landing />}
      {view === 'nickname' && <NicknameModal />}
      {view === 'room' && <Room />}
      {view === 'privacy' && <Privacy />}
      <AuthModal />
      <Toast />
    </>
  );
}
