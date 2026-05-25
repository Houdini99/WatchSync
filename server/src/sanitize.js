const TAG_RE = /<[^>]*>/g;
const CTRL_RE = /[\x00-\x1f\x7f-\x9f]/g;

export function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  return input.replace(TAG_RE, '').replace(CTRL_RE, '').trim().slice(0, maxLen);
}

export function sanitizeNickname(input) {
  const cleaned = sanitizeText(input, 24);
  return cleaned.length === 0 ? 'guest' : cleaned;
}

export function sanitizeChat(input) {
  return sanitizeText(input, 500);
}

export function sanitizeUrl(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().slice(0, 2048);
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}
