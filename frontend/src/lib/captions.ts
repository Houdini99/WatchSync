// App-level captions for YouTube media. YouTube serves its *embedded* player a
// reduced caption dataset (no auto-translate catalog — only youtube.com gets
// `translationLanguages`), so languages available on youtube.com are missing
// from the iframe's CC menu. We restore them by fetching the full track list
// and the chosen WebVTT through our own /api/subtitles endpoints (resolver
// sidecar → yt-dlp → watch-page data) and rendering the active cue as an
// overlay on the player. The language choice is purely local to this viewer.

import { useStore } from '../store';
import type { Media } from '../types';
import { cueTextAt, parseVtt, type Cue } from './vtt';

const PREF_KEY = 'ws_caption_lang';
const TICK_MS = 250;

class CaptionsController {
  private getTime: () => number | null = () => null;
  private cues: Cue[] = [];
  private timer: number | null = null;
  private source: string | null = null;
  /** True for YouTube auto / auto-translated tracks, which use the rolling
   *  two-line ASR format and need single-line rendering (see cueTextAt). */
  private rolling = false;
  private tracksPromise: Promise<void> | null = null;
  /** Bumped on every media change / selection so stale fetches are dropped. */
  private seq = 0;

  attachTimeSource(fn: () => number | null) {
    this.getTime = fn;
  }

  /** Called by the client whenever the room's media changes (or clears). */
  onMedia(media: Media | null) {
    const src = media && media.kind === 'youtube' && !media.is_live ? media.source : null;
    if (src === this.source) return;
    this.source = src;
    this.seq++;
    this.stop();
    this.cues = [];
    this.rolling = false;
    this.tracksPromise = null;
    const s = useStore.getState();
    s.setCaptionTracks(null);
    s.setCaptionsLoading(false);
    s.setCaptionLang(null);
    s.setCaptionText(null);
    // Re-apply the sticky language choice to the new video — quietly, since
    // not every video has the preferred language.
    const pref = src ? localStorage.getItem(PREF_KEY) : null;
    if (pref) void this.select(pref, true);
  }

  /** Fetch the available languages once per media (idempotent, race-safe). */
  loadTracks(): Promise<void> {
    if (!this.tracksPromise) this.tracksPromise = this.doLoadTracks();
    return this.tracksPromise;
  }

  private async doLoadTracks() {
    const src = this.source;
    if (!src) return;
    const s = useStore.getState();
    s.setCaptionsLoading(true);
    try {
      const res = await fetch(`/api/subtitles?url=${encodeURIComponent(src)}`);
      const data = res.ok ? await res.json() : null;
      if (this.source !== src) return;
      useStore.getState().setCaptionTracks(Array.isArray(data?.tracks) ? data.tracks : []);
    } catch {
      if (this.source === src) useStore.getState().setCaptionTracks([]);
    } finally {
      if (this.source === src) useStore.getState().setCaptionsLoading(false);
    }
  }

  /** Switch to a language (null = off). `quiet` suppresses the failure toast. */
  async select(lang: string | null, quiet = false) {
    const src = this.source;
    if (!src) return;
    const seq = ++this.seq;
    const s = useStore.getState();
    if (!lang) {
      localStorage.removeItem(PREF_KEY);
      this.stop();
      this.cues = [];
      this.rolling = false;
      s.setCaptionLang(null);
      s.setCaptionText(null);
      return;
    }
    s.setCaptionLang(lang);
    s.setCaptionText(null);
    // Translated tracks can take ~10-20s on first load (YouTube rate-limits
    // translation requests; the resolver retries through it) — say so.
    if (!quiet) s.setStatus('Loading subtitles…');

    await this.loadTracks();
    if (seq !== this.seq) return; // superseded by another selection or media change
    const track = (useStore.getState().captionTracks ?? []).find((t) => t.lang === lang);
    this.rolling = track?.kind !== 'manual';
    if (!track) {
      useStore.getState().setCaptionLang(null);
      if (!quiet) useStore.getState().setStatus('That subtitle language is not available here.', true);
      return;
    }

    const cues = (await this.fetchCues(track.url)) ?? (await this.fetchCues(this.proxyUrl(src, lang)));
    if (seq !== this.seq) return;
    if (!cues) {
      this.cues = [];
      this.stop();
      useStore.getState().setCaptionLang(null);
      if (!quiet) {
        useStore.getState().setStatus('Subtitles could not be loaded for this video.', true);
      }
      return;
    }
    this.cues = cues;
    localStorage.setItem(PREF_KEY, lang);
    if (!quiet) useStore.getState().setStatus('');
    this.start();
  }

  private proxyUrl(src: string, lang: string): string {
    return `/api/subtitles/track?url=${encodeURIComponent(src)}&lang=${encodeURIComponent(lang)}`;
  }

  /** One attempt at downloading + parsing a VTT; null on any failure so the
   *  caller can fall through (direct CDN fetch first, then our proxy). */
  private async fetchCues(url: string): Promise<Cue[] | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const cues = parseVtt(await res.text());
      return cues.length ? cues : null;
    } catch {
      return null;
    }
  }

  private start() {
    this.stop();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    const t = this.getTime();
    const text = t == null ? null : cueTextAt(this.cues, t, this.rolling);
    const s = useStore.getState();
    if (s.captionText !== text) s.setCaptionText(text);
  }
}

export const captions = new CaptionsController();
