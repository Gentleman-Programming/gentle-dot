import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-type': 'application/json; charset=utf-8',
};
async function session(t, options) {
  const { startInstallerSession } = await import('./server.mjs');
  const host = await startInstallerSession(options);
  t.after(() => host.close());
  const url = new URL(host.origin);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0);
  assert.match(host.bootstrapToken, /^[a-f0-9]{64}$/);
  const request = (path, { method = 'GET', body, beforeEnd, ...extra } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${host.origin}${path}`, {
      method, agent: false,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        for (const [key, value] of Object.entries(headers)) assert.equal(res.headers[key], value);
        assert.equal(res.headers['access-control-allow-origin'], undefined);
        resolve({ status: res.statusCode, body: JSON.parse(text), cookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    if (beforeEnd) {
      req.write(' ');
      Promise.resolve().then(beforeEnd).then(() => req.end(body), reject);
    } else {
      req.end(body);
    }
  });
  const bootstrap = () => request('/api/session', {
    method: 'POST', origin: host.origin, body: JSON.stringify({ bootstrapToken: host.bootstrapToken }),
  });
  const login = async () => {
    const res = await bootstrap();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['csrfToken']);
    assert.match(res.body.csrfToken, /^[a-f0-9]{64}$/);
    assert.notEqual(res.body.csrfToken, host.bootstrapToken);
    assert.equal(res.cookie.length, 1);
    assert.match(res.cookie[0], /^installer_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.notEqual(res.cookie[0].split('=')[1].split(';')[0], res.body.csrfToken);
    return { cookie: res.cookie[0].split(';')[0], 'x-csrf-token': res.body.csrfToken, origin: host.origin };
  };
  return { ...host, request, bootstrap, login };
}
const idle = { state: 'idle', installationAvailable: false };
const cancelled = { state: 'cancelled', installationAvailable: false };
function error(res, status, message) {
  assert.equal(res.status, status);
  assert.deepEqual(res.body, { error: message });
  assert.equal(res.cookie, undefined);
}
async function status(s, auth, expected = idle) {
  const res = await s.request('/api/status', auth);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, expected);
  assert.equal(res.cookie, undefined);
}
const cancel = (s, auth, extra = {}) => s.request('/api/cancel', { method: 'POST', body: '{}', ...auth, ...extra });

test('exact loopback Host and Origin; rejected bootstrap does not consume capability', async (t) => {
  const s = await session(t);
  for (const host of ['localhost', '127.0.0.1:1', 'evil.invalid']) {
    error(await s.request('/api/session', { method: 'POST', host, origin: s.origin, body: '{}' }), 403, 'Forbidden');
  }
  error(await s.request('/api/session', { method: 'POST', body: JSON.stringify({ bootstrapToken: s.bootstrapToken }) }), 403, 'Forbidden');
  for (const origin of ['', 'null', 'https://evil.invalid', `${s.origin}/`]) {
    error(await s.request('/api/session', { method: 'POST', origin: origin ?? '', body: JSON.stringify({ bootstrapToken: s.bootstrapToken }) }), 403, 'Forbidden');
  }
  error(await s.request('/api/session', { method: 'POST', origin: s.origin, body: '{"bootstrapToken":"bad"}' }), 401, 'Unauthorized');
  error(await s.request('/api/session', { method: 'POST', origin: s.origin, body: JSON.stringify({ bootstrapToken: 'é'.repeat(64) }) }), 401, 'Unauthorized');
  error(await s.request('/api/session', { method: 'POST', origin: s.origin, body: `{"bootstrapToken":"${s.bootstrapToken}","bootstrapToken":"bad"}` }), 400, 'Invalid body');
  const auth = await s.login();
  error(await s.bootstrap(), 401, 'Unauthorized');
  error(await s.request('/api/status', { ...auth, origin: 'https://evil.invalid' }), 403, 'Forbidden');
  await status(s, auth);
  await status(s, { cookie: auth.cookie });
});

test('cookie, separate CSRF and exact Origin protect cancellation; repeat is idempotent', async (t) => {
  const s = await session(t);
  error(await s.request('/api/status'), 401, 'Unauthorized');
  const auth = await s.login();
  for (const invalid of [
    { ...auth, cookie: '' }, { ...auth, 'x-csrf-token': '' },
    { ...auth, 'x-csrf-token': s.bootstrapToken }, { ...auth, origin: '' },
    { ...auth, origin: 'http://localhost' }, { ...auth, cookie: `${auth.cookie}; ${auth.cookie}` },
  ]) {
    error(await cancel(s, invalid), invalid.origin === '' || invalid.origin === 'http://localhost' ? 403 : 401, invalid.origin === '' || invalid.origin === 'http://localhost' ? 'Forbidden' : 'Unauthorized');
    await status(s, auth);
  }
  error(await cancel(s, { cookie: auth.cookie, 'x-csrf-token': auth['x-csrf-token'] }), 403, 'Forbidden');
  await status(s, auth);
  for (let i = 0; i < 2; i++) {
    const res = await cancel(s, auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, cancelled);
    await status(s, auth, cancelled);
  }
});

test('strict fixed routes and methods never mutate a valid session', async (t) => {
  const s = await session(t);
  const auth = await s.login();
  for (const path of ['/api/status?x=1', '/api/status/', '/api/install', '/api/cancel?command=x']) {
    error(await s.request(path, { ...auth, method: 'POST', body: '{}' }), 404, 'Not found');
    await status(s, auth);
  }
  for (const [path, method] of [['/api/session', 'GET'], ['/api/status', 'POST'], ['/api/cancel', 'GET'], ['/api/cancel', 'OPTIONS']]) {
    error(await s.request(path, { ...auth, method, body: '{}' }), 405, 'Method not allowed');
    await status(s, auth);
  }
});

test('bounded exact JSON rejects authority inputs and preserves session', async (t) => {
  const s = await session(t);
  for (const field of ['command', 'path', 'key', 'url']) {
    error(await s.request('/api/session', { method: 'POST', origin: s.origin, body: JSON.stringify({ bootstrapToken: s.bootstrapToken, [field]: 'untrusted' }) }), 400, 'Invalid body');
  }
  const auth = await s.login();
  for (const body of ['null', '[]', '{', '{"command":"x"}', '{"path":"x"}', '{"key":"x"}', '{"url":"x"}', '{"csrfToken":"x"}', '{}{}', ' '.repeat(1025)]) {
    error(await cancel(s, auth, { body }), body.length > 1024 ? 413 : 400, body.length > 1024 ? 'Body too large' : 'Invalid body');
    await status(s, auth);
  }
  error(await cancel(s, auth, { 'content-type': 'text/plain' }), 415, 'Unsupported media type');
  await status(s, auth);
  const res = await cancel(s, auth, { body: ' '.repeat(1022) + '{}' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, cancelled);
});

test('expiry is checked again after an asynchronous request body', async (t) => {
  let clock = 100;
  const s = await session(t, { ttlMs: 10, now: () => clock });
  const auth = await s.login();
  await status(s, auth);
  clock = 109;
  await status(s, auth);
  const pending = cancel(s, auth, { beforeEnd: async () => {
    await status(s, auth);
    clock = 110;
  } });
  error(await pending, 401, 'Unauthorized');
  error(await cancel(s, auth), 401, 'Unauthorized');
  error(await s.request('/api/status', auth), 401, 'Unauthorized');
  error(await s.bootstrap(), 401, 'Unauthorized');
  const fresh = await session(t, { ttlMs: 10, now: () => clock });
  clock = 120;
  error(await fresh.bootstrap(), 401, 'Unauthorized');
});

test('concurrent bootstrap has exactly one winner and no session replacement', async (t) => {
  const s = await session(t);
  const results = await Promise.all([s.bootstrap(), s.bootstrap()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  const winner = results.find((r) => r.status === 200);
  error(results.find((r) => r.status === 401), 401, 'Unauthorized');
  await status(s, { cookie: winner.cookie[0].split(';')[0] });
});

test('host options reject unbounded TTL and unknown configuration; close is repeatable', async (t) => {
  const { startInstallerSession } = await import('./server.mjs');
  for (const options of [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: Infinity }, { ttlMs: 3600001 }, { ttlMs: 1.5 }, { host: '0.0.0.0' }, { now: 1 }]) {
    await assert.rejects(startInstallerSession(options), { message: 'Invalid session options' });
  }
  const s = await session(t);
  await s.close();
  await s.close();
  await assert.rejects(s.request('/api/status'));
});
