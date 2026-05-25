import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server as IOServer } from 'socket.io';
import { RoomStore } from './src/rooms.js';
import { attachSockets } from './src/socket.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || true;

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
await fastify.register(cors, { origin: CORS_ORIGIN });

const rooms = new RoomStore();

fastify.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

fastify.post('/api/rooms', async () => {
  const room = rooms.create();
  return { id: room.id, hostToken: room.hostToken };
});

fastify.get('/api/rooms/:id', async (req, reply) => {
  const room = rooms.get(req.params.id);
  if (!room) return reply.code(404).send({ error: 'Not found' });
  return { id: room.id, exists: true, userCount: room.users.size };
});

// Stub for optional yt-dlp sidecar integration. Wire to your resolver service
// if you want to support Vimeo / Twitch / etc. Returns 501 by default.
fastify.get('/api/resolve', async (req, reply) => {
  reply.code(501).send({ error: 'External resolver not configured' });
});

await fastify.listen({ port: PORT, host: HOST });

const io = new IOServer(fastify.server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
  pingInterval: 20000,
  pingTimeout: 25000,
});

attachSockets(io, rooms);

fastify.log.info(`WatchSync server ready on ${HOST}:${PORT}`);
