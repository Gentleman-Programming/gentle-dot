# Settings body follows the interface language

T3 translates Settings-owned shortcut, memory and speech-language copy in English and Spanish. The existing interface-language selector and locale API are unchanged. Speech-language autonyms and stored values are not interface copy.

## Historical retained-source verification

The observations below belong to an earlier source revision. Current integrated
renderer/type/build/browser validation is pending; these are not current passes.

Focused renderer command (mocked Tauri transport; real App, Settings and voice-device child components):

```sh
./node_modules/.bin/vitest run --project ui packages/ui/test/settings.test.tsx --cache=false
```

Each earlier run retained separate stdout/stderr and completed within 30 seconds.
Private scratch paths are not distributed.

| Phase | Observed result | Stdout / stderr bytes |
| --- | --- | --- |
| RED, new tests before implementation | Exit 1; 8 new localized tests failed, 22 existing tests passed | 1145 / 81095 |
| GREEN | Exit 0; 30 tests passed | 267 / 0 |
| Triangulation | Exit 0; 33 tests passed | 267 / 0 |

RED failed on missing Spanish headings, controls and load-error copy, not transport availability. Triangulation adds non-Mac modifier/cancellation coverage and additional raw native-error cases. Existing English shortcut/Settings tests remain intact; these 33 tests are new-task evidence, not the prior combined 31-test baseline.

## Self-review: S1–S4

- **S1, continuation:** T3 only. Shortcut heading/help, recording/cancel/change, applying/saved/default title/reset, memory heading/help/switch/failures, and voice-language heading/help/accessible name/automatic option now follow the active locale. Mounted pending/success/failure displays react to locale changes.
- **S2, Spanish interface:** rendered Spanish controls are exercised, including both memory directions, speech selection/reset, shortcut application/reset, button cancellation and Esc cancellation. Modifier-only keys still wait.
- **S3, previous behavior and raw data:** all 22 existing tests pass. Exact `shortcut_set` accelerators and `memory_set` values are asserted. Speech autonyms/codes and storage values remain unchanged; interface/speech selection makes no extra native calls. Pure `voice-language.ts` data and exported helpers are untouched. Existing root locale keys remain untouched.
- **S4, environment and failure boundaries:** synthetic renderer state and mocked commands only; no daemon, real profile, Windows, installs or global configuration changes. Load failures retain disabled controls. Rejected writes retain the prior value. Nonempty native/backend strings and Error messages remain verbatim, including strings identical to English fallbacks. Only missing reasons use semantic authored fallbacks, selected at render time without string matching.

## Boundaries and risk

Memory mode semantics, the deferred R10 issue, live/unmount guards, recording event capture, registration calls and preference persistence are unchanged. Voice-device child copy belongs to the later voice task; the real child remains mounted with the existing unsupported-device mock response. No full F2c, full-suite, browser, native registration or installed Windows acceptance is claimed. The remaining diff risk is display translation/template accuracy and internal fallback provenance representation, not a new protocol or lifecycle contract.
