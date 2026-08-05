// A stable per-browser identity. Generated once and persisted, so a
// reconnecting socket reclaims the same seat, nickname, color, and host status.

const CLIENT_ID_KEY = 'ws_client_id';

export function ensureClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY) || '';
  if (id.length < 8) {
    const raw = crypto.randomUUID
      ? crypto.randomUUID()
      : `c${Date.now()}${Math.random().toString(36).slice(2)}`;
    id = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export const hostTokenKey = (roomId: string) => `ws_host_${roomId}`;

export function storeHostToken(roomId: string, token: string) {
  localStorage.setItem(hostTokenKey(roomId), token);
}

export function readHostToken(roomId: string): string | null {
  return localStorage.getItem(hostTokenKey(roomId));
}

// Per-room seat secret issued by the server on first join. Presenting it on
// reconnect reclaims the same seat (and host status); without it a joiner using
// the same client_id is given a fresh seat, so a leaked/guessed client_id can't
// be used to take over someone else's seat.
const seatTokenKey = (roomId: string) => `ws_seat_${roomId}`;

export function storeSeatToken(roomId: string, token: string) {
  if (token) localStorage.setItem(seatTokenKey(roomId), token);
}

export function readSeatToken(roomId: string): string | null {
  return localStorage.getItem(seatTokenKey(roomId));
}
