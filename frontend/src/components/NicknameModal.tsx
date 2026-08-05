import { useEffect, useRef, useState } from 'react';
import { client } from '../client';
import { useStore } from '../store';

export default function NicknameModal() {
  const roomId = useStore((s) => s.roomId);
  const account = useStore((s) => s.account);
  const [value, setValue] = useState(() => localStorage.getItem('ws_nickname') || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Signed-in users get their display name prefilled (the session may resolve
  // after this modal mounts, hence the effect). An explicit choice still wins.
  useEffect(() => {
    if (account && !localStorage.getItem('ws_nickname')) {
      setValue((v) => v || account.displayName);
    }
  }, [account]);

  function join() {
    if (!roomId) return;
    const nickname = value.trim().slice(0, 24) || account?.displayName || 'guest';
    localStorage.setItem('ws_nickname', nickname);
    useStore.getState().setView('room');
    client.connect(roomId, nickname);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-[10px] border border-border bg-surface p-8 shadow-panel">
        <h2 className="mb-5 text-xl font-semibold">Pick a nickname</h2>
        <input
          ref={inputRef}
          value={value}
          maxLength={24}
          placeholder="Your name"
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && join()}
          className="mb-4 w-full rounded-lg border border-border bg-bg px-3.5 py-2.5 outline-none transition focus:border-accent"
        />
        <button
          onClick={join}
          className="w-full rounded-lg bg-accent px-6 py-2.5 font-semibold text-white transition hover:bg-accent-hover active:translate-y-px"
        >
          Join Room
        </button>
      </div>
    </div>
  );
}
