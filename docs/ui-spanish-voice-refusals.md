# Runtime and native voice refusals in Spanish

T6C identifies runtime-owned preference/admission/device/permission failures and
native wrapper defaults explicitly. `VoiceFailure` remains an Error with the same
`message` and string conversion. Only its known constructor origins attach a typed
display marker. There is no English matching, new permission or native command.

`startRefusal(error): string` is unchanged. A separate display reader carries an
owned Error's marker, or marks the existing unknown-value fallback. Supplied
nonempty strings/Errors remain raw; supplied empty strings/Errors keep the old
unannotated English fallback. Native error events likewise preserve supplied
strings, including the old empty-string → `Listening stopped.` policy without a
marker. Missing/non-string event messages own the marked fallback. Raw event
callbacks still receive one argument; only the additive owned case supplies an
optional second metadata argument.

The hook maps raw refusals first and passes metadata separately to Composer.
Generation, diagnostic-token validation, capture admission, saved preferences,
retirement and IPC arguments/guards are unchanged. Check-observer propagation is
still the separate T6D slice; output/sentinel behavior is T6E and remains untouched.

## Historical evidence

These results describe earlier retained source, not the current integration.
Joined renderer/type/build/browser validation remains pending.

- RED: seven missing metadata failures/11 Node passes; four missing-Spanish
  failures/52 renderer passes, before production edits.
- Final: 97 renderer tests across four files and 38 pure routing/controller Node
  tests pass. Current entrypoint/new-test strict source TypeScript exits 0;
  renderer, Node and compiler stderr are empty.
- Public helper tests pin every owned Error's message/string conversion, refusal
  before capture, unchanged saved choices and exact attempted calls. Actual-hook
  tests cover preference/permission/native unsupported/missing/browser missing,
  native defaults/collisions/empty policies, and diagnostic-token rejection with
  zero mocked IPC calls. Existing English behavior assertions remain.

Local verification artifacts are retained but not distributed.
Active LSP retained eleven contradictory stale dependency diagnostics despite
producer refresh; exact findings were recorded as false positives against actual
exports/fields and the current strict compiler result, not claimed LSP clean.
Three pre-existing auxiliary `uploads.ts` findings were deferred, not fixed or
suppressed: WebSocket/URL handling and unchecked success-body conversion. That
file is unchanged against C's base `8446bdd`; no global-clean claim is made.
No real device, account, daemon, native operation, browser or installed-platform
acceptance was exercised. Whole T6/F2c and final T9 integration remain incomplete.
