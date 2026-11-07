# Voice check controller notes in Spanish

Test observations in this note describe earlier retained source, not the current
integration. Joined renderer/type/build/browser validation remains pending.

Controller-authored notes now display in the current UI language in `VoiceChecks`.
The original `CheckState.note` strings remain unchanged and available to English
helper consumers. This is a bounded T6 slice, not complete T6/F2c.

## Explicit ownership

An optional renderer-only `noteDisplay` discriminator identifies seven known
controller branches: input awaiting final metadata, input recognition failure,
input completion, output completion, missing driver, unknown thrown-value fallback
and cleanup failure. The controller has no locale dependency. `VoiceChecks` maps
only these semantic markers to typed `voice.*` keys; it never matches English text.

Observer errors and thrown strings/Errors remain raw, including empty strings,
English collisions and native sentinel errors. Start, cancel and raw-error paths
clear old display provenance. Locale changes rerender a marked notice without
changing controller state, restarting checks or replacing subscriptions.

## Unchanged consumers and behavior

`voice-device-runtime` constructs the controller; `useVoice` supplies its existing
check driver; `VoiceChecks` is the production state renderer. Driver/observer APIs,
raw notes, previews, route/stage values, generation guards, callback retirement,
stop/cancel behavior and the spoken test phrase remain unchanged. No native,
protocol, persisted-data or audio lifecycle behavior is added.

Synthetic controller-to-panel tests cover en/es, mounted locale changes, all marked
branches, raw collisions/empty errors and exact callbacks/state. Existing English
voice/panel and pure Node controller tests are preserved. Append-only RED/GREEN
command, stdout, stderr and exit evidence is retained locally, not distributed.

## Remaining sequential work

Runtime/device errors, native wrapper fallbacks, `useVoice` recording/deadline/
permission notes and output/synthesis producer notes remain raw and outside this
slice. They require their own provenance work; this change does not infer their
ownership from English. Parent readback and 68 renderer tests, 20 unchanged pure
Node tests and scoped strict source TypeScript checks passed with empty stderr.
The subsequent stable integration check passed 152 tests across 10 files and the
strict current `main.tsx`/`useVoice.ts` entrypoint check. Earlier source assessments were not review approval.
Whole-project typing and later browser coverage remain unclaimed. No actual
devices, downloads, daemon or platform acceptance were exercised.
