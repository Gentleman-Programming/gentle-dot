import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseCatalog, loadRelease, RELEASE_API, REPOSITORY } from './releases.mjs';
const tag = 'v0.1.0';
const asset = name => ({ name, state: 'uploaded', size: 2048, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(name)}` });
const names = ['gentle-dot-windows-x64-setup.exe','gentle-dot-windows-arm64-setup.exe','gentle-dot-macos-x64.dmg','gentle-dot-macos-arm64.dmg','gentle-dot-linux-amd64.deb','gentle-dot-linux-aarch64.deb'];
const release = assets => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`, assets });

test('published assets map all six native targets without changing input or constructing downloads', () => {
 const input = release(names.map(asset)); const before = structuredClone(input); const result = releaseCatalog(input);
 assert.equal(result.state, 'ready'); assert.equal(result.version, tag);
 assert.deepEqual(Object.keys(result.downloads).sort(), ['linux-arm64','linux-x64','macos-arm64','macos-x64','windows-arm64','windows-x64']);
 assert.equal(result.downloads['windows-x64'].url, input.assets[0].browser_download_url);
 assert.equal(result.downloads['linux-x64'].name, names[4]); assert.deepEqual(input, before);
});

test('unpublished, QA, ambiguous and unsupported assets never produce a download', () => {
 for (const input of [null, {}, release([]), { ...release(names.map(asset)), draft: true }, { ...release(names.map(asset)), prerelease: true }, release([asset('gentle-dot-windows-x64-qa-setup.exe')]), release([asset('gentle-dot-windows-setup.exe')]), release([asset(names[0]), asset(names[0])])]) {
  const before = structuredClone(input); const result = releaseCatalog(input);
  assert.equal(result.state, 'unavailable'); assert.deepEqual(result.downloads, {}); assert.deepEqual(input, before);
 }
});

test('remote metadata cannot introduce unsafe, off-repository or mismatched executable links', () => {
 for (const url of ['javascript:alert(1)', 'http://github.com/'+REPOSITORY+'/releases/download/v0.1.0/'+names[0], 'https://example.com/setup.exe', 'https://github.com/other/repo/releases/download/v0.1.0/'+names[0], asset(names[0]).browser_download_url+'?redirect=evil', asset(names[0]).browser_download_url+'#evil', 'https://user:pass@github.com/'+REPOSITORY+'/releases/download/v0.1.0/'+names[0], asset(names[1]).browser_download_url]) {
  const input = release([{ ...asset(names[0]), browser_download_url: url }]); const before = structuredClone(input);
  assert.deepEqual(releaseCatalog(input).downloads, {}); assert.deepEqual(input, before);
 }
 for (const size of [0, -1, NaN, Number.MAX_SAFE_INTEGER+1]) assert.deepEqual(releaseCatalog(release([{ ...asset(names[0]), size }])).downloads, {});
 assert.deepEqual(releaseCatalog({ ...release(names.map(asset)), html_url: 'https://example.com/release' }).downloads, {});
});

test('public release loading distinguishes availability, errors and retry without credentials', async () => {
 let calls = 0;
 const ready = await loadRelease(async (url, options) => { calls++; assert.equal(url, RELEASE_API); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.equal(options.headers.Authorization, undefined); return { status: 200, ok: true, json: async () => release(names.map(asset)) }; });
 assert.equal(ready.state, 'ready'); assert.equal(calls, 1);
 const missing = await loadRelease(async () => ({ status: 404, ok: false })); assert.equal(missing.state, 'unavailable'); assert.deepEqual(missing.downloads, {});
 for (const fetcher of [async () => { throw Error('offline'); }, async () => ({ status: 403, ok: false }), async () => ({ status: 200, ok: true, json: async () => { throw Error('bad json'); } })]) {
  const result = await loadRelease(fetcher); assert.equal(result.state, 'error'); assert.deepEqual(result.downloads, {});
 }
 const retried = await loadRelease(async () => ({ status: 200, ok: true, json: async () => release(names.map(asset)) })); assert.equal(retried.state, 'ready');
});
