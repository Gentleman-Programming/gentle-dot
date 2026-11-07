# Voice availability tooltips in Spanish

T6B adds optional origin metadata from authored native-status and source-selection
fallbacks to the disabled microphone's tooltip. Raw `reason`, helper arguments,
source priority and button guards remain unchanged; only Composer localizes display.
Supplied native reasons, English collisions and empty strings remain raw. An empty
reason still hides the mic through the hook's existing truthy branch. Unannotated
legacy microphone props keep their previous literal title.

`nativeVoiceStatus` marks only its missing/non-string/caught-status fallback.
`chooseVoiceSource` marks its insecure/no-recorder fallbacks and carries known
native ownership, never inferring it from English. Settings reads route kind only;
no new reason consumer was introduced. `setRoute` updates changed metadata silently
when kind/raw reason are identical, without route notifications or capture changes;
identical metadata preserves the previous object identity as before.

## Historical evidence

These results describe earlier retained source, not the current integration.
Joined renderer/type/build/browser validation remains pending.

- RED: three missing-Spanish failures, 42 previous/raw tests passed.
- GREEN: 63 renderer tests; final 75 across four files, exit 0, empty stderr.
- Pure routing: 11 tests, exit 0, empty stderr; original priority/default/argument
  assertions remain, with intentional optional origin on the owned insecure DTO.
  New checks pin metadata-only removal, unchanged notification count/object identity,
  zero hardware calls and unchanged capture ownership.
- Current `main.tsx`/`useVoice.ts`, voice fixtures and prior recording-note test
  strict source checks exit 0; both streams empty. This is not global typing.

Tests use mocked IPC/media only and assert en/es tooltip changes, disabled guards,
zero captures/sends, native missing/non-string/rejected fallbacks and raw collisions/
empty reasons. Local verification artifacts are retained but not distributed.
Runtime/native refusals, diagnostic observer propagation and output producers remain
sequential C–E work. No browser, actual audio device, OS permission, native engine,
daemon or installed-platform acceptance is claimed.
