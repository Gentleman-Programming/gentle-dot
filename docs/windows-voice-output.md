# Windows speech-to-WAV foundation

The native foundation converts local literal text into in-memory WAV bytes using classic desktop SAPI. It does not play audio, write temporary audio files, or use WinRT. IPC commands, exclusive synthesis leases, UI playback and cancellation integration are later units; existing voice input is unchanged.

## Contract and limits

`synthesize_wav(text, locale, Arc<AtomicBool>) -> Result<Vec<u8>, String>` blocks its caller while a fresh worker owns and releases every COM interface in its own apartment. A later adapter must keep this off the UI thread.

- Text must be nonblank, NUL-free and at most 4000 UTF-16 units. Locale must be nonempty, NUL-free and at most 85 bytes; Windows then validates its language identifier.
- SAPI language matching prefers exact, then primary-language matches; no match retains the fresh voice's default voice. Catalog errors are reported, not hidden. This never falls back to speaker output.
- Both memory-stream format assignment and output redirection must succeed before `Speak`. Literal-text flags prevent XML/SSML and filename/audio URL interpretation.
- Supported output is ordinary integer PCM: 1–2 channels, 8–96 kHz, 8/16 bits, with consistent alignment and byte rate. Empty, truncated, oversized, nested-container and unsupported data are rejected. RIFF lengths include padding; data length excludes padding.
- Returned PCM is limited to 16 MiB, plus a 44-byte WAV header and possible padding. Cancellation and the 60-second deadline are cooperative. The stream is monitored around 25 ms waits; this is **not** a hard bound on the OS stream allocator between polls or an interruption guarantee for blocked COM calls.
- `GetStatus` must confirm the queued utterance is done; a successful `WaitUntilDone` alone is not proof. Purging active synthesis is attempted on cancellation/error before worker teardown; failures are reported.

## Errors and readiness

| Result | Caller action |
| --- | --- |
| Empty/NUL/overlong text or invalid locale | Correct the request before retrying; do not synthesize boundary-length fixtures. |
| Cancelled, timed out, or memory limit exceeded | Retire the result; shorten any deliberate retry. Do not treat it as empty success. |
| Unsupported/missing PCM, no audio, or truncated stream | Surface synthesis failure; do not play malformed bytes or silently switch backends. |
| `Windows speech <stage> failed (HRESULT ...)`, worker start/panic, or purge failure | Surface the bounded error. A purge error does not prove successful cancellation. |

Portable guard/WAV tests need no speech engine. The default-ignored Windows integration fixture uses only “A short synthesis test.” in `en-US` and checks in-memory WAV/data; installed SAPI voices are not guaranteed in CI. Select only that exact fixture after memory-only source audit. Test presence is not execution evidence. A passing memory fixture demonstrates WAV generation, not audibility, IPC/UI readiness, or live hardware acceptance.
