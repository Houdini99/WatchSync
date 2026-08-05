// Minimal WebVTT parser — enough for YouTube timedtext output: cue timings,
// multi-line payloads, inline tags (<c>, karaoke <00:00:00.000>) stripped.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

function parseTimestamp(raw: string): number | null {
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  return hours * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .trim();
}

export function parseVtt(src: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of src.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing === -1) continue; // WEBVTT header / NOTE / STYLE block
    const [rawStart, rawEnd] = lines[timing].split('-->');
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd ?? '');
    if (start == null || end == null || end <= start) continue;
    const text = lines
      .slice(timing + 1)
      .map(cleanLine)
      .filter(Boolean)
      .join('\n');
    if (text) cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** The text to show at time `t`.
 *
 *  `rolling` (YouTube auto / auto-translated tracks): these tile the timeline
 *  and every cue carries the *previous* phrase on its top line(s) plus the
 *  newly-spoken phrase on its last line, with tiny blank "flush" cues between.
 *  Rendering all of it makes each phrase migrate bottom→top and the box grow
 *  and shrink 1↔2 lines every few hundred ms. Instead show only the current
 *  phrase — the last non-empty line of the single active cue — so each phrase
 *  appears once, on a stable single line, replaced by the next.
 *
 *  Otherwise (authored/manual tracks): a single active cue, join any overlaps
 *  and keep the intentional line breaks, de-duplicating repeated lines. */
export function cueTextAt(cues: Cue[], t: number, rolling = false): string | null {
  if (rolling) {
    let active: Cue | null = null;
    for (const cue of cues) {
      if (cue.start > t) break; // sorted by start
      if (t < cue.end) active = cue; // keep the latest-starting active cue
    }
    if (!active) return null;
    const nonEmpty = active.text.split('\n').map((l) => l.trim()).filter(Boolean);
    return nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : null;
  }
  const lines: string[] = [];
  for (const cue of cues) {
    if (cue.start > t) break; // sorted by start
    if (t < cue.end) {
      for (const line of cue.text.split('\n')) {
        if (!lines.includes(line)) lines.push(line);
      }
    }
  }
  return lines.length ? lines.join('\n') : null;
}
