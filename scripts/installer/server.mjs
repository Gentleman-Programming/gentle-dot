import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const securityHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  connection: 'close',
};
const errors = {
  400: 'Invalid body', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not found', 405: 'Method not allowed',
  413: 'Body too large', 415: 'Unsupported media type', 500: 'Internal error',
};
const token = () => randomBytes(32).toString('hex');
function equal(actual, expected) {
  if (typeof actual !== 'string') return false;
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}
function reply(res, code, body = { error: errors[code] }, extra = {}) {
  res.writeHead(code, { ...securityHeaders, ...extra });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024) {
        reject(413);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(400));
    req.on('aborted', () => reject(400));
  });
}

/** Host-only security core. No CLI, download, verification or installation action. */
export async function startInstallerSession(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !['ttlMs', 'now'].includes(key))) {
    throw new TypeError('Invalid session options');
  }
  const { ttlMs = 300000, now = Date.now } = options;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000 || typeof now !== 'function') {
    throw new TypeError('Invalid session options');
  }
  const started = now();
  if (!Number.isFinite(started) || !Number.isFinite(started + ttlMs)) {
    throw new TypeError('Invalid session options');
  }
  const deadline = started + ttlMs;
  const bootstrapToken = token();
  let sessionToken = '';
  let csrfToken = '';
  let state = 'idle';
  let origin;
  let boundHost;
  let lastTime = started;
  let expired = false;
  const active = () => {
    const time = now();
    if (!Number.isFinite(time) || time < lastTime || time >= deadline) expired = true;
    lastTime = time;
    return !expired;
  };
  const authenticated = (req) => {
    const cookies = (req.headers.cookie ?? '').split(';').map((part) => part.trim());
    const sessions = cookies.filter((part) => part.startsWith('installer_session='));
    return active() && sessionToken !== '' && sessions.length === 1
      && equal(sessions[0].slice('installer_session='.length), sessionToken);
  };
  const snapshot = () => ({ state, installationAvailable: false });
  async function handle(req, res) {
    if (req.headers.host !== boundHost
      || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      return reply(res, 403);
    }
    const method = { '/api/session': 'POST', '/api/status': 'GET', '/api/cancel': 'POST' };
    if (!Object.hasOwn(method, req.url)) return reply(res, 404);
    if (req.method !== method[req.url]) return reply(res, 405);
    if (req.method === 'GET') {
      return authenticated(req) ? reply(res, 200, snapshot()) : reply(res, 401);
    }
    if (req.headers.origin !== origin) return reply(res, 403);
    if (req.headers['content-type'] !== 'application/json') return reply(res, 415);
    const body = await readBody(req);
    // Exact syntax excludes extra/duplicate keys and all browser-chosen authority.
    const bootstrap = req.url === '/api/session';
    if (!(bootstrap
      ? /^\s*\{\s*"bootstrapToken"\s*:\s*"[^"\\]*"\s*\}\s*$/.test(body)
      : /^\s*\{\s*\}\s*$/.test(body))) return reply(res, 400);
    let value;
    try { value = JSON.parse(body); } catch { return reply(res, 400); }
    // No await between final expiry/authorization and capability consumption/state change.
    if (bootstrap) {
      if (!active() || sessionToken || !equal(value.bootstrapToken, bootstrapToken)) return reply(res, 401);
      sessionToken = token();
      csrfToken = token();
      return reply(res, 200, { csrfToken }, {
        'set-cookie': `installer_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    if (!authenticated(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return reply(res, 401);
    state = 'cancelled';
    return reply(res, 200, snapshot());
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    handle(req, res).catch((code) => {
      if (!res.headersSent && !res.destroyed) reply(res, Object.hasOwn(errors, code) ? code : 500);
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.setTimeout(5000, (socket) => socket.destroy());
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  boundHost = `127.0.0.1:${server.address().port}`;
  origin = `http://${boundHost}`;
  let closing;
  return {
    origin, bootstrapToken,
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          for (const socket of sockets) socket.destroy();
          sessionToken = '';
          csrfToken = '';
        });
      }
      return closing;
    },
  };
}
