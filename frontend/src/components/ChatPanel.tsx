import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { client } from '../client';
import { splitTimestamps } from '../lib/timestamps';
import { useStore } from '../store';
import type { ChatItem } from '../types';

const REACTIONS = ['👍', '❤️', '😂', '🔥', '😮', '👀', '🎉', '😢'];
const URL_RE = /\b(https?:\/\/[^\s<>"]+[^\s<>".,!?:;)])/g;

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Render message text with bare URLs turned into links and, when the room has
// a seekable video, timestamps ("look at 12:34") turned into jump buttons.
// React escapes the text nodes, so this is XSS-safe without extra sanitization.
function renderBody(text: string, seekable: boolean) {
  const parts: React.ReactNode[] = [];
  let key = 0;
  const plain = (run: string) => {
    if (!seekable) return parts.push(<Fragment key={key++}>{run}</Fragment>);
    for (const piece of splitTimestamps(run)) {
      if (typeof piece === 'string') {
        parts.push(<Fragment key={key++}>{piece}</Fragment>);
      } else {
        parts.push(
          <button
            key={key++}
            type="button"
            onClick={() => client.jumpTo(piece.seconds)}
            title={`Jump to ${piece.label}`}
            className="font-mono text-accent-hover underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {piece.label}
          </button>,
        );
      }
    }
  };
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) plain(text.slice(last, idx));
    parts.push(
      <a key={key++} href={m[0]} target="_blank" rel="noopener noreferrer" className="text-accent-hover underline">
        {m[0]}
      </a>,
    );
    last = idx + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
  return parts;
}

export default function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const typers = useStore((s) => s.typers);
  const seekable = useStore((s) => !!s.media && !s.media.is_live);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Track whether we're pinned to the bottom before each render commits.
  function onScroll() {
    const el = logRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  useLayoutEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat]);

  // Clear unread when the chat tab is visible.
  useEffect(() => {
    useStore.getState().clearUnread();
    const onVis = () => {
      if (!document.hidden) useStore.getState().clearUnread();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const typerNames = Object.values(typers);
  let typingText = '';
  if (typerNames.length === 1) typingText = `${typerNames[0]} is typing…`;
  else if (typerNames.length === 2) typingText = `${typerNames[0]} and ${typerNames[1]} are typing…`;
  else if (typerNames.length > 2) typingText = 'Several people are typing…';

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <div
        ref={logRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Chat messages"
        className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1"
      >
        {chat.map((m) =>
          m.kind === 'system' ? <SystemMsg key={m.id} text={m.text} /> : <ChatMsg key={m.id} m={m} seekable={seekable} />,
        )}
      </div>

      <div
        aria-live="polite"
        className={`min-h-[1.1em] py-0.5 text-xs italic text-dim transition-opacity ${typingText ? 'opacity-100' : 'opacity-0'}`}
      >
        {typingText}
      </div>

      <div className="flex flex-wrap gap-1 py-1.5" title="Send a floating reaction">
        {REACTIONS.map((e) => (
          <button
            key={e}
            onClick={() => client.sendReaction(e)}
            className="rounded-md border border-transparent bg-surface2 px-2 py-1 text-lg leading-none transition hover:-translate-y-px hover:border-accent active:scale-90"
          >
            {e}
          </button>
        ))}
      </div>

      <ChatForm />
    </div>
  );
}

function ChatMsg({ m, seekable }: { m: ChatItem; seekable: boolean }) {
  return (
    <div className={`relative break-words rounded-lg px-2.5 py-1.5 leading-snug ${m.mine ? 'bg-accent/15' : 'bg-surface2'}`}>
      <div className="mb-0.5 flex items-baseline gap-1.5">
        <span className="text-sm font-semibold" style={{ color: m.mine ? 'var(--success)' : m.color || 'var(--accent)' }}>
          {m.nickname}
        </span>
        <span className="font-mono text-[0.7rem] text-dim">{formatTime(m.ts)}</span>
      </div>
      <div>{renderBody(m.text, seekable)}</div>
    </div>
  );
}

function SystemMsg({ text }: { text: string }) {
  return <div className="px-1 py-0.5 text-center text-sm italic text-dim">{text}</div>;
}

function ChatForm() {
  const [value, setValue] = useState('');
  const sentRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  function signalTyping(typing: boolean) {
    if (typing) {
      if (!sentRef.current) {
        sentRef.current = true;
        client.sendTyping(true);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => signalTyping(false), 3000);
    } else if (sentRef.current) {
      sentRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      client.sendTyping(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    client.sendChat(value);
    setValue('');
    signalTyping(false);
  }

  return (
    <form onSubmit={submit} className="mt-1 flex gap-2">
      <input
        type="text"
        maxLength={500}
        value={value}
        autoComplete="off"
        placeholder="Say something…"
        onChange={(e) => {
          setValue(e.target.value);
          signalTyping(e.target.value.trim().length > 0);
        }}
        onBlur={() => signalTyping(false)}
        className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3.5 py-2.5 outline-none transition focus:border-accent"
      />
      <button
        type="submit"
        className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-white transition hover:bg-accent-hover active:translate-y-px"
      >
        Send
      </button>
    </form>
  );
}
