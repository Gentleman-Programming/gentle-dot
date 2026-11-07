# Windows microphone capture

`voice::wasapi::WasapiMicrophone` implements the existing microphone interface using the default WASAPI capture endpoint (console role). Parent integration connects it to the existing local Parakeet recognition path; it adds no model or recognizer. This source work is not Windows runtime acceptance: the owner builds, installs and tests the app.

## Privacy boundary

- Status and permission queries must not open a device or start recording.
- Only the existing user-initiated recording action may open the capture stream. Windows remains responsible for enforcing microphone privacy settings.
- An access-denied, missing-device or disconnected-device result must be reported, not replaced with successful capture or a permission bypass.
- No model download, cloud service, driver change or hardware activation is part of source verification.

## Capture contract

The existing capture thread owns COM initialization, interface creation, packets, shutdown and interface release. Only its stop channel and join handle cross threads. The adapter must release each successfully acquired packet on the acquiring thread, including conversion errors; silent packets must never read the driver data pointer.

Device PCM is converted through the preserved `PacketSink`/`CapturePcm` path into 16 kHz mono samples. Conversion accepts 8–384 kHz, 1–32 channels, and at most 65,536 frames / 1 MiB per packet. These defensive limits bound allocations even for silence or malformed driver metadata. Unsupported formats must fail before capture starts.

## Integration and binding evidence

`voice/mod.rs` registers `wasapi` only on Windows; `app::platform_input` constructs `Voice(WasapiMicrophone, Preferred(Parakeet, None), SystemClock)`. Construct the stateless unit `WasapiMicrophone`; `open(Sink)` returns the existing boxed `Stream`. Permission queries do not probe a device: `NotDetermined` remains the non-probing status, and the existing start flow defers the actual privacy/device decision to WASAPI. Errors retain the operation, HRESULT and Windows message, including access denial and device loss.

The Windows-only direct dependency is on `windows = "=0.62.2"` with `Win32_Foundation`, `Win32_Media_Audio`, `Win32_Media_KernelStreaming`, `Win32_Media_Multimedia`, `Win32_System_Com`, `Win32_System_Com_StructuredStorage`, and `Win32_System_Variant`. The structured-storage feature implies COM; both structured storage and Variant gate `IMMDevice::Activate`.

Declarations were checked against the crate's recorded source commit [`32c3144490c016fe496a0aed769bce60987a2e9d`](https://github.com/microsoft/windows-rs/tree/32c3144490c016fe496a0aed769bce60987a2e9d/crates/libs/windows/src/Windows/Win32), not the unavailable compiled docs pages. This verifies signatures, not compilation. Capture drains at most eight queued packets per poll; the preserved capture thread checks cancellation between polls. Stop and partial-start cleanup run on that same thread, before COM teardown.

## Selectable input groundwork

`input_devices()` lists active capture endpoints and their current default marker on a metadata-only COM worker. It never activates an audio client or requests permission. Native endpoint IDs are opaque and distinct from browser media-device IDs; labels are transient UI metadata.

`WasapiMicrophone::open_selected(sink, selection)` snapshots an owned selection for the existing capture thread. `None` retains the console-role default. An invalid, disconnected or non-capture selection errors without default fallback. Selection does not change Windows defaults. Metadata failures expose bounded stages/HRESULTs, not endpoint IDs or native descriptions.

Typed friendly-name properties additionally require `Win32_Devices_FunctionDiscovery` and `Win32_UI_Shell_PropertiesSystem` on the existing pinned dependency. Settings/start-command wiring follows separately; this groundwork alone does not route a user selection from the UI. Six new Rust tests are authored but unexecuted.

## Final-input diagnostics (source only)

The additive `voice://diagnostic` event carries only `{route:"native", stage, pcmSamples, sampleRate}`. Stages are finite serde values: `final-buffer`, `loading`, `decoding`, `complete`, `load-failed`, `decode-failed`, `worker-failed`, `failed`. Unknown PCM count/rate is null. Parakeet reports the exact length of its final capped 16 kHz mono float buffer before the final load/decode path; zero is a real empty buffer, not an inference from the meter, timer or transcript.

Failures publish metadata before the pre-existing Stopping policy resolves with partial/empty text. That policy and the stop `{text}` reply are unchanged. Native `Sink` uses its existing recording gate and dispatches outside the state lock; retired sessions cannot publish. Metadata is not a per-packet stream and contains no audio, text, device identity, native error or path. Legacy test assertions filter only the separate diagnostic topic, whose schema/count/stage assertions are authored separately. Rust tests remain **UNEXECUTED**.

## Owner acceptance still required

- [ ] Compile the Windows target with the exact-version typed binding features.
- [ ] Record and transcribe with the already-installed Parakeet model.
- [ ] Verify denied privacy access and a missing/disconnected default input fail visibly.
- [ ] Verify repeated Stop/cancel closes capture without hanging or continuing microphone use.
- [ ] Confirm existing Linux/macOS capture behavior remains unchanged.

The Windows app regression checks model-present/model-absent status through `VoiceInput::status` using synthetic locators and a panic-on-load loader; it does not call start or access files/devices. Native regression tests added here are unexecuted: the Rust runner is unavailable in this environment. Source inspection and editor diagnostics are not compilation, microphone or transcription proof.
