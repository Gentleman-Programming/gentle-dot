# Installer session security core

**Implemented:** a Node-builtins-only, host-callable loopback session API in
`scripts/installer/server.mjs`. This is not a browser installer or verified
installation. It has no CLI, HTML, browser launch, download, verification,
application shutdown or OS operation. A separate host-only verified downloader is
available below; it is not connected to any HTTP route. Installer authority is
separate from the agent and daemon APIs.

## Host integration

Import `startInstallerSession` and await `startInstallerSession({ ttlMs, now })`.
It returns `{ origin, bootstrapToken, close }`. No server starts on import.

- The only listener is `127.0.0.1`, using an OS-assigned ephemeral port.
- `ttlMs` defaults to 300000; allowed values are integers from 1 through 3600000.
  Expiry is absolute from factory invocation, not refreshed by requests. At the
  deadline, bootstrap, status and cancellation are unauthorized.
- `now` defaults to `Date.now`; a host-only finite millisecond clock supports
  deterministic tests. It must be monotonic. Backwards/invalid readings fail
  closed. Unknown options fail with `TypeError('Invalid session options')`.
- Deliver `bootstrapToken` only through a trusted host channel. Do not log it or
  put it in URLs. Bootstrap, session and CSRF values are independent, random
  256-bit values held only in memory. The host must also keep CSRF/cookies out
  of logs. Nothing writes credentials or provisions production trust.
- Always await `close()` on host teardown. It is idempotent and closes only this
  listener and its sockets, invalidating the session. Expiry does not close the
  listener automatically; ownership of teardown remains with the host.

## Fixed HTTP contract

Every request must have the exact bound `Host`, including port. Any supplied
`Origin` must exactly equal `origin`; both POST routes require it. There are no
CORS permit headers. Queries, trailing slashes and unknown routes return 404;
wrong methods (including OPTIONS) return 405. No request selects host, path,
command, URL, trust key, TTL or clock.

| Route | Required input | Success |
| --- | --- | --- |
| `POST /api/session` | `Content-Type: application/json`, body `{"bootstrapToken":"<host token>"}`, exact Origin | 200, only `{"csrfToken":"<token>"}` and `installer_session=<token>; HttpOnly; SameSite=Strict; Path=/` cookie |
| `GET /api/status` | Session cookie; matching Origin if supplied | 200, `{"state":"idle","installationAvailable":false}` (or state `cancelled`) |
| `POST /api/cancel` | Session cookie, `X-CSRF-Token`, exact Origin, JSON body `{}` | 200, `{"state":"cancelled","installationAvailable":false}` |

POST bodies are capped at 1024 bytes, including whitespace. Only the exact
listed fields are accepted: no duplicate keys, arrays, extra fields or escaped
bootstrap field/token spelling. Bootstrap is one-use; rejected requests and
replays never replace an existing session. Cancellation changes only in-memory
`idle` to `cancelled`; repeats return the same 200 snapshot. Status still works
after cancellation. Cancellation does not stop an application or the server.
Authorization and expiry are rechecked after body receipt, immediately before
capability consumption or state change, without an intervening await.

Route errors are fixed JSON `{"error":"<message>"}`: 400 `Invalid body`,
401 `Unauthorized`, 403 `Forbidden`, 404 `Not found`, 405 `Method not allowed`,
413 `Body too large`, 415 `Unsupported media type`, 500 `Internal error`.
Responses do not echo tokens or input (except the successful CSRF response).
All route responses use JSON, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and connection
close. Headers are capped at 8192 bytes; header/request/socket timeouts are
5 seconds, with a 1-second keep-alive bound. HTTP-parser/timeout disconnects
are transport failures, not application JSON responses.

## Host-only verified download

Import `createReleaseDownloader` from `scripts/updates/download.mjs` (Node >=24).
Construct it only in trusted host code, never from browser-supplied configuration:

```js
const download = createReleaseDownloader({
  publicKey: independentlyPinnedPublicKey,
  platform: 'linux-amd64', currentVersion: '1.2.2', format: 'deb',
  maxBytes: hostApprovedMemoryBudget,
  fetch: hostFetch, timeoutMs: 30000,
});
const { release, bytes } = await download(untrustedEnvelope);
```

`release` is T1's `{schemaVersion, version, artifact}` descriptor; `bytes` is a
new Uint8Array, returned only after T1 verifies the selected artifact's exact
size and SHA-256. There is no partial success, cache, file output or installation.
A failed call does not change the factory configuration or prevent a later call.

- `publicKey` is required: a public Ed25519 KeyObject or SPKI `PUBLIC KEY` PEM
  string/Buffer. Private keys and other algorithms fail. The constructor snapshots
  the normalized public key, platform, current version, format and transport;
  later options/Buffer mutation cannot change trust or selection. There is no key
  discovery, production default or browser-selected trust/budget/transport.
- `maxBytes` is **required**, a positive finite safe integer chosen by the host.
  No production package-size budget is guessed. `timeoutMs` defaults to 30000 and
  accepts integers 1–2147483647. `fetch` defaults to the host's captured global
  fetch function. `format` defaults to `dmg` for macOS and `deb` for Linux.
  Targets, formats and stable versions follow the unchanged
  [release verification contract](release-verification.md).
- T1 authenticates the envelope and selects the exact HTTPS GitHub asset URL
  before any transport. Signed size above `maxBytes` fails before fetch. Streaming
  is bounded by both signed size and budget; Content-Length is ignored. Memory
  retains at most the signed-size output buffer, plus transport-owned chunks.
- The only fetch options are `redirect: 'manual'`, `credentials: 'omit'` and an
  owned AbortSignal: no authentication or authority headers. Only status 200 with
  `redirected: false` is accepted. **Every redirect is rejected**, including an
  automatically followed response; Location is never followed. Actual GitHub
  release CDN redirect support is unimplemented and fails closed.
- One finite total timeout spans fetch and body consumption. Completion/failure
  aborts the owned request, cancels the reader and clears the timer. Cancellation
  is best effort without waiting on an uncooperative transport; a late response
  after timeout has its body cancelled too. The injected transport is trusted
  host code and must honor manual redirects, credential omission and abort.

Constructor errors are `Error('Invalid downloader public key')` or
`Error('Invalid downloader options')` (including unknown options). Calls reject
with unchanged T1 verification errors, or `Artifact exceeds download budget`,
`Download response rejected`, `Invalid download body`,
`Artifact exceeds download bounds`, `Download timed out`. T1 byte mismatches are
`Artifact size mismatch` / `Artifact SHA-256 mismatch`; native transport/stream
errors propagate. Nothing returns a verified descriptor or bytes on failure.

## Evidence boundary and next gate

The public HTTP suite is `node --test scripts/installer/server.test.mjs`.
It uses only its own loopback sockets and synthetic in-memory tokens, with no
filesystem fixtures. No existing command shares this new module.

Production trust remains missing and installation is always unavailable. T1's
[release verification primitive](release-verification.md) is unchanged and not
called by the session server. The separate downloader reuses it unchanged.
`node --test scripts/updates/download.test.mjs` uses synthetic in-memory Ed25519
keys and fake host fetch/streams only: **not actual native HTTPS, installed,
production-trust or OS-permission proof**. Browser UI, native replacement/recovery
and macOS/Linux CI remain future slices. Free project signatures do not remove
Gatekeeper warnings, grant permissions or establish paid OS signing.
See [release trust boundaries](release-verification.md) before future integration.
