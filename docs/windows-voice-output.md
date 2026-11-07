# Local spoken replies: source readiness, not Windows runtime proof

Replies to completed spoken turns use the existing eligibility and mute policy; typed turns stay silent. Generic callers retain browser/system speech. Desktop integration can use Windows memory-WAV synthesis and the app's selected HTMLAudio output. Output selection is independent of Parakeet and microphone selection. No cloud credentials, models or Windows defaults are changed.

## Output lifecycle

- `createVoiceOutput(options)` exports `sayLocal(text)`, `sayAudio(text, src)` and `stop()`. Callers supply cleaned/bounded text, synthesis, utterance/audio factories, locale, speaking/error callbacks and optionally an inert clock (`after(ms, fn)` returns cancellation).
- Local output uses existing voices immediately, otherwise waits up to **1500 ms**, listening for `voiceschanged` and checking again at the deadline. Empty discovery reports an error, not fake readiness. Waiting counts as speaking so Stop remains available.
- Reply language selects a voice, preserving the existing preference for the user's region, then the first matching voice. With a nonempty list but no language match, the utterance retains the system's default selection and requested language.
- Missing APIs, empty discovery and utterance errors use the existing voice note channel and release speaking state. Successful API calls alone do not prove audible output.
- Without an explicit output choice, cloud audio rejection, playback error or construction failure falls back locally once. If local output is unavailable, its error is shown. This preserves the existing optional daemon route without requiring credentials.
- Stop, mute, recording start, cancellation, the controller's typed callback and unmount retire callbacks, pending cloud replies and discovery work. Production typing-to-cancellation wiring is inherited and not established by these helper checks. Mute updates its immediate guard without changing storage keys or persistence rules.

## Windows selected-output groundwork

The Windows-only `windows_speech::synthesize_wav(text, locale, cancelled)` helper supplies classic desktop SAPI synthesis into a memory stream. It neither plays audio nor writes files. It selects a compatible installed locale voice (exact language/region, then primary language); with no match, the new SAPI voice retains the system default. No voice/model downloads or Windows default changes occur.

The worker owns COM and task allocations, validates ordinary integer PCM, and returns a RIFF/WAV buffer. It limits text to 4000 UTF-16 units, PCM to 16 MiB, and cooperative work to 60 seconds. Async completion uses `GetStatus`, not a successful `WaitUntilDone` call alone. Cancellation purges the outstanding utterance. Limits are checked between COM calls; they cannot terminate a hung native engine.

The existing pinned Windows binding additionally enables `Win32_Media_Speech` and `Win32_Globalization`. Six pure Rust tests are authored but unexecuted. Native command/ACL source wiring and UI sink integration are now supplied, but remain uncompiled and do not prove audible output.

## Selected playback integration (source only)

`createVoiceOutput` accepts optional `routing` and `native` adapters. Without them its generic behavior is unchanged. Both existing cloud MP3 and local WAV use the same player lifecycle: an explicit sink must be supported and `setSinkId` must resolve before `play`. Explicit selection never falls back to browser speech or default playback. Default non-Windows output retains browser speech and cloud-error fallback.

The lazy desktop adapter uses the actual native metadata `supported` result to select Windows synthesis; it does not fabricate a platform flag. Unique session/counter request IDs are never reused. Stop, mute and replacement cancel the matching pending request, but cancellation does not imply native worker completion; a replacement may honestly report busy. The native 1,024-request session-limit error remains actionable. Stale synthesis/sink/play callbacks are retired and generated object URLs are released exactly once. Native synthesis is memory-only; object URLs are transient, not saved audio.

Node mocks exercise actual public helper methods, not renderer or native audio. The original differential failed before comparisons because its data-URL loader treated TypeScript as JavaScript; that receipt is preserved. A bounded loader correction used Node's built-in type stripping, verified the baseline against the source commit, then compared seven old/current generic output scenarios identically (exit 0). Its experimental-feature warning remains recorded on stderr. This does not prove renderer or Windows audio behavior.

## Explicit Settings output check (source only)

**Play output test phrase** says “Hello, this is the Gentle Dot voice output check.” through the same hook-owned `createVoiceOutput` instance, selected sink and `nativeOutputAdapter` as spoken replies. It does not send an assistant turn or request cloud speech. An unreadable saved-mute record or saved/current mute refuses the check; it never unmutes automatically. Existing native single-flight/history errors, selected-sink rejection and no-explicit-output fallback rules are preserved.

Stop, Cancel, leaving Settings, mute and the one-minute check deadline retire the owned playback/synthesis callbacks through the existing player lifecycle. An ended callback reports **playback completion only** and asks the owner to confirm hearing the phrase on the intended device. Construction, successful `play()`, device listing and source checks are not audible or selected-device acceptance.

## Validation boundary

Run `node --test packages/ui/test/voice-output.node-test.mjs` for injected, hardware-free behavior checks. Renderer regressions in `voice.test.tsx` are authored but unexecuted here because the renderer runner/dependencies are unavailable. No native/SDK/backend, Windows build, installed voice, audio device or audible playback was exercised. The owner must compile/package/install and confirm spoken-turn output, typed silence, mute, Stop and cancellation on Windows and supported Linux/macOS environments.
