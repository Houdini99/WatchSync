import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { PRIVACY_PATH, navigate } from '../lib/nav';
import { useStore } from '../store';

type Mode = 'login' | 'register';

const field =
  'w-full rounded-lg border border-border bg-bg px-3.5 py-2.5 outline-none transition focus:border-accent';

/** Sign in / create account. Entirely optional — mounted app-wide and shown
 *  only when `authOpen` is set (landing page button, etc.). */
export default function AuthModal() {
  const open = useStore((s) => s.authOpen);
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    const t = setTimeout(() => userRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, mode]);

  // Escape closes. The backdrop is click-only, so without this there was no
  // keyboard way out of the dialog at all.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().setAuthOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  function close() {
    useStore.getState().setAuthOpen(false);
  }

  async function submit() {
    const name = username.trim();
    if (!name || !password) return;
    setBusy(true);
    setError('');
    try {
      const { user } =
        mode === 'login'
          ? await api.login(name, password)
          : await api.register(name, password, displayName.trim() || undefined);
      const store = useStore.getState();
      store.setAccount(user);
      store.setAuthOpen(false);
      store.showToast(mode === 'login' ? `Welcome back, ${user.displayName}` : `Welcome, ${user.displayName}`);
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const tab = (m: Mode, label: string) => (
    <button
      onClick={() => setMode(m)}
      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
        mode === m ? 'bg-accent text-white' : 'bg-surface2 text-dim hover:text-text'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={close}
      // The backdrop is a click-only affordance; Escape (below) is the
      // keyboard equivalent, so it stays out of the tab order rather than
      // becoming a focusable div.
      aria-hidden
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="w-full max-w-sm rounded-[10px] border border-border bg-surface p-8 shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="auth-modal-title" className="text-xl font-semibold">
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </h2>
          <button
            className="text-dim transition hover:text-text"
            title="Close"
            aria-label="Close"
            onClick={close}
          >
            ✕
          </button>
        </div>

        <div className="mb-5 flex gap-2">
          {tab('login', 'Sign in')}
          {tab('register', 'Register')}
        </div>

        <div className="flex flex-col gap-3">
          <input
            ref={userRef}
            value={username}
            maxLength={24}
            placeholder="Username"
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className={field}
          />
          <input
            type="password"
            value={password}
            maxLength={128}
            placeholder={mode === 'register' ? 'Password (8+ characters)' : 'Password'}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className={field}
          />
          {mode === 'register' && (
            <input
              value={displayName}
              maxLength={24}
              placeholder="Display name (optional)"
              autoComplete="off"
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              className={field}
            />
          )}
        </div>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <button
          onClick={submit}
          disabled={busy || !username.trim() || !password}
          className="mt-5 w-full rounded-lg bg-accent px-6 py-2.5 font-semibold text-white transition hover:bg-accent-hover active:translate-y-px disabled:opacity-60"
        >
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <p className="mt-4 text-center text-xs text-dim">
          {mode === 'register'
            ? 'No email needed. Accounts unlock permanent custom room links.'
            : 'Accounts are optional — rooms work fine without one.'}{' '}
          <a
            href={PRIVACY_PATH}
            onClick={(e) => {
              e.preventDefault();
              useStore.getState().setAuthOpen(false);
              navigate(PRIVACY_PATH);
            }}
            className="text-accent underline-offset-2 hover:underline"
          >
            What data is stored?
          </a>
        </p>
      </div>
    </div>
  );
}
