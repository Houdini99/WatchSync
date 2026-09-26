// Pasted media links, made acceptable to the server (which wants http(s)).

/** A bare host with at least one dot, optional port, then a path or nothing. */
const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]|$)/i;

/** `youtube.com/watch?v=…` and `//cdn.example/a.m3u8` gain `https://`; text
 *  that already has a scheme, or does not look like a link at all, is only
 *  trimmed (the server explains what is wrong with it). */
export function normalizeMediaUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return url;
  // Host shape first: `cdn.example.org:8443/…` also parses as a URI scheme.
  if (BARE_HOST.test(url)) return `https://${url}`;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}
