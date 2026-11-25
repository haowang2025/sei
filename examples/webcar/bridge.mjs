/**
 * Local-only WebCar bridge for browser games and Sei.
 * One browser game ("game") and one Sei bot ("agent") exchange typed,
 * bounded messages. No drive/steer/brake controls are exposed.
 *
 * Run: SEI_WEBCAR_TOKEN=<random-secret-at-least-24-chars> node examples/webcar/bridge.mjs
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const PROTOCOL = 1;
export const DEFAULT_PORT = 61731;
const ACTIONS = new Set(['radio.next', 'radio.toggle', 'radio.setStation', 'display.note', 'speak']);
const MAX_JSON_BYTES = 32 * 1024;
const MAX_PENDING = 16;
const GAME_TTL_MS = 4000;
const clip = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const finite = (v, a, b) => Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : null;

export function sanitizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('state must be an object');
  const r = value.radio && typeof value.radio === 'object' ? value.radio : {};
  return {
    worldId: clip(value.worldId, 100) || 'webcar-session',
    route: clip(value.route, 120),
    speedKph: finite(value.speedKph, 0, 500),
    time: clip(value.time, 30),
    engineOn: value.engineOn === true,
    radio: {
      playing: r.playing === true,
      station: clip(r.station, 80),
      track: clip(r.track, 120),
    },
    display: clip(value.display, 160),
  };
}

export function validateCommand(name, args) {
  if (!ACTIONS.has(name)) return 'unsupported action';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'args must be an object';
  const keys = Object.keys(args);
  if (name === 'radio.next' || name === 'radio.toggle') return keys.length === 0 ? null : 'no arguments allowed';
  if (name === 'radio.setStation') {
    return keys.length === 1 && typeof args.station === 'string' && /^[\w-]{1,64}$/.test(args.station)
      ? null : 'station must be an id of 1-64 letters, digits, _ or -';
  }
  if (name === 'speak') {
    return keys.length === 1 && typeof args.text === 'string' && args.text.trim().length > 0 && args.text.length <= 400
      ? null : 'speech must be 1-400 characters';
  }
  if (name === 'display.note') {
    return keys.length === 1 && typeof args.text === 'string' && args.text.trim().length > 0 && args.text.length <= 160
      ? null : 'text must be 1-160 characters';
  }
  return 'unsupported action';
}

function send(res, status, data, origin) {
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin) {
    h['access-control-allow-origin'] = origin;
    h['vary'] = 'Origin';
    h['access-control-allow-headers'] = 'Content-Type, X-Sei-Webcar-Token';
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, h);
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error('payload too large');
    parts.push(chunk);
  }
  const obj = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('invalid JSON object');
  return obj;
}
function allowedOrigin(origin, extraOrigins) {
  if (!origin) return true; // native Sei HTTP client
  if (origin === 'null') return true; // explicitly launched local file:// game
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) return true;
  return extraOrigins.includes(origin);
}

/** @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>} */
export async function createWebCarBridge({
  port = DEFAULT_PORT,
  token,
  allowedOrigins = [],
  logger = console,
  commandTimeoutMs = 8000,
} = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('SEI_WEBCAR_TOKEN must be at least 24 characters');
  let state = null;
  let updatedAt = 0;
  let seq = 0;
  const events = [];
  const queue = [];
  const pending = new Map();
  const online = () => state != null && Date.now() - updatedAt < GAME_TTL_MS;
  const reply = (res, status, obj, origin) => send(res, status, obj, origin);

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allow = allowedOrigin(origin, allowedOrigins);
    const corsOrigin = allow && origin ? origin : null;
    try {
      // Reject DNS rebinding and non-local browser origin even with a token.
      if (!/^((localhost|127\.0\.0\.1)(:\d+)?)$/i.test(req.headers.host ?? '')) {
        return reply(res, 403, { error: 'invalid host' });
      }
      if (!allow) return reply(res, 403, { error: 'origin denied' });
      if (req.method === 'OPTIONS') return reply(res, 204, {}, corsOrigin);
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/health' && req.method === 'GET') {
        return reply(res, 200, { protocol: PROTOCOL, gameOnline: online(), label: online() ? state.route : '' }, corsOrigin);
      }
      if (req.method === 'GET' && (pathname === '/demo' || pathname === '/browser-client.js')) {
        const fileName = pathname === '/demo' ? 'demo.html' : 'browser-client.js';
        const payload = await readFile(new URL('./' + fileName, import.meta.url));
        res.writeHead(200, {
          'content-type': pathname === '/demo' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        });
        res.end(payload);
        return;
      }
      if (req.headers['x-sei-webcar-token'] !== token) return reply(res, 401, { error: 'unauthorized' }, corsOrigin);

      if (pathname === '/game/state' && req.method === 'POST') {
        const incoming = await readJson(req);
        state = sanitizeState(incoming);
        updatedAt = Date.now();
        return reply(res, 200, { ok: true }, corsOrigin);
      }
      if (pathname === '/game/chat' && req.method === 'POST') {
        if (!online()) return reply(res, 409, { error: 'game not online' }, corsOrigin);
        const { text } = await readJson(req);
        const line = clip(text, 500);
        if (!line) return reply(res, 400, { error: 'empty chat' }, corsOrigin);
        events.push({ seq: ++seq, type: 'chat', text: line });
        if (events.length > 100) events.shift();
        return reply(res, 200, { ok: true, seq }, corsOrigin);
      }
      if (pathname === '/agent/state' && req.method === 'GET') {
        const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since')) || 0;
        return reply(res, 200, { protocol: PROTOCOL, online: online(), state: online() ? state : null, events: events.filter(e => e.seq > since), seq }, corsOrigin);
      }
      if (pathname === '/game/commands' && req.method === 'GET') {
        return reply(res, 200, { commands: queue.splice(0, 8) }, corsOrigin);
      }
      if (pathname === '/agent/command' && req.method === 'POST') {
        if (!online()) return reply(res, 409, { ok: false, detail: 'game offline' }, corsOrigin);
        const { name, args } = await readJson(req);
        const invalid = validateCommand(name, args);
        if (invalid) return reply(res, 400, { ok: false, detail: invalid }, corsOrigin);
        if (pending.size >= MAX_PENDING) return reply(res, 429, { ok: false, detail: 'command queue full' }, corsOrigin);
        const id = randomUUID();
        const result = await new Promise(resolve => {
          const timer = setTimeout(() => {
            pending.delete(id);
            const i = queue.findIndex(q => q.id === id);
            if (i >= 0) queue.splice(i, 1);
            resolve({ ok: false, detail: 'command timed out' });
          }, commandTimeoutMs);
          pending.set(id, data => { clearTimeout(timer); resolve(data); });
          queue.push({ id, name, args });
        });
        return reply(res, 200, result, corsOrigin);
      }
      if (pathname === '/game/result' && req.method === 'POST') {
        const value = await readJson(req);
        const done = pending.get(value.id);
        if (!done) return reply(res, 404, { error: 'unknown or expired command' }, corsOrigin);
        pending.delete(value.id);
        done({ ok: value.ok === true, detail: clip(value.detail, 300) || (value.ok ? 'done' : 'failed') });
        return reply(res, 200, { ok: true }, corsOrigin);
      }
      return reply(res, 404, { error: 'not found' }, corsOrigin);
    } catch (err) {
      logger.warn?.('[webcar bridge] ' + String(err?.message ?? err));
      return reply(res, 400, { error: 'invalid request' }, corsOrigin);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const boundPort = server.address().port;
  return {
    server, port: boundPort,
    close: () => new Promise((resolve, reject) => {
      for (const done of pending.values()) done({ ok: false, detail: 'bridge closing' });
      pending.clear();
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections?.();
    }),
  };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const bridge = await createWebCarBridge({
    token: process.env.SEI_WEBCAR_TOKEN,
    port: Number(process.env.SEI_WEBCAR_PORT ?? DEFAULT_PORT),
    allowedOrigins: (process.env.SEI_WEBCAR_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
  });
  console.log('[webcar] listening on 127.0.0.1:' + bridge.port + ' (token omitted)');
}
