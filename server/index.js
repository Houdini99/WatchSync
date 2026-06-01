import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server as IOServer } from 'socket.io';
import { readFileSync } from 'node:fs';
import { RoomStore } from './src/rooms.js';
import { attachSockets } from './src/socket.js';
import { config } from './src/config.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const fastify = Fastify({
  logger: { level: config.logLevel },
  trustProxy: true, // we sit behind nginx + NPM; trust X-Forwarded-* headers
});

await fastify.register(cors, { origin: config.corsOrigin });

const rooms = new RoomStore();

fastify.get('/api/health', async () => ({
  ok: true,
  version: pkg.version,
  rooms: rooms.rooms.size,
  uptime: Math.round(process.uptime()),
  ts: Date.now(),
}));

fastify.post('/api/rooms', async () => {
  const room = rooms.create();
  return { id: room.id, hostToken: room.hostToken };
});

fastify.get('/api/rooms/:id', async (req, reply) => {
  const room = rooms.get(req.params.id);
  if (!room) return reply.code(404).send({ error: 'Not found' });
  return {
    id: room.id,
    exists: true,
    userCount: rooms.liveUserCount(room),
    hasMedia: !!room.video.media,
    locked: room.locked,
  };
});

// Stub for optional yt-dlp sidecar integration. Wire to your resolver service
// if you want to support Vimeo / Twitch / etc. Returns 501 by default.
fastify.get('/api/resolve', async (req, reply) => {
  reply.code(501).send({ error: 'External resolver not configured' });
});

await fastify.listen({ port: config.port, host: config.host });

const io = new IOServer(fastify.server, {
  cors: { origin: config.corsOrigin, credentials: true },
  pingInterval: 20000,
  pingTimeout: 25000,
  // Keep payloads sane; nobody should be pushing megabytes over a socket.
  maxHttpBufferSize: 1e5,
});

attachSockets(io, rooms);

fastify.log.info(`WatchSync ${pkg.version} ready on ${config.host}:${config.port}`);

// Graceful shutdown so in-flight sockets close cleanly on container stop.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info(`Received ${signal}, shutting down…`);
  // Give clients a disconnect packet so they reconnect cleanly, then close the
  // server once (fastify owns the HTTP server that Socket.IO is attached to).
  const force = setTimeout(() => process.exit(0), 8000);
  if (force.unref) force.unref();
  try {
    io.disconnectSockets(true);
    await fastify.close();
  } catch (err) {
    fastify.log.error(err);
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
