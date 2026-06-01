// Central place for every tunable. Each knob can be overridden via env var so
// the same image works for a tiny watch party or a busier instance without a
// rebuild. Keep this the single source of truth — nothing else should hardcode
// these numbers.

function int(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  // CORS_ORIGIN: a single origin, a comma-separated list, or "*"/unset for any.
  corsOrigin: parseOrigin(process.env.CORS_ORIGIN),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Sync timing (all milliseconds unless noted).
  heartbeatMs: int('HEARTBEAT_MS', 4000),
  driftToleranceSec: numberEnv('DRIFT_TOLERANCE_SEC', 1.5),

  // Lifecycle.
  emptyRoomTtlMs: int('EMPTY_ROOM_TTL_MS', 5 * 60 * 1000),
  // Grace window after a socket drops before we announce "left" / migrate host.
  // Smooths over flaky wifi, tab sleeps, and reverse-proxy hiccups.
  reconnectGraceMs: int('RECONNECT_GRACE_MS', 12 * 1000),

  // Limits.
  maxUsersPerRoom: int('MAX_USERS_PER_ROOM', 50),
  maxRooms: int('MAX_ROOMS', 5000),
  maxQueueLength: int('MAX_QUEUE_LENGTH', 200),
  chatHistoryLimit: int('CHAT_HISTORY_LIMIT', 80),
  nicknameMaxLen: int('NICKNAME_MAX_LEN', 24),
  chatMaxLen: int('CHAT_MAX_LEN', 500),
  urlMaxLen: int('URL_MAX_LEN', 2048),

  // Token buckets (capacity, refill tokens/sec).
  chatBucket: { capacity: int('CHAT_BUCKET_CAP', 5), refillPerSec: numberEnv('CHAT_BUCKET_REFILL', 0.5) },
  reactionBucket: { capacity: int('REACTION_BUCKET_CAP', 8), refillPerSec: numberEnv('REACTION_BUCKET_REFILL', 2) },
  // Cap on socket events/sec to blunt floods of any event type.
  globalBucket: { capacity: int('GLOBAL_BUCKET_CAP', 40), refillPerSec: numberEnv('GLOBAL_BUCKET_REFILL', 20) },

  // Allowed playback speeds; the server rejects anything else.
  allowedRates: parseRates(process.env.ALLOWED_RATES) || [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
};

function numberEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function parseOrigin(raw) {
  if (!raw || raw === '*') return true; // reflect any origin
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

function parseRates(raw) {
  if (!raw) return null;
  const rates = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 4);
  return rates.length ? [...new Set(rates)].sort((a, b) => a - b) : null;
}
