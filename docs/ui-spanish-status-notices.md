# Spanish status notices — T8

## Covered behavior (S1–S4)

The renderer annotates known authored origins, without changing their raw strings:

- `store.ts`: the `message_done.stopped` fallback and connector-import result wrappers.
- `useDot.ts`: the locally refused send's disconnected notice.
- `App.tsx`: the hide-failure wrapper, with a separate literal native reason.
- `ChatSurface.tsx`: local PIN-dialog cancellation, with outer renderer metadata.

`MessageList` renders annotated stopped notes with the current locale. `ChatSurface`
uses the same display helper for annotated notices. Changing locale updates already
rendered annotated text without replaying a request. Connector names are inserted
literally, including `$&`, braces, empty names, and English-looking data.

Unannotated server errors/toasts, caller notices, history/synthetic notes, and
user/assistant content remain raw. An error supplied as `""` still wins over the
stopped fallback. `addNotice` still drops empty messages; this is not repaired.
Metadata is optional UI state only: no protocol or persisted schema changed.

The header's existing nullish title branch remains unchanged: missing titles use
localized copy, whereas supplied `"New conversation"` and `""` stay raw.
`activeTitle` remains its default-English pure helper, not a localized consumer.

## Preserved contracts

No transport, native, voice, cancellation, session, or storage lifecycle was changed.
The disconnected-send path now creates a renderer notice directly rather than a
synthetic server `offline` error; its level, raw message, failed-send return and
wire payload are unchanged. Successful sends do not add a notice.

The follow-up closes the two explicitly deferred origins from the initial slice.
`App` retains the original creation-time localized `notice.message`, level and raw
`String(error)` reason. Optional `hideFailed` display metadata allows mounted
locale changes to update only the wrapper, never invoking hide again. Empty
reasons, English-looking native text and replacement-like `$&` remain literal.

PIN cancellation still clears the pending dialog and dispatches the same nested
server error (`code: "declined"`, `message: "Nothing was changed."`, `seq: 0`).
Only the outer renderer action gains `pinCancelled` metadata. The original error
reducer, including starting-connector-flow cleanup, runs before the metadata is
attached to its notice. Running flows remain intact. Empty messages still drop
at `addNotice`, including when annotated; starting-flow cleanup still happens.
Identical unannotated backend errors remain raw. No PIN is entered or sent during
cancellation and no permission/native guard was relaxed.

## Historical verification

These observations belong to earlier retained source, not this integration.
Joined renderer/type/build/browser validation remains pending.

Synthetic public renderer/hook tests exercise both languages, mounted locale
switches, literal collisions, empty errors/titles/notices, exact dismiss/navigation
and busy-switch cancel/confirm callbacks, and exact outbound send payloads with a
mock client. Follow-up tests additionally assert all prior raw hide-action fields
plus the intentional optional metadata, exact PIN-cancel actions/no outbound
command, mounted en/es wrapper changes, empty/native-collision reasons and
starting/running/no-flow parity against the unannotated error reducer. The existing
hide-action assertion was extended, not weakened; other existing tests remain
unchanged. All native operations are mocked. No daemon, native engine, hardware,
Windows, account, or E2E runner ran.

Local verification artifacts are not distributed. Initial RED recorded four
failures and two passes; focused GREEN and regression records include combined
stdout/stderr and exit codes. Follow-up evidence was appended separately: RED
recorded six intended failures/25 passes, with follow-up GREEN also retained;
the original failure captures remain intact. Parent readback, the 152-test/10-file
joint check and strict current
`main.tsx`/`useVoice.ts` entrypoint checks passed with empty stderr. Earlier source assessments were not review approval. No global typing, browser, installed-app or platform acceptance is
claimed here.
