const YT_HOSTS = new Set([
  'youtu.be', 'www.youtu.be', 'youtube.com', 'www.youtube.com',
  'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

const TITLE_CACHE_MAX = 500;
const TITLE_FETCH_TIMEOUT_MS = 3000;
const titleCache = new Map();

export function detectMedia(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (YT_HOSTS.has(url.hostname)) {
    const id = extractYouTubeId(url);
    if (id) {
      return {
        type: 'youtube',
        id,
        source: rawUrl,
        start: extractStartSeconds(url),
        title: cachedYouTubeTitle(id) || rawUrl,
      };
    }
  }

  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) return { type: 'hls', source: rawUrl, title: prettyTitle(url) };
  if (/\.(mp4|webm|ogg|mov|mkv)$/.test(pathname)) return { type: 'file', source: rawUrl, title: prettyTitle(url) };

  return { type: 'file', source: rawUrl, title: prettyTitle(url) };
}

// Honor ?t=90 / ?t=1m30s / ?start=90 so a deep-link starts where it points.
function extractStartSeconds(url) {
  const raw = url.searchParams.get('t') || url.searchParams.get('start');
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Math.min(Number(raw), 86400);
  const m = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!m) return 0;
  const secs = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return Math.min(secs, 86400);
}

// Resolve missing titles in the background. Mutates the media object's title
// in place and returns true if it changed.
export async function enrichMedia(media) {
  if (!media || media.type !== 'youtube') return false;
  if (media.title && media.title !== media.source) return false;

  const cached = cachedYouTubeTitle(media.id);
  if (cached) { media.title = cached; return true; }

  const title = await fetchYouTubeTitle(media.source).catch(() => null);
  if (!title) return false;

  rememberYouTubeTitle(media.id, title);
  media.title = title;
  return true;
}

function extractYouTubeId(url) {
  if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
    return url.pathname.slice(1).split('/')[0] || null;
  }
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const parts = url.pathname.split('/').filter(Boolean);
  if (['embed', 'shorts', 'v', 'live'].includes(parts[0]) && parts[1]) return parts[1];
  return null;
}

function prettyTitle(url) {
  const base = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
  return decodeURIComponent(base);
}

function cachedYouTubeTitle(id) {
  return id ? titleCache.get(id) || null : null;
}

function rememberYouTubeTitle(id, title) {
  if (!id || !title) return;
  if (titleCache.size >= TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next().value;
    titleCache.delete(oldest);
  }
  titleCache.set(id, title);
}

async function fetchYouTubeTitle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS);
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(endpoint, { signal: controller.signal, headers: { 'User-Agent': 'WatchSync/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.title === 'string' ? data.title.trim().slice(0, 200) : null;
  } finally {
    clearTimeout(timer);
  }
}
