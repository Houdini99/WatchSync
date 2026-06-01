import { config } from './config.js';

const TAG_RE = /<[^>]*>/g;
const CTRL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const CLIENT_ID_RE = /[^a-zA-Z0-9_-]/g;

export function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  return input.replace(TAG_RE, '').replace(CTRL_RE, '').trim().slice(0, maxLen);
}

export function sanitizeNickname(input) {
  const cleaned = sanitizeText(input, config.nicknameMaxLen);
  return cleaned.length === 0 ? 'guest' : cleaned;
}

export function sanitizeChat(input) {
  return sanitizeText(input, config.chatMaxLen);
}

export function sanitizeUrl(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().slice(0, config.urlMaxLen);
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

// A browser-generated stable identity. Restrict to a safe alphabet and length
// so it can never be used as an injection vector when echoed to other clients.
export function sanitizeClientId(input) {
  if (typeof input !== 'string') return '';
  const cleaned = input.replace(CLIENT_ID_RE, '').slice(0, 64);
  return cleaned.length >= 8 ? cleaned : '';
}

// Reactions are short emoji (possibly multi-codepoint, e.g. ❤️). Strip markup
// and control chars, keep it tiny so it can't carry a payload or a wall of text.
export function sanitizeReaction(input) {
  if (typeof input !== 'string') return '';
  const cleaned = input.replace(TAG_RE, '').replace(CTRL_RE, '').trim();
  if (!cleaned) return '';
  return [...cleaned].slice(0, 8).join('');
}
