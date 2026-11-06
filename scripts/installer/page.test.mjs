import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startInstallerSession } from './server.mjs';

const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
async function setup(t) {
  const host = await startInstallerSession();
  t.after(() => host.close());
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(host.origin, { path, method, agent: false, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { ...host, request };
}
function rejected(res, code, error) {
  assert.equal(res.status, code);
  assert.equal(res.text, JSON.stringify({ error }));
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['set-cookie'], undefined);
}

test('fixed source assets have strict headers, correct MIME and no bootstrap reflection', async (t) => {
  const s = await setup(t);
  for (const [path, mime, marker] of [
    ['/', 'text/html', '<h1>Gentle Dot setup</h1>'],
    ['/page.css', 'text/css', ':focus-visible'],
    ['/page.js', 'text/javascript', 'history.replaceState'],
    ['/favicon.svg', 'image/svg+xml', '<svg'],
  ]) {
    const res = await s.request(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], `${mime}; charset=utf-8`);
    assert.equal(res.headers['content-security-policy'], csp);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.ok(res.text.includes(marker));
    assert.ok(!res.text.includes(s.bootstrapToken));
  }
});

test('asset guards reject exact-path, method and authority violations without consuming bootstrap', async (t) => {
  const s = await setup(t);
  for (const path of ['/', '/page.css', '/page.js', '/favicon.svg']) {
    rejected(await s.request(path, { headers: { host: 'evil.invalid' } }), 403, 'Forbidden');
    rejected(await s.request(path, { headers: { origin: 'https://evil.invalid' } }), 403, 'Forbidden');
    for (const method of ['POST', 'HEAD', 'OPTIONS']) {
      const res = await s.request(path, { method });
      if (method === 'HEAD') {
        assert.equal(res.status, 405);
        assert.equal(res.text, ''); // HTTP suppresses all HEAD response bodies.
        assert.equal(res.headers['set-cookie'], undefined);
      } else rejected(res, 405, 'Method not allowed');
    }
    rejected(await s.request(`${path}?asset=page.css`), 404, 'Not found');
  }
  for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/page.html', '//page.js', '/page.js/', '/server.mjs']) {
    rejected(await s.request(path), 404, 'Not found');
  }
  const login = await s.request('/api/session', {
    method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: s.bootstrapToken }),
  });
  assert.equal(login.status, 200);
  const csrf = JSON.parse(login.text).csrfToken;
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const status = await s.request('/api/status', { headers: { cookie, accept: 'text/html' } });
  assert.equal(status.status, 200);
  assert.equal(status.text, '{"state":"idle","installationAvailable":false}');
  assert.equal(status.headers['content-security-policy'], undefined);
  const cancel = await s.request('/api/cancel', {
    method: 'POST', headers: { cookie, origin: s.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.text, '{"state":"cancelled","installationAvailable":false}');
});
