// Timestamps in chat ("look at 12:34") become links that jump the room there.

/** `m:ss` or `h:mm:ss`, standing alone (so `3:00pm` or `10:30:45:99` don't
 *  match). The leading field may be one or two digits; the rest are two. */
const TIMESTAMP_RE = /(?<![\w:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?![\w:])/g;

export interface Timestamp {
  label: string;
  seconds: number;
}

/** Seconds for one match, or null when a field is out of range (`1:75`). */
function toSeconds(h: string | undefined, m: string, s: string): number | null {
  const hours = h ? Number(h) : 0;
  const minutes = Number(m);
  const seconds = Number(s);
  if (seconds >= 60 || (h !== undefined && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Split `text` into plain runs and timestamps, in order. */
export function splitTimestamps(text: string): Array<string | Timestamp> {
  const out: Array<string | Timestamp> = [];
  let last = 0;
  for (const m of text.matchAll(TIMESTAMP_RE)) {
    const seconds = toSeconds(m[1], m[2], m[3]);
    if (seconds === null) continue;
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push({ label: m[0], seconds });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
