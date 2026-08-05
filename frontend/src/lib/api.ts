// Auth + room-registry HTTP helpers. The session rides an HttpOnly cookie, so
// calls just need same-origin credentials; errors surface as thrown Errors
// with the server's message.

import type { Account, MyRoomEntry } from '../types';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function postJson(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export const api = {
  me: () => jsonFetch<{ user: Account | null }>('/api/auth/me'),
  register: (username: string, password: string, displayName?: string) =>
    jsonFetch<{ user: Account }>('/api/auth/register', postJson({ username, password, displayName })),
  login: (username: string, password: string) =>
    jsonFetch<{ user: Account }>('/api/auth/login', postJson({ username, password })),
  logout: () => jsonFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  myRooms: () => jsonFetch<{ rooms: MyRoomEntry[]; max: number }>('/api/my/rooms'),
  claimRoom: (slug: string) => jsonFetch<{ slug: string }>('/api/my/rooms', postJson({ slug })),
  releaseRoom: (slug: string) =>
    jsonFetch<{ ok: boolean }>(`/api/my/rooms/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  checkSlug: (slug: string) =>
    jsonFetch<{ available: boolean; reason?: string }>(
      `/api/my/rooms/check?slug=${encodeURIComponent(slug)}`,
    ),
};
