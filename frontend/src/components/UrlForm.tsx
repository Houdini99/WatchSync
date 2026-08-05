import { useState } from 'react';
import { client } from '../client';

export default function UrlForm() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: (u: string) => Promise<void>) {
    const v = url.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await action(v);
      setUrl('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run((u) => client.submitVideo(u));
      }}
      className="flex gap-2"
    >
      <input
        type="url"
        value={url}
        disabled={busy}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="YouTube, a direct .mp4/.m3u8, or a Vimeo/Twitch/Reddit/… link"
        className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3.5 py-2.5 outline-none transition focus:border-accent disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-white transition hover:bg-accent-hover active:translate-y-px disabled:opacity-60"
      >
        {busy ? '…' : 'Load'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run((u) => client.submitToQueue(u))}
        className="rounded-lg border border-border bg-transparent px-5 py-2.5 transition hover:bg-surface2 disabled:opacity-60"
      >
        + Queue
      </button>
    </form>
  );
}
