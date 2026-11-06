# Installer session security core

**Implemented:** a Node-builtins-only, host-callable loopback session API in
`scripts/installer/server.mjs`. This is not a browser installer or verified
installation. It has no CLI, HTML, browser launch, download, verification,
application shutdown or OS operation. Installer authority is separate from the
agent and daemon APIs.

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

## Evidence boundary and next gate

The public HTTP suite is `node --test scripts/installer/server.test.mjs`.
It uses only its own loopback sockets and synthetic in-memory tokens, with no
filesystem fixtures. No existing command shares this new module.

Production trust remains missing and installation is always unavailable. T1's
[release verification primitive](release-verification.md) is unchanged and not
called here. Verified downloads, browser UI, native replacement/recovery and
macOS/Linux CI are separate future slices. Free project signatures would not
remove Gatekeeper warnings, grant permissions or establish paid OS signing.
See [distribution boundaries](distribution.md) before future integration.
