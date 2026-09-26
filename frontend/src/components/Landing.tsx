import { useState } from 'react';
import { client } from '../client';
import { api } from '../lib/api';
import { PRIVACY_PATH, navigate } from '../lib/nav';
import { useStore } from '../store';
import MyRooms from './MyRooms';

export default function Landing() {
  const [busy, setBusy] = useState(false);
  const version = useStore((s) => s.appVersion);
  const status = useStore((s) => s.status);
  const account = useStore((s) => s.account);

  async function createRoom() {
    setBusy(true);
    try {
      const id = await client.createRoom();
      const store = useStore.getState();
      store.setRoomId(id);
      history.pushState(null, '', `/r/${id}`);
      store.setView('nickname');
    } catch (e) {
      useStore.getState().showToast(e instanceof Error ? e.message : 'Failed to create room');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      /* cookie is cleared regardless */
    }
    useStore.getState().setAccount(null);
    useStore.getState().showToast('Signed out');
  }

  return (
    <div className="relative flex h-screen items-center justify-center overflow-y-auto p-4">
      <div className="absolute right-4 top-4 text-sm">
        {account ? (
          <span className="flex items-center gap-2 text-dim">
            <span title="Signed in">@{account.username}</span>
            <button className="underline-offset-2 transition hover:text-text hover:underline" onClick={signOut}>
              Sign out
            </button>
          </span>
        ) : (
          <button
            className="rounded-lg border border-border px-3.5 py-1.5 text-dim transition hover:border-accent hover:text-text"
            onClick={() => useStore.getState().setAuthOpen(true)}
          >
            Sign in
          </button>
        )}
      </div>

      <div className="my-12 w-full max-w-md rounded-card border border-border bg-surface p-10 text-center shadow-panel">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-[18px] bg-gradient-to-br from-accent to-violet-500 text-2xl text-white shadow-lg shadow-accent/40">
          ▶
        </div>
        <h1 className="mb-2 text-4xl font-bold tracking-tight">WatchSync</h1>
        <p className="mb-8 text-dim">Watch together, perfectly in sync.</p>
        <button
          onClick={createRoom}
          disabled={busy}
          className="w-full rounded-lg bg-accent px-6 py-3.5 text-lg font-semibold text-white transition hover:bg-accent-hover active:translate-y-px disabled:opacity-60"
        >
          {busy ? 'Creating…' : 'Create a Room'}
        </button>
        <p className="mt-4 text-sm text-dim">No signup. Share the URL to invite friends.</p>
        {status.text && status.warn && <p className="mt-3 text-sm text-warn">{status.text}</p>}
        <ul className="mt-7 flex flex-wrap justify-center gap-2">
          {['YouTube & direct video', 'Live chat & reactions', 'Shared queue'].map((f) => (
            <li key={f} className="rounded-full bg-surface2 px-3 py-1 text-xs text-dim">
              {f}
            </li>
          ))}
        </ul>

        {account ? (
          <MyRooms />
        ) : (
          <p className="mt-7 border-t border-border pt-6 text-xs text-dim">
            <button
              className="text-accent underline-offset-2 transition hover:underline"
              onClick={() => useStore.getState().setAuthOpen(true)}
            >
              Sign in
            </button>{' '}
            to claim a permanent room name like <span className="font-mono">/r/movie-night</span>.
          </p>
        )}
      </div>
      <footer className="absolute bottom-4 left-0 right-0 flex items-center justify-center gap-3 text-center text-xs text-dim">
        {version && (
          <>
            <span className="font-mono">{version}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <a
          href={PRIVACY_PATH}
          onClick={(e) => {
            e.preventDefault();
            navigate(PRIVACY_PATH);
          }}
          className="underline-offset-2 transition hover:text-text hover:underline"
        >
          Datenschutz / Privacy
        </a>
      </footer>
    </div>
  );
}
