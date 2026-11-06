# Local setup session

**Implemented:** a host-callable loopback session API and accessible browser
frontend shell in `scripts/installer/`. Installation is always unavailable in
this build: the production trust key is unconfigured and native installation is
not connected. This is not a completed production installer. There is no CLI,
automatic browser launch, package verification, application shutdown or OS
operation. The separate host-only downloader below has no HTTP route. Installer
authority remains separate from agent and daemon APIs.

## Installed desktop diagnostics (read-only)

Open **Settings → Bundled runtime diagnostics** in the native panel. The same
checks appear below the original assistant connection error when the assistant
cannot start. Opening either view queries once; **Refresh bundled-file checks**
queries again. Browser mode never invokes these diagnostics.

The panel-only Tauri command `installer_readiness` accepts **no client arguments**.
It checks metadata only under the app's `resource_dir/runtime`, ignoring runtime
and executable overrides. Its JSON is `{processOs, compiledArch, runtimeTarget,
checks: [{path, status}]}`; paths are fixed bundle-relative names, never user-home
paths. `status` is `present` for a regular file, `missing` for absent paths, or
`unknown` for inaccessible/nonregular/link paths or unavailable resources.
Unsupported compiled targets have a null target and no file checks. Supported
mappings match `scripts/package/lib.mjs`: Windows x64, macOS arm64, Linux arm64/x64.

Checks cover the bundled Node, daemon entry/package, Gentle Shell entry, engine
package metadata, Engram executable, pi wrapper, UI entry and informational
MANIFEST.json; Windows also checks its native stop addon. These are selected
file facts, not complete payload validation. No files are read or executed,
no registry/network/user-data queries occur, and no installation is enabled.
Process OS and compiled architecture are **not** physical CPU or host OS-version
probes. OS versions, GUI prerequisites and component versions remain unknown.
Manifest presence does not authenticate the publisher or validate a version.

This requires an already-running native UI: it does **not** solve fresh-PC
WebView or Linux GUI-library absence, pre-install bootstrap, native installation,
cryptographic verification, or native platform/IPC acceptance. Those remain
separate T3/T4 gates. Shipped app users do not need global Node, npm, Git, Rust,
MSVC or Go for these checks; those tools are not end-user prerequisites.

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
- The trusted host opens `${origin}/#${bootstrapToken}` locally. Never log this
  URL or token, put it in a query, or send it to a remote browser service. Page
  JavaScript captures the fragment and immediately erases it with
  `history.replaceState`, before the session exchange. It never puts tokens in
  DOM, storage or logs. Bootstrap, session and CSRF values are independent random
  256-bit values held in memory; the cookie is HttpOnly. Nothing provisions trust.
- Always await `close()` on host teardown. It is idempotent and closes only this
  listener and its sockets, invalidating the session. Expiry does not close the
  listener automatically; ownership of teardown remains with the host.

## Browser flow and fixed assets

The page exchanges the one-use fragment with `POST /api/session`, reads
`GET /api/status` once, and enables **Cancel setup session**. Cancellation sends
exactly `{}` with the CSRF header and cookie; it never shuts down Dot. Missing,
invalid/expired/used links, network failures, unexpected responses and cancellation
have explicit live status messages. There is no polling or automatic retry.
Reopen from the trusted host for a fresh session, rather than reload a used link.
JavaScript is required; without it the page explains that requirement.

Only literal `GET /`, `/page.css`, `/page.js` and `/favicon.svg` serve assets,
after the same exact Host/Origin checks. Source filenames are fixed, never built
from request input. Asset queries, traversal, trailing slashes and other paths
are rejected. Assets use correct MIME, no-store, nosniff and no-referrer, plus
CSP restricting scripts/styles/connections/images to self, everything else to
none, with no inline execution, frames, base URL or forms. The page uses local
system-font fallbacks and the existing UI token palette; no external resources.
It makes no package-check, installed-version, notarization or malware-free claim,
and does not touch conversations, configuration, memory or credentials.

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
All API responses and route errors use JSON, `Cache-Control: no-store`,
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

The public HTTP suite is
`node --test scripts/installer/server.test.mjs scripts/installer/page.test.mjs`.
It uses only owned loopback sockets and synthetic in-memory tokens, with no
filesystem fixtures. It proves asset guards and existing API behavior, not UI
execution. Actual browser keyboard, console, session/cancel and responsive checks
at 320/768/1024/1440 remain a separate required acceptance gate.

Production trust remains missing and installation is always unavailable. T1's
[release verification primitive](release-verification.md) is unchanged and not
called by the session server. The separate downloader reuses it unchanged.
`node --test scripts/updates/download.test.mjs` uses synthetic in-memory Ed25519
keys and fake host fetch/streams only: **not actual native HTTPS, installed,
production-trust or OS-permission proof**. Native action integration,
replacement/recovery and macOS/Linux CI remain future slices. Free project signatures do not remove
Gatekeeper warnings, grant permissions or establish paid OS signing.
See [release trust boundaries](release-verification.md) before future integration.
