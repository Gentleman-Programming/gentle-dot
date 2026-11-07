# Voice device selectors: source integration

`createVoiceDevices(dependencies)` is an injected, browser-global-free service. Construction and metadata enumeration never request microphone access or play audio. Only an explicit user action may call `requestPermission()`; temporary tracks are stopped afterward.

Preferences use the owned `gentle:voice-devices:v1` storage record with separate `nativeInput`, `browserInput`, and `browserOutput` slots. Native endpoint IDs are not browser media-device IDs. Null retains legacy default routing. Invalid/future records are not silently overwritten; reset removes only this record.

`currentSelection()` distinguishes default, missing, unsupported and metadata-available. Available is not proof of active routing, permission, capture or playback. A disconnected remembered selection remains missing and is not replaced with a default. Labels are transient, never persisted or logged. Subscribers observe same-instance writes; cross-window storage-event integration is not supplied here.

Run `node --test packages/ui/test/voice-devices.node-test.mjs` for hardware-free public-interface tests. The initial scaffold produced 26 failures; implementation passed 26 tests, and the existing output helper passed 14 tests. Exact receipts are retained locally. These checks do not prove renderer, Windows or hardware behavior.

Settings now mounts both selectors, with the active input route shown explicitly. The next recording snapshots that route's saved ID; a missing, unsupported or unreadable explicit choice fails without default fallback. Browser input uses an exact browser ID constraint; native input uses the native bridge. Local Windows WAV and cloud MP3 use the same selected HTMLAudio sink. Metadata refresh and the labelled permission action do not prove capture or playback. Explicit input/output checks and bounded diagnostics are now supplied at source level; they are not runtime acceptance. Nothing changes Windows global defaults or authorizes agent hardware access.

## Explicit verification controls (source only)

Settings → Voice devices → **Check voice** mounts without capture or playback. `createVoiceChecks()` holds one latest in-memory record and a separate temporary preview; `validateNativeDiagnostic()` rejects unknown native stages and invalid count/rate combinations and copies only schema fields. The runtime's `registerChecks()` connects these controls to the existing chat `useVoice` instance, not a second microphone/recognizer pipeline.

- **Check input** uses the actual active native or browser/daemon route and that route's saved selection. It displays real measured level, transient transcription and known final metadata. Browser compressed bytes are labelled separately; browser PCM count/rate stays unknown. The configured daemon ASR may receive the recording, but no chat/LLM turn is sent and no draft is created.
- **Stop check** finishes an admitted input recording using existing recognition. Before admission it cancels instead. **Cancel check**, leaving Settings and the one-minute deadline retire the owned check; pending permission/start cleanup must settle before another recording can start. Busy checks reject rather than cancel another recording. Completed preview clears on leaving Settings. Shared native subscriptions remain owned by the chat hook; check observers are detached without removing subscriptions needed by chat.
- Permission, missing/unsupported selection, unreadable preferences, native busy/history and saved mute failures remain visible. No refresh or mount action activates media. Playback completion asks for human hearing confirmation, never claims audible success.

Public Node tests exercise the production controller, native validator, runtime registration, selection and output helpers with injected adapters. They do not execute React, Rust, actual ASR, device capture or playback. Renderer regressions are authored **UNEXECUTED**; independent source review and owner Windows acceptance are still required.

## Diagnostic correlation and stop ordering (source only)

Each input check creates an ephemeral opaque token before capture admission. Native checks pass it as additive `voice_start({locale?, deviceId?, diagnosticToken?})`; omitted tokens preserve ordinary starts. Tokens are 1–128 ASCII alphanumeric/hyphen/underscore characters, not device IDs or authorization. Native validation precedes permissions/state changes; reused tokens and a bounded 1,024-token session limit fail closed. Default starts consume no token history.

The native session owns the token and snapshots it into `voice://diagnostic` **under the recording lock**, then dispatches unlocked. Only this additive topic carries `diagnosticToken`; existing partial/level/error payloads and `voice_stop → {text}` stay unchanged. The hook rejects missing/mismatched tokens before observer delivery; the production controller independently validates correlation before updating displayable metadata or classification. Tokens never enter displayable check state, storage or logs.

Stop text and terminal metadata may arrive in either order. Stop text alone means the capture stopped, **not model success**: final recognition metadata remains honestly unknown. One bounded callback may accept matching terminal metadata for the same still-current check after stop text. Cancel, leaving Settings or a new check invalidates it. Older/missing/mismatched events do nothing; failure evidence cannot be replaced by reordered progress/success. No delay, forced transport ordering, extra command or recognizer is introduced.

Hardware-free Node regressions exercise delayed-old dispatch, both result/metadata orders and failure stages through production observers. Rust unlocked-dispatch/token and real-hook renderer regressions are authored **UNEXECUTED**. The observed source race is not evidence for the owner's earlier stationary-meter cause, and event ordering remains unproved on native Windows transport. No Windows/audio success or independent approval is claimed.

## Native bridge (source only)

The panel may invoke `voice_input_devices` without activating capture. It returns `{ supported, devices: [{ id, label, isDefault }] }`; non-Windows returns unsupported/empty. `voice_start` accepts optional `deviceId` alongside `locale`. Omitted/null keeps the original default; Windows validates and snapshots an explicit endpoint for that recording. Other platforms reject explicit native selection before permissions or state changes, never silently open a different device.

`voice_synthesize({ requestId, text, locale })` returns a JSON byte array containing the existing Windows helper's validated WAV, not playback. `voice_synthesize_cancel({ requestId })` marks only that request; cancellation is not completion. The UI must generate a unique ASCII alphanumeric/hyphen/underscore ID (1–128 bytes), keep generation guards, and route returned audio through its selected HTMLAudio sink. Non-Windows synthesis returns an unsupported error. No text, IDs, or native error descriptions are logged by the bridge.

One worker may be active. Admission precedes blocking dispatch; a worker-owned lease releases only its own slot on success, error or unwind. Cancel-before-start is remembered, duplicate IDs are rejected, and late cancellation never clears/cancels a newer request. A bounded session history retains up to 1,024 IDs (including cancel-before-start IDs); new IDs then fail closed with a restart-app error rather than forgetting tombstones or allowing reuse. Existing IDs remain cancellable. This is cooperative cancellation, not hung-engine preemption.

All three additive commands are granted only by the existing panel-only voice capability; Dot permissions are unchanged. Rust regressions are authored but unexecuted. Source structure does not prove native compilation, runtime ACL enforcement, device routing, capture, transcription or audible playback. UI selectors and their capture/playback consumers are supplied at source level; independent integrated verification and owner Windows acceptance remain separate work.
