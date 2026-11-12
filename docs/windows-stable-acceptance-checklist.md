# Windows stable acceptance: W2/W3 evidence checklist

**PREPARATION ONLY. No native acceptance was performed here.** This is a future execution and evidence matrix for PabloGNU's Windows x64 [W2 and W3 cards](stable-integration-handoff.md#task-cards), not permission to run them or a stable-readiness claim.

## Current gate and quick path

I1 remains Maicol's undelivered dependency; W1 is blocked on its accepted handoff. R3-001 is **CLOSED**: no more tests are requested, and PabloGNU must not take over I1. Maicol's reported `375b3f5` code checkpoint and `e7ff3b7` documentation checkpoint do not establish I1 readiness or a current acceptance candidate.

1. Maicol supplies the I1 PR, exact integrated candidate SHA, approved test scope, executable identity/ownership and listener-boundary evidence with review disposition.
2. PabloGNU completes the separately scoped W1 native runtime, ownership, graceful Quit and relaunch acceptance against that candidate.
3. Only after accepted I1 and W1, agree separate W2 hardware/model/provider scope and W3 disposable lifecycle scope. Fill the pending evidence fields before execution.
4. Run only the approved cases, retain all outcomes, and return evidence to the named owners. Missing consent or dependencies means **BLOCKED**, not a pass or an invitation to broaden scope.

## Dependency and consent preflight

- [ ] Accepted I1/W1 evidence identifies the same candidate, target, runtime executables and dependency PRs; no historical SHA is substituted for a future candidate.
- [ ] Parent approves exact cases, commands and environment. Use the [existing command guide](stable-integration-handoff.md#existing-commands-choose-checks-after-scope-approval), [Windows testing](windows-testing.md#15-voice--native-validation-pending) and [packaging guide](windows-packaging-validation.md); their examples are not blanket authorization.
- [ ] Record Windows x64 OS/build and tool versions. ARM64 is outside first-stable acceptance; source startup is not installed startup.
- [ ] Explicitly approve microphone and playback devices, local model availability or download, installed voice use, and any provider account access separately. Availability alone is not consent.
- [ ] Explicitly approve installation, versioned update, same-installer reinstall and uninstall separately, including disposable destination/profile, prior-installation conflicts, registration/shortcut effects and owned cleanup disposition.
- [ ] Keep current personal installations and profiles out of scope. Use only authorized synthetic app-data and unrelated-profile canaries; establish ownership and baseline bytes before lifecycle actions.
- [ ] Agree bounded, redacted evidence collection: no credentials, tokens, personal logs, private absolute paths or ignored build receipts in public reports. Retain failures without automatic cleanup or retries.
- [ ] Coordinate shared contracts with Maicol and voice/UI boundaries with Mars. Platform ownership is not folder exclusivity; findings needing changes return for exact-file approval.

## W2 — native voice cases

All cases below are **BLOCKED** on accepted I1/W1 and explicit W2 consent; none has run here. References show source/test presence, not execution. Use short synthetic speech and messages only.

### W2-01 — real capture and release

- **Steps:** On the approved microphone, start supported native capture, speak the synthetic phrase, stop, then check that the device is released.
- **Observe:** Capture receives audio until stopped; capture work ends and releases the device.
- **Trace/limit:** [WASAPI adapter][wasapi]; [device fixture][device] `the_default_microphone_streams_16_khz_until_stopped_and_releases_the_device` is ignored by default and uses a fake recognizer. It cannot prove transcription.
- **Status:** BLOCKED; device observations pending.

### W2-02 — default capture endpoint

- **Steps:** Record the approved Windows default capture endpoint, then capture with the existing supported path and compare the observed input.
- **Observe:** Input uses the Windows default capture endpoint; record a mismatch or unavailable endpoint explicitly.
- **Trace/limit:** [Device source][device] uses `GetDefaultAudioEndpoint(eCapture, eConsole)`. No automated endpoint-selection case was found; this is source/manual evidence, not an in-app selector claim.
- **Status:** BLOCKED; endpoint evidence pending.

### W2-03 — microphone to reviewable transcript

- **Steps:** With the approved local Parakeet model available, capture a synthetic phrase through the real microphone and stop into review.
- **Observe:** A reviewable transcript appears before manual send by default; compare it with the spoken phrase and record the actual result.
- **Trace/limit:** [Voice checklist][voice-check]; [Parakeet fixture][parakeet] `real_parakeet_decodes_a_wav` is ignored by default and decodes a supplied WAV only. No end-to-end microphone transcription test was found.
- **Status:** BLOCKED; real capture-to-transcript evidence pending.

### W2-04 — audible completed spoken reply

- **Steps:** Send an approved reviewed spoken turn, let its assistant reply complete, and listen on the approved output device.
- **Observe:** The completed spoken-turn reply is audible through the supported path; record actual voice/backend and playback observations.
- **Trace/limit:** [Playback contract][voice-output]; [SAPI fixture][sapi] `renders_short_text_to_memory_wav` is ignored by default and memory-only. WAV generation is not audibility or IPC/UI readiness.
- **Status:** BLOCKED; audible playback evidence pending.

### W2-05 — explicit availability and synthesis errors

- **Steps:** Exercise only approved device, missing-model, installed-voice and synthesis-error conditions; record each condition separately without changing personal configuration.
- **Observe:** The relevant actionable error is visible, recording returns to idle where applicable, and failure is not presented as success or a silent backend substitution.
- **Trace/limit:** [WASAPI][wasapi] `open_failures_say_what_the_user_can_do`; [voice app][voice-app] `windows_records_with_the_local_model_and_asks_for_it_first`; [UI tests][voice-ui] `shows the native error and goes back to idle`; [output errors][voice-output]. Installed-voice failures still need manual native evidence.
- **Status:** BLOCKED; per-condition observations pending.

### W2-06 — stop, cancel, mute and late results

- **Steps:** In separate approved turns, stop playback, cancel capture, mute, and start talking during output. Observe pending work through completion; compare with existing late-result regression cases.
- **Observe:** Stop/cancel retires the relevant work; mute remains effective; retired callbacks do not restart output. Record capture release separately from playback retirement.
- **Trace/limit:** [UI tests][voice-ui] `stays silent while muted, and remembers the choice` and `cuts the speech when the user presses Stop or starts to talk`; [bridge][speech-bridge] `cancellation_marks_only_its_id_and_discards_a_late_success`; ignored [device fixture][device] `cancel_ends_the_capture_thread`. Mock/cooperative cancellation is not guaranteed OS-worker interruption.
- **Status:** BLOCKED; native control observations pending.

### W2-07 — typed-only replies stay silent

- **Steps:** Send a synthetic typed-only message and let its reply complete with playback otherwise available.
- **Observe:** No reply speech starts.
- **Trace/limit:** [UI test][voice-ui] `does not read replies to typed messages` uses mocks; native silence remains an observation to collect.
- **Status:** BLOCKED; typed-turn evidence pending.

### W2-08 — review, edit and manual send

- **Steps:** With pause-to-send disabled, dictate into an existing synthetic draft, stop, review and edit it, then send manually with Enter.
- **Observe:** Dictation appends to the draft without sending automatically; the edited reviewed dictation retains spoken-turn eligibility when sent.
- **Trace/limit:** [UI tests][voice-ui] `leaves the transcript in the input, added to what was typed, and sends it on Enter` and `keeps an edited reviewed dictation spoken without treating draft insertion as typing` are mocked behavior evidence only.
- **Status:** BLOCKED; native review/send evidence pending.

### W2-09 — opt-in pause-to-send

- **Steps:** Enable the existing opt-in, speak, then pause; observe send count/timing. Separately disable it and repeat into manual review; cancel another opted-in turn before completion.
- **Observe:** About two seconds of observed silence after speech triggers one send; disabled mode retains manual review, and cancellation retires quiet state without a later send.
- **Trace/limit:** [Voice checklist][voice-check]; [UI tests][voice-ui] parameterized `${kind}: sends once`, disabled/manual-review and cancellation cases; [silence test][silence] `does not count a missing sample gap as silence`. This audio-level heuristic is not guaranteed speech detection; noise and quiet speech can affect it.
- **Status:** BLOCKED; timing/counts and alternate-case observations pending.

## W3 — disposable installed lifecycle matrix

Use only the approved current-user **NSIS** artifact from the existing producer. Historical MSI/pair wording is not current producer evidence: MSI is **UNVERIFIED** and needs its own approved artifact, scope and evidence before any parity claim. Historical destination budgets are observations, not fixed requirements.

Each row is **BLOCKED** on accepted I1/W1 plus its explicit lifecycle scope. Use the [packaging guide](windows-packaging-validation.md) for the existing harness and guards; no lifecycle commands are authorized by this matrix.

| Case | Later approved steps | Observable expected result | Trace and evidence limit | Status |
| --- | --- | --- | --- | --- |
| W3-01 Clean install | Identify installer/manifest/target; install into the approved disposable destination and compare installed runtime identity. | Correct owned artifact installs; installed files match the supplied runtime manifest. | [Smoke harness][smoke], identity and manifest checks; harness source is not an installed test result. | BLOCKED |
| W3-02 Installed ready | Launch the installed app under the approved restricted-runtime scope; record executable/Node identity and daemon/engine state. | Installed desktop reaches ready with the verified runtime and restricted PATH. | [Smoke harness][smoke] idle health checks are not separate restricted desktop/engine-readiness proof; W1 evidence must match this artifact. | BLOCKED |
| W3-03 Graceful Quit and relaunch | Quit normally, observe owned processes, then relaunch within the approved scope. | Owned app/daemon/descendants exit without touching unrelated processes; relaunch reaches ready. | [W1/W3 cards](stable-integration-handoff.md#task-cards); smoke forced cleanup is not graceful Quit proof. | BLOCKED |
| W3-04 Destination guards | Select approved invalid/valid synthetic destinations; compare sentinel/counter bytes before and after rejection/acceptance. | Invalid destinations reject before side effects; supported extraction is preserved. | [Path fixtures][path-tests] test native NSIS boundaries and maintenance ordering using synthetic fixtures, not product installation. | BLOCKED |
| W3-05 Integrity and target | In owned fixture copies, exercise approved drift and target-mismatch cases; compare all owned state. | Corruption, omission, unexpected additions and unsupported/mismatched identities reject without unintended mutation. | [Integrity tests][integrity], [target tests][target-tests], [target contract][target-guide]; unsigned manifest integrity is not publisher authentication. | BLOCKED |
| W3-06 Versioned update | Record approved old/new artifact identities and canary bytes; perform only the separately approved update scenario. | New installed identity is verified; documented owned-data and unrelated-canary preservation holds. | Manual/unverified; the smoke harness does not prove a versioned update or running upgrade. | BLOCKED |
| W3-07 Same-installer reinstall | Stop the app as approved, repeat the same identified installer, and compare runtime and canary bytes. | Same-artifact reinstall succeeds and preserved canary contents match baseline. | [Smoke harness][smoke] repeats the same installer after cleanup; this is not W3-06. | BLOCKED |
| W3-08 Uninstall and preservation | Uninstall only the disposable owned app; inspect app removal and authorized retained-data/unrelated canaries. | App executable is absent; retained canary bytes and unrelated synthetic state remain unchanged as documented. | [Smoke harness][smoke] checks executable absence and canary existence; reinstall checks content. No automated unrelated-profile preservation case was found. | BLOCKED |

Forced harness cleanup, if separately approved, must be recorded as **forced cleanup**, with ownership/preservation observations. It cannot satisfy voice Stop, graceful Quit, relaunch, or versioned-update acceptance. No installed-lifecycle test result is supplied here.

## Evidence record — fill only after the corresponding approval

Copy one record per case/attempt. Leave unavailable identities pending; never populate these fields with historical checkpoints. A blocked or not-run row is not a successful result.

```text
Case ID / attempt / date: pending
Named owner / reviewers / shared-contract handoff: pending
Accepted I1 PR + SHA / W1 evidence + disposition: pending
Base / exact integrated candidate SHA / dependency PRs + SHAs: pending
Artifact filename + SHA-256 / manifest SHA-256 / target: pending
Installed runtime / Node / launcher executable identities + digests: pending
Windows version + build / architecture / tool versions: pending
Approved disposable state / synthetic canary scope (public-safe labels): pending
Device / model / installed voice availability + approval scope: pending
Download / provider / lifecycle approvals and limits: pending
Exact approved command or manual steps / exit codes / test counts: pending
Reviewed, redacted observations / stdout / stderr reference: pending
Every failed / skipped / cancelled / unavailable check: pending
Canary baseline bytes or hashes / after-state / unrelated-state preservation: pending
Graceful Quit / relaunch / forced-cleanup evidence, kept separate: pending
Result: BLOCKED (dependencies and scope pending; no execution)
Remaining limits / next owner / review disposition / retained-evidence disposition: pending
```

Use the [common consent/evidence rules](stable-integration-handoff.md#consent-and-evidence) and [delivery template](stable-integration-handoff.md#common-pr-delivery-template). Publish only bounded, reviewed summaries; keep sensitive evidence out of the guide.

## Traceability and next owner

The W2 rows map the native voice card plus the existing review/pause contract; the W3 rows map the installed lifecycle card. Source links and named tests are a navigation map only: **none was executed for this documentation unit**. Disabled preview helpers, mocked UI/IPC, memory WAVs and source-only startup cannot qualify native voice or installed behavior.

**Next external owner: Maicol**, to deliver accepted I1 with PR, exact candidate SHA and test scope. Then **PabloGNU** owns W1 acceptance and separately authorized W2/W3 execution, coordinating voice/UI evidence with **Mars** and shared contracts with Maicol. Hand W2 observations to Mars for UI2 and the candidate-bound dossier to Maicol for I3; documentation completion alone accepts neither card.

[wasapi]: ../apps/desktop/src-tauri/src/voice/wasapi.rs
[device]: ../apps/desktop/src-tauri/src/voice/wasapi/device.rs
[parakeet]: ../apps/desktop/src-tauri/src/voice/parakeet.rs
[sapi]: ../apps/desktop/src-tauri/src/voice/windows_speech.rs
[voice-app]: ../apps/desktop/src-tauri/src/voice/app.rs
[speech-bridge]: ../apps/desktop/src-tauri/src/voice/speech_bridge.rs
[voice-ui]: ../packages/ui/test/voice.test.tsx
[silence]: ../packages/ui/test/voice-silence.test.ts
[voice-check]: windows-testing.md#15-voice--native-validation-pending
[voice-output]: windows-voice-output.md
[smoke]: ../scripts/windows/smoke-install.ps1
[path-tests]: ../scripts/windows/test/installer-path-guard.test.mjs
[integrity]: ../scripts/windows/test/integrity.test.mjs
[target-tests]: ../scripts/windows/test/target-integrity.test.mjs
[target-guide]: platform-packaging.md#integrity-and-capability-boundary
