# Windows Hide: resolved incident and trace retirement

An earlier installed-build report confirmed the Hide correction and requested
trace removal. That observation concerns an older source revision, not acceptance
of the current integration.

## Correction retained

The diagnostic trace showed successful hide-intent updates but a still-visible
panel after Tauri Hide. Matching-version source (`tao 0.37.1`,
`tauri-runtime-wry 2.12.1`) uses a cached `VISIBLE` bit and skips visibility work
when that bit does not change. Working previously hid the panel through Tauri,
then restored it with native `ShowWindow(SW_SHOWNA)`. This can leave the cache
hidden while Windows displays the panel; the installed cache bit was not sampled.

Windows Working now temporarily hides **only the panel** with native `SW_HIDE`,
matching its existing nonactivating restoration without changing user intent or
Tauri's cached bit. The helper requires the panel label, own process and current
owner thread, then checks the actual visibility flag after hiding. Dot and other
platforms retain their ordinary hide path.

The manual Hide command/result, shared Hide/Escape error notices, fullscreen
mutex boundary, current-intent restoration, Stop/session, capture exclusion,
protected-target and input guards remain intact. Hide is not Stop. No
focus-taking show, cache-toggle workaround, dependency patch or elevation bypass
was added.

## Temporary instrumentation removed

The source no longer contains the trace logger/writer, native visibility-event
observer, trace startup state, phase calls, correlation IDs, Escape capture
listener, button pointer diagnostics, trace IPC command or its panel permission.
The ordinary Escape handler and button click still use the shared hide action.
Trace-only tests were retired; Hide behavior, Escape routing, absence-of-tracing
and guarded temporary native hiding retain focused regression checks.

Previously collected `hide-trace-<pid>-<start-time-ms>.log` files and local
success/failure evidence are preserved. There is no automatic cleanup or
retention policy, and this removal does not read or delete installed logs.
An already installed instrumented application continues tracing until replaced
with a build of the cleaned source.

## Verification limits

On the earlier retained source, the correction passed five focused Rust tests
and Windows NSIS/MSI packaging before the reported functional acceptance. Acceptance is the owner's functional observation,
not an exhaustive Windows 10/11 matrix, native review approval, or embedded
payload identity verification. Local source/mocked tests for trace retirement
do not establish a new Windows compilation or installed trace-free behavior.
