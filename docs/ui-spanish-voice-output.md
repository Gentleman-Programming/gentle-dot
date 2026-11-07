# Spanish voice-output failures without changing raw errors

The T6/E output-error unit adds display provenance for five renderer-owned failures. Composer and VoiceChecks can show Spanish while the hook note, check note and output callback message retain their original English bytes. This is a bounded continuation against `9bb0db7191a38ea30c4b80ae9e040912514eb31b`, not completion of T6 or T9.

## Review path

1. In `packages/ui/src/voice-output.ts`, inspect the five markers passed through the existing `fail` function.
2. In `packages/ui/src/useVoice.ts`, inspect forwarding to the existing private note setter and check observer.
3. In `packages/ui/src/i18n-voice-messages.ts`, inspect the English/Spanish keys and existing `recordingNoteKeys` mapping. Existing display consumers need no changes.

| Known producer | Display marker |
| --- | --- |
| Missing browser speech APIs | `outputUnavailable` |
| Browser utterance error or synchronous synthesis failure | `outputSystemFailed` |
| No voices after bounded discovery | `outputNoVoices` |
| Selected-output or routed-playback failure | `outputRouting` |
| Non-sentinel local/native output failure | `outputLocalFailed` |

## Native versus owned boundary

Provenance comes from known producers, never English-message matching. Native failures still follow the original policy: the exact string rejections `Speech request session limit reached; restart the app` and `Speech synthesis is busy` remain raw, unmarked, one-argument `onError` calls. Both exact comparisons and their no-fallback responses are unchanged. Other local/native failures still become the existing authored `Local speech failed…` message; only that owned replacement receives a marker. This does not expose or translate the underlying native error details.

The hook preserves raw notes and clears display provenance through its existing atomic setter. Unmarked observer errors retain one-argument calls. Existing supplied-empty/raw-collision policies remain unchanged; the five owned output messages themselves are nonempty. Default English display remains the original text.

## Preserved behavior

- `fail`, `stop`, generation checks and disposal retain their existing ordering; no capture, routing, fallback, cancellation, timeout or resource-release guard changes.
- Selected output never silently falls back to browser speech. Existing default-output fallback remains available.
- The spoken phrase remains exactly `Hello, this is the Gentle Dot voice output check.`; the mocked synthesis payload still contains the original request ID, text and `locale: "en"` fields.
- Checks do not send chat messages or acquire microphone capture. Playback completion still does not prove audibility.

## Historical verification and current limits

The observations below describe earlier retained source, not the current
integration candidate. Joined renderer, typing, build and browser checks remain pending.

Meaningful pre-implementation RED was recorded locally: five Node metadata failures and five renderer Spanish-display failures. No new RED was needed to resume that implemented behavior. The later corrected native-availability fixture now rejects the actual `voice_input_devices` command; both later actual-hook sentinel cases are included in current verification, not inferred from the earlier 119-test result.

Earlier retained-source synthetic checks reported: **70 Node tests** across output/diagnostics/device routing, **121 renderer tests** across four voice/composer files, and the required strict non-emitting CLI selection of `main.tsx`, `useVoice.ts`, selected tests and setup. Local verification artifacts are not distributed; separate stdout, stderr and exit files are preserved. Final repeat checks cover the readability-only test formatting; scoped diff checking is captured separately.

Within E, S1 is supported by adopting the pending unit and verifying the previously unrun tests; S2 by the five Spanish output displays; S3 by the bounded implementation and regression checks; S4 by synthetic-only validation with no Windows, environment or isolation operations. No behavior correction was required during this resume.

LSP tools are unavailable in this child. The parent's post-restart probe reported zero diagnostics with only three confirmed-clean and three inconclusive paths; that is not global clean proof. Strict current-source CLI typing is the bounded source evidence here. No Windows, real devices, native transport, daemon, browser/E2E, build, full-project typing or T9 integration acceptance is claimed. Prior out-of-scope `uploads.ts` auxiliary findings remain unchanged.
