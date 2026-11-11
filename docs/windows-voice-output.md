# Windows speech-to-WAV bridge

The panel-only native bridge converts local literal text into in-memory WAV bytes using classic desktop SAPI on a blocking worker. The panel plays validated bytes through a temporary Blob URL; the native worker never plays audio, writes temporary audio files, or uses WinRT. Existing WASAPI capture and local transcription are unchanged.

## Replies and playback controls

Only a completed assistant reply to a spoken turn is read aloud. Typed turns stay silent; editing a reviewed dictation does not remove its spoken-turn eligibility when sent. Markdown filtering, text limits and existing language/region selection are preserved.

- When daemon speech is available, its existing audio path remains preferred. A matching unavailable response falls back to local output once; stale or duplicate replies do not restart playback.
- Local Windows output uses the compiled SAPI bridge, independently of microphone/model availability. Unsupported platforms retain browser/system speech and regional voice selection, waiting up to 1500 ms for late browser voices.
- Stop, mute, cancellation, a new recording, user typing and unmount retire pending speech and playback. Late native, daemon, browser and media callbacks cannot revive retired output. Temporary native WAV URLs are released once on completion, failure or retirement.
- Native invocation failures do not silently select another backend. The existing Voice note shows actionable failures, including `Local speech failed. Check installed speech voices and audio output, then retry.` Busy and session-limit messages below remain distinct.

Local transcription requires the optional Parakeet model. See [voice-model download integrity](voice-model-download.md) for the exact size-mismatch error and verified release pins. Compiled synthesis support is not a claim that a microphone, installed SAPI voice or audible device is ready.

## Panel commands

| Command and arguments | Reply |
| --- | --- |
| `voice_synthesis_status({})` | `{supported: boolean}`: compiled Windows support, not a microphone or installed-voice probe. |
| `voice_synthesize({requestId, text, locale})` | WAV bytes (`number[]`); explicitly unsupported on non-Windows. |
| `voice_synthesize_cancel({requestId})` | No value; marks only that request ID, without releasing a running worker's slot. |

All three require the invoking Tauri window to be `panel`, in addition to the existing local, panel-only `voice` capability. Neither a caller-supplied window label nor an arbitrary webview grants access. Status does not promise a suitable installed voice or audible output. Non-Windows callers retain their existing browser behavior and must not invoke the Windows synthesis path.

Request IDs are unique for the app session: 1–128 ASCII letters/digits, `-`, or `_`. Text/locale and IDs are validated before admission mutates history or reserves the single active slot. A cancellation arriving before admission permanently retires that ID. Completed, cancelled and failed IDs are never reusable. History stops at 1024 distinct IDs rather than evicting tombstones or growing indefinitely.

Admission happens before the first await. Its lease moves into the blocking worker and is released on return, error or unwind, even if the IPC waiter was dropped. Cancel is cooperative, not worker termination; a late successful WAV is discarded after cancellation. Renderer/purge failures remain errors rather than being hidden as cancellation.

## Foundation contract and limits

`synthesize_wav(text, locale, Arc<AtomicBool>) -> Result<Vec<u8>, String>` blocks its caller while a fresh worker owns and releases every COM interface in its own apartment. The bridge invokes it through `spawn_blocking`, never on the UI thread.

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
| `Speech synthesis is busy` | Wait for the current worker to exit; cancellation alone does not free the slot. |
| `Speech request session limit reached; restart the app` | Restart the app to begin a new bounded session; do not reuse retired IDs. |
| Cancelled, timed out, or memory limit exceeded | Retire the result; shorten any deliberate retry. Do not treat it as empty success. |
| Unsupported/missing PCM, no audio, or truncated stream | Surface synthesis failure; do not play malformed bytes or silently switch backends. |
| `Windows speech <stage> failed (HRESULT ...)`, worker start/panic, or purge failure | Surface the bounded error. A purge error does not prove successful cancellation. |

Portable guard/WAV and fake-renderer lease/handshake tests need no speech engine. Deterministic UI tests use fake capture, IPC, browser and media ports; they do not establish real-device behavior. The default-ignored Windows integration fixture uses only “A short synthesis test.” in `en-US` and checks in-memory WAV/data; installed SAPI voices are not guaranteed in CI. Select only that exact fixture after memory-only source audit. Test presence is not execution evidence. A passing memory fixture demonstrates WAV generation, not audibility, IPC/UI readiness, or live hardware acceptance.
