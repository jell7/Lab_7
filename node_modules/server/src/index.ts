import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { config } from './config.js';
import { roomManager } from './rooms.js';
import { setupWebSocket } from './ws.js';
import { netSim, NetSimPatchSchema } from './netSim.js';

const CreateRoomSchema = z.object({
  id: z.string().min(1).max(40).optional(),
});

const SpawnBotsSchema = z.object({
  count: z.number().int().min(1).max(32).default(8),
});

const CLIENT_DIST = path.resolve(process.cwd(), '../client/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

roomManager.createRoom('Alpha Sector');
roomManager.createRoom('Beta Void');

const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (method === 'GET' && url === '/api/rooms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roomManager.getRooms()));
    return;
  }

  if (method === 'POST' && url === '/api/rooms') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        const raw: unknown = JSON.parse(body);
        const parsed = CreateRoomSchema.safeParse(raw);
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid room payload' }));
          return;
        }
        const roomId = parsed.data.id ?? `room-${Date.now()}`;
        roomManager.createRoom(roomId);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: roomId }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Спавн N серверних ботів у вказану кімнату
  const botMatch = /^\/api\/rooms\/([^/]+)\/bots$/.exec(url);
  if (method === 'POST' && botMatch !== null) {
    const roomId = decodeURIComponent(botMatch[1] ?? 'Alpha Sector');
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const raw: unknown = body.length > 0 ? JSON.parse(body) : {};
        const parsed = SpawnBotsSchema.safeParse(raw);
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid bots payload' }));
          return;
        }
        const room = roomManager.rooms.get(roomId) ?? roomManager.createRoom(roomId);
        room.spawnBots(parsed.data.count);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ roomId, added: parsed.data.count }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (method === 'GET' && url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roomManager.getStats()));
    return;
  }

  if (method === 'POST' && url === '/api/net') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const raw: unknown = JSON.parse(body);
        const parsed = NetSimPatchSchema.safeParse(raw);
        if (!parsed.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid netSim config' }));
          return;
        }
        netSim.configure(parsed.data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(netSim.getConfig()));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (method === 'GET' && url.startsWith('/api/replays/')) {
    const rawName = url.split('/').pop() ?? '';
    const filename = decodeURIComponent(rawName);
    if (filename.includes('..') || !filename.endsWith('.ndjson')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const filePath = path.join(config.LOG_DIR, filename);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const readStream = fs.createReadStream(filePath);
    pipeline(readStream, res).catch((err: unknown) => {
      console.error('Replay stream error:', err);
    });
    return;
  }

  if (method === 'GET' && fs.existsSync(CLIENT_DIST)) {
    const cleanUrl = url.split('?')[0] ?? '/';
    const candidate = path.join(CLIENT_DIST, cleanUrl === '/' ? 'index.html' : cleanUrl);
    if (candidate.startsWith(CLIENT_DIST) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
      fs.createReadStream(candidate).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const wss = setupWebSocket(server);

server.listen(config.PORT, () => {
  console.log(`Authoritative TypeScript Server running on http://localhost:${config.PORT}`);
});

const shutdown = (): void => {
  console.log('\nShutting down gracefully...');
  wss.clients.forEach((socket) => socket.close());
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);