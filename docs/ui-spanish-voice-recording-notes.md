# Direct recording notes in Spanish

This T6A slice translates six recording-owned outcomes in Composer: empty transcript,
oversized recording, conversion failure, recorder failure/start failure and a capture
already owned elsewhere. `VoiceControls.note` retains its exact English/raw value;
optional `noteDisplay` identifies a known origin without English matching.

The hook keeps raw text and display provenance atomically. Ordinary raw/clear paths
remove ownership, including a later backend error equal to an earlier authored note.
Repeated identical text/provenance retains state identity. Composer translates only
marked, truthy notes; legacy unannotated props and empty notes keep prior behavior.
No recording, generation, permission, retirement, cancellation, transport, preference
or send behavior changes. Only the hook and Composer consume the new optional field.

## Historical evidence

These results belong to earlier retained source, not the current integration.
Joined renderer/type/build/browser validation remains pending.

- Corrected RED: six missing-Spanish failures and five passing raw/legacy rules.
  The first conversion fixture incorrectly decorated a Blob that the hook wraps;
  its failure is retained. Spying on the Blob API fixed only that synthetic fixture.
- GREEN: 56 tests across three files; final/refactor 72 across four files, exit 0,
  empty stderr. Existing voice, composer and attachment tests remain unchanged.
- Strict current `main.tsx`/`useVoice.ts` plus new-test source checks exit 0, both
  streams empty. Initial TS2739 caught omitted required runtime fixture dependencies;
  adding mocked `nativeDevices` and `startNative` repaired only the new fixture,
  without casts, suppression or production API relaxation.
- Public real-hook/Composer tests pin English/Spanish displays, raw notes, mounted
  locale changes, exact transcription payload, zero unintended sends, tracks/capture
  ownership, raw backend collisions/sentinels/empty, stale-metadata reset and legacy props.

Separate verification logs are retained locally, not distributed.
This is not whole T6/F2c, global typing, browser or installed-platform proof. Source
availability/tooltips, runtime/native refusals, hook diagnostic observer propagation
and output producers remain the sequential B–E work. No real audio device, daemon,
account or native operation was used.
