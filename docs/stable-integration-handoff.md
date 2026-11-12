# First stable integration: owner handoff

**PabloGNU: Windows; Cinlo: Linux; Mars: UI; Maicol: shared isolation, integration and candidate qualification.**
Start with I1 and parallel UI1, then deliver the dependent cards below for **Windows x64 and Linux x64**.
ARM64 and macOS are later milestones. Every technical task here is **planned**, not accepted or green because this document exists.

## Quick path: one agreed baseline

1. Read your card and the [ODD task record](../odd/tasks/stable-integration.md). Each ID has an explicit person in both places; the parent owns tracker transitions.
2. Use consolidated product checkpoint `375b3f5fb9196f904b2915f2e3b5d4c0a500497a` on `docs/stable-integration-team` (preview slice `80baa1d54376c7d77b9fac675b99af44eab46a0c`); the original PR merge baseline was `0b2f98fca6f48e751c9daf29fca8909b1840b2da`. Read the latest handoff/evidence before choosing an implementation SHA.
3. For implementation, agree the exact base SHA and file list with Maicol; use `feat/stable-<ID>-<slug>` for the first contributor branch and identify dependent PRs.
4. Reproduce one bounded behavior, deliver code + tests + relevant docs together, then hand off the evidence template below. Creating this plan grants no execution consent.
5. Maicol integrates approved slices and names a new public candidate SHA. Contributors align with that candidate, not a blind rebase onto trunk.

This branch now consolidates the full PR232/PR233 history, the ten selected preview/test source files from the original integration worktree, and the seven selected primary CI/helper/test/doc files. Source manifests record byte-identical transfers; the source worktrees remain untouched. Generated binaries, caches, unrelated WIP and private data are not committed.
Fresh upstream `main` at `f97d56d884b1d3c178f415b95d486464e7b220bf` was already included (zero main-only commits), so no merge from main was needed.
This is a common **testing checkpoint**, not preview-ready or stable acceptance. I1 memory-startup isolation and the historical T6 native-containment proof remain open.
The authoritative scope and owner association are [S1–S7](../odd/tasks/stable-integration.md#specs). A dedicated exact-branch Windows x64/Linux x64 workflow runs tests/builds and disposable installation checks only, never deployment or release.

## Deliverables and confirmed issue mapping

Named owners are people, not inferred GitHub handles or assignees. All ten issues were created and read back in `Gentleman-Programming/gentle-dot` with these owners in their titles/bodies, and no GitHub account assignees or labels.
Publication completes the coordination handoff, not the technical work: every card remains planned.

| ID | Named owner | Deliverable | Dependencies | GitHub issue |
| --- | --- | --- | --- | --- |
| I1 | Maicol | Preview isolation and launcher identity | None | [#237](https://github.com/Gentleman-Programming/gentle-dot/issues/237) |
| W1 | PabloGNU | Windows native runtime and owned shutdown | I1 | [#238](https://github.com/Gentleman-Programming/gentle-dot/issues/238) |
| W2 | PabloGNU | Windows native voice acceptance | W1 | [#239](https://github.com/Gentleman-Programming/gentle-dot/issues/239) |
| W3 | PabloGNU | Disposable Windows installation lifecycle | W1 | [#240](https://github.com/Gentleman-Programming/gentle-dot/issues/240) |
| L1 | Cinlo | Linux x64 desktop/daemon/native acceptance | I1 for shared isolation | [#241](https://github.com/Gentleman-Programming/gentle-dot/issues/241) |
| L2 | Cinlo | Linux x64 producer and installation lifecycle | L1 | [#242](https://github.com/Gentleman-Programming/gentle-dot/issues/242) |
| UI1 | Mars | Existing UI flow regressions | None; parallel with I1 | [#243](https://github.com/Gentleman-Programming/gentle-dot/issues/243) |
| UI2 | Mars | Voice-control interaction acceptance | UI1, W2, L1 acceptance | [#244](https://github.com/Gentleman-Programming/gentle-dot/issues/244) |
| I2 | Maicol | Shared integration and reviewable slices | Approved contributor slices as available | [#245](https://github.com/Gentleman-Programming/gentle-dot/issues/245) |
| I3 | Maicol | One stable candidate qualification dossier | I1, W1–W3, L1–L2, UI1–UI2, I2 | [#246](https://github.com/Gentleman-Programming/gentle-dot/issues/246) |

## Working practices and boundaries

### Scoped ownership, not folder exclusivity

The areas in each card are **proposed repository-relative implementation boundaries**, not authority to edit everything beneath a folder.
Before implementation, the parent must approve an exact file list and checks. Findings outside it return to Maicol; do not expand a task silently.
Platform owners change only their OS-specific adapters inside shared trees. Windows and Linux helper/common files must not receive parallel writes.

**Shared reservation R — coordinate with Maicol and record a named handoff before any change:**
`apps/desktop/src-tauri/src/shell.rs`, `apps/desktop/src-tauri/src/config.rs`, shared Rust shell/channel/daemon modules and Tauri configuration;
`packages/daemon/src/isolation.ts`, `packages/daemon/src/config.ts`, `packages/protocol/`, shared daemon/helper contracts;
all `package.json` files, `pnpm-lock.yaml`, `apps/desktop/src-tauri/Cargo.lock`, Cargo manifests/dependency changes, security settings, and `.github/workflows/`.
An owner label never bypasses R. Shared UI/native/protocol changes need both affected platform owners and Maicol; platform acceptance remains with the named platform owner.

### Small, verifiable behavior PRs

- Keep one behavior with its tests and docs in each PR; target roughly 400 authored lines as an advisory, not a reason to minify or omit safety context. Respect any applicable repository cap.
- For runnable deterministic behavior: observe RED first, then GREEN; assert exact observable results and unchanged owned state for rejection cases.
- Add one preservation test per touched existing behavior. If shared code affects an unrequested command/contract, compare base and candidate output, error and exit behavior and pin any regression.
- Reuse existing state-creation and validation functions, preserving ordering, uniqueness, normalization and ownership checks; avoid inline replacements with weaker invariants.
- Report every failed, skipped, unavailable or cancelled check honestly. No skip conversion, forced bypass, relaxed privacy checks or “docs passed, therefore product passed.”
- I1's shared security unit needs independent review. Existing review/implementation limits remain in force; only the parent owns candidate review disposition and Git/publication actions.

### Consent and evidence

Use disposable, explicitly authorized state and owned synthetic fixtures. Never test against a current personal installation or unrelated profiles.
Provider accounts, microphone, playback hardware, computer-control providers, downloads and installations require their own approval; do not infer consent from a task card.
Report SHA, target, machine/OS/tool versions, exact commands, exit codes, test counts, and reviewed/redacted stdout/stderr or bounded observations.
Do not collect `.env`, credentials, tokens, personal profile logs or machine-absolute private paths. Older platform guides are references, not permission to follow their personal-data/log collection steps.
A native helper disabled for a preview, a mocked voice path or a container smoke cannot stand in for native feature acceptance.
If a required device/provider check lacks consent, mark it unverified and hand it back; do not invent a successful result or demand unsolicited hardware access.

### Existing commands: choose checks after scope approval

These are existing root scripts, **not commands executed or blanket-authorized by this docs handoff**. Use the exact agreed scope and environment before running them.
Node must satisfy the root `package.json` (`>=24`); pnpm is pinned to `11.5.0`. Platform producers have their own pinned runtime/toolchain prerequisites.

| Existing command | Intended evidence and prerequisites |
| --- | --- |
| `pnpm typecheck` | TypeScript build checks; not native execution |
| `pnpm lint` | Repository Biome check; does not qualify runtime behavior |
| `pnpm test` | Vitest projects; Windows global setup may prepare the native private-storage helper; obtain environment/native-preparation approval first |
| `pnpm e2e` | Existing Playwright suite; confirm its startup/state requirements first; not a substitute for desktop/device acceptance |
| `pnpm test:windows-contracts` | Node Windows contract tests; not native Rust Job/device proof |
| `pnpm test:package-ci` | Explicit packaging/CI structural suite; first approve a system-temp `GENTLE_DOT_CI_TEST_ROOT`; fixtures remain for parent-controlled cleanup |
| `pnpm package:windows` | Native Windows PowerShell producer; requires approved build/download/output environment, MSVC/Rust, Node/Go and platform prerequisites |
| `pnpm package:linux --arch amd64` | Existing Docker-backed Linux x64 producer, not desktop acceptance |
| `pnpm package:linux:check --arch amd64` | Existing disposable distro-container package checks, not a real desktop/device session |

Do not disable global setup or gates to make `pnpm test` appear dependency-free. Select focused checks with the parent before broad suites.
The original committed baseline had a legacy test-only `E0308` blocker. Its existing test-only repair is now transferred byte-for-byte with provenance, not newly corrected. Prior named Rust results remain prior evidence; no fresh full Cargo pass is asserted here.
Remaining native or installed checks must report their own candidate SHA and outcomes. Consolidation does not renew any exhausted correction allowance.

## Consolidated testing checkpoint

- Upstream main checked: `f97d56d884b1d3c178f415b95d486464e7b220bf`, already included; zero main-only commits. No merge/rebase from main was needed.
- Preview slice: `80baa1d54376c7d77b9fac675b99af44eab46a0c`, ten owned source/test/doc files, 545 authored lines. Native review approved and acknowledged for this slice only.
- CI slice: `375b3f5fb9196f904b2915f2e3b5d4c0a500497a`, nine workflow/helper/test/doc files, 873 authored lines. Native review approved and acknowledged for this slice only.
- Local evidence: 33 independent source/inert contracts passed; the subsequent addon-prerequisite delta received independent static/identity review plus a parent-host 4/4 test run. These are not full runtime, device or installed acceptance.
- Original worktrees and their selected bytes/modes/index/HEAD/status were preserved. Generated executables, private state, caches and unrelated WIP remain excluded; build them from this checkpoint.
- `integration-tests.yml` runs only for this branch's relevant-input pushes, or explicit manual dispatch: Windows x64/Linux x64 functional tests, native build and disposable installation checks. Read-only permissions; QA artifacts, no deploy/release/main writes. The first exact-head hosted result is recorded below; it is not green.
- Native review warning `R3-001` is informational: fast connection refusal may exhaust twelve startup probes in about three seconds although the deadline is thirty. It remains follow-up work for W1, not an applied correction, and does not reopen the approved review.
- I1 memory-startup isolation, T6 native containment and real voice/device/desktop qualification remain open. An approved source review and passing inert tests do not close them.

### First hosted test result

[Run 43237299238](https://github.com/Gentleman-Programming/gentle-dot/actions/runs/43237299238), source checkpoint `6f5199580b418e365a4f22133346a1b990943682`: **completed, failure**.

| Gate | Result | Evidence boundary |
| --- | --- | --- |
| Target selection | PASS | Windows x64/Linux x64 subset selected |
| Windows setup | PASS | Frozen install, MSVC setup and addon compilation passed |
| Windows functional | FAIL | `pnpm typecheck`, TS2304 at `packages/daemon/test/secret-file.test.ts:41`: missing `statSync` import |
| Linux functional | FAIL | Same typecheck error |
| Later tests/UI build | NOT RUN | Earlier typecheck failure stopped those steps |
| Native build/installed acceptance | SKIPPED | Functional prerequisites failed; no native/installed acceptance inferred |

The failing public test already had this content at the original PR integration and pre-consolidation baseline; consolidation did not edit it. The error is a test-source compile failure, not an observed production runtime failure.
Minimal next scope: Maicol/I2 coordinates a test-only import correction, scoped typecheck/test proof and a new test CI run after explicit bounded authorization. Do not relax typecheck, hide the failure, rerun old failed CI blindly or claim a stable version. The observer's initial network failure was recovered by watching the same run, not by launching a second run.

## Task cards

All cards require the common PR template, applicable R coordination, and parent acceptance of their exact scope before work. Acceptance below is a future observable target.

### I1 — Preview isolation and launcher identity

**Owner: Maicol. Dependencies: none.**
- Goal: prevent preview startup from using an unowned or ambiguous private-memory listener; reconcile the launcher executable pin without altering production defaults.
- Detail: the occupied/ambiguous startup path is a confirmed **source gap, not a proven privacy breach**. The original preview/test source is now consolidated here, but this startup gap is not corrected by copying it.
- Proposed edit areas: `packages/daemon/src/isolation.ts`, its tests under `packages/daemon/test/`, the consolidated preview boundary and the existing launcher preparation in the original integration worktree (`build/pr-preview-open/`, excluded build evidence). Agree a tracked launcher surface before transferring that ignored helper; no generated binary/cache copy.
- Shared/reserved: R applies, especially isolation/config and launcher identity policy; no incidental production/shared contract changes.
- Parent handoff: a separately bounded correction proposal, exact files/checks and canonical ownership proof. Old S7/S8 correction limits remain exhausted; no reusable old receipt or authority.
- Acceptance: approved preview-owned listener starts successfully; occupied unowned and ambiguous listeners are refused before preview use, without mutation/termination of unrelated state; production defaults retain prior behavior.
- Pin evidence: the qualified Engram EXE digest differs from the archive digest. Establish canonical executable/ownership identity; do not pin the EXE to a ZIP hash or weaken the check.
- Verification: test the startup boundaries through existing public behavior, with exact outputs/exits and no unintended state changes; independently review the security unit before downstream qualification.
- Non-goals: proving a historical breach, global memory migration, production default changes, personal-state inspection, or reopening exhausted authority.

### W1 — Windows native runtime and owned shutdown

**Owner: PabloGNU. Dependencies: I1.**
- Goal: qualify the integrated Windows x64 app, daemon and runtime on native Windows, not only source/fake transports.
- Detail: verify Node selection, restricted PATH boundaries, engine readiness, private stdio/fd3 admission, Job ownership and shutdown of owned descendants.
- Proposed edit areas: Windows adapters in `apps/desktop/src-tauri/src/daemon/`, `apps/desktop/src-tauri/src/app_channel/windows.rs`, `packages/daemon/src/windows-*.ts`, `scripts/windows/test/`, and relevant Windows docs.
- Shared/reserved: R applies to common Rust channel/daemon/shell/config and helper contracts; Maicol must accept any shared transfer first.
- Parent handoff: native host/tool versions, I1 base SHA, exact scoped tests, Node/executable identity, PATH observations, ownership and quit/relaunch evidence.
- Acceptance: a real Windows x64 desktop reaches daemon/engine readiness using verified runtime Node and restricted PATH; unowned admission is refused and unrelated processes remain untouched.
- Verification: exercise orderly Quit and owned Job cleanup, channel loss and relaunch; record exit/status and remaining-owned-process observations. Forced smoke cleanup alone does not prove graceful shutdown.
- Preserve: source fallback/explicit overrides and approved production fd3 ownership contract; the retired stdio selector cannot authorize access.
- Non-goals: global PATH changes, trusting PID files as ownership, new transport contracts, ARM64 or installer/device qualification.

### W2 — Windows native voice

**Owner: PabloGNU. Dependencies: W1.**
- Goal: qualify real supported capture, device selection, transcription and spoken output, coordinating UI boundaries with Mars.
- Detail: follow existing WASAPI Capture/Devices, SAPI-to-WAV and Parakeet paths only where actually supported; model presence is not device readiness.
- Proposed edit areas: Windows adapters in `apps/desktop/src-tauri/src/voice/`, corresponding native fixtures, focused `packages/ui/test/voice*` in coordination with Mars, and `docs/windows-voice-output.md`.
- Shared/reserved: R and common voice engine/IPC modules require Maicol; Mars owns UI-control changes. Agree file ownership before any shared test edit.
- Parent handoff: separately approved hardware/provider scope, installed voice/model/device availability, exact native results and UI observations for Mars.
- Acceptance: authorized real capture produces a reviewable transcript; supported local playback is audible; device/model/voice failures are explicit rather than success-shaped fallbacks.
- Verification: stop/cancel/mute and device errors retire active/pending work; late callbacks do not revive speech. Keep typed-only replies silent and existing review-before-send behavior.
- Evidence: memory-WAV/mocked IPC tests supplement but do not prove capture/audibility. A helpers-disabled preview is not voice acceptance.
- Non-goals: unsolicited microphone/playback permission, unsupported Parakeet claims, new voice providers or redesigning the native IPC contract.

### W3 — Disposable Windows installation lifecycle

**Owner: PabloGNU. Dependencies: W1.**
- Goal: qualify Windows x64 installer lifecycle on a disposable authorized machine/profile using the existing producer and guards.
- Detail: distinguish source startup from installed startup; identify installer, runtime manifest and candidate SHA at every stage.
- Proposed edit areas: `scripts/windows/package.ps1`, `scripts/windows/stage.ps1`, `scripts/windows/smoke-install.ps1`, related Windows tests and packaging docs, subject to exact-file approval.
- Shared/reserved: R covers runtime identity/security/config/lockfiles; producer changes touching common packaging helpers go to Maicol.
- Parent handoff: installer hashes, native target/tool versions, lifecycle matrix, bounded diagnostics and ownership-safe cleanup plan.
- Acceptance: clean install launches to ready, then update/reinstall and uninstall behave as documented; owned data canaries and unrelated profiles remain preserved according to the existing contract.
- Verification: compare staged/installed runtime identity, prove restricted-runtime launch and quit, and distinguish graceful shutdown from harness-forced cleanup.
- Preserve: current-user destination/path guards and integrity rejection behavior; record failures without loosening prerequisites.
- Non-goals: replacing the current personal installation, broad profile cleanup, signing/publishing a release or claiming MSI/NSIS parity without measuring each claimed path.

### L1 — Linux x64 desktop and native integration

**Owner: Cinlo. Dependencies: I1 for shared isolation changes.**
- Goal: qualify this integration's current UI, daemon, native ownership/shutdown and existing supported voice behavior on an actual Linux x64 desktop.
- Detail: record distribution, desktop/session, GPU, runtime/tool versions and the candidate SHA; use [Linux testing](linux-testing.md) with this handoff's consent/privacy restrictions.
- Proposed edit areas: Linux adapters in `apps/desktop/src-tauri/src/`, Linux-only daemon adapters/tests where present, `scripts/linux/`, and `docs/linux-testing.md`, restricted to approved exact files.
- Shared/reserved: R applies; common shell/daemon/voice modules and Linux/Windows helper common files are not exclusively owned by Cinlo.
- Parent handoff: desktop/session observations, daemon readiness, quit/relaunch and owned-process results, plus supported native voice/device outcomes for Mars.
- Acceptance: visible rose/panel/tray and existing navigation/chat work on the recorded native session; owned daemon/children stop without touching unrelated processes; existing supported voice is measured with consent.
- Verification: distinguish desktop limitations from regressions, including current GNOME/Hyprland behavior; missing voice proof remains unverified, not inferred from container checks.
- Prior Linux x64/ARM64 CI passes belong to earlier commits/builds and container evidence; they do not qualify this integration's desktop.
- Non-goals: Windows code changes, inventing Linux native features, ARM64 first-stable acceptance or treating artifact creation as desktop proof.

### L2 — Linux x64 producer and installation lifecycle

**Owner: Cinlo. Dependencies: L1.**
- Goal: qualify the existing x64 producer and disposable native install/update/reinstall/removal paths with target-qualified artifacts.
- Detail: use the existing amd64 Docker producer and distro checks, then separately validate installation and launch on the native Linux desktop.
- Proposed edit areas: `scripts/package/package-linux.mjs`, `scripts/package/linux-*.mjs`, `scripts/package/test-linux/`, `docker/linux-package/`, `packaging/arch/`, relevant `scripts/linux/` and Linux packaging docs.
- Shared/reserved: R applies to shared packaging helpers, manifests, runtime contracts, CI and dependency files; coordinate with Maicol, never parallel-edit common helpers with Windows.
- Parent handoff: target, package/runtime manifest hashes, producer commands, distro results and native lifecycle observations tied to SHA.
- Acceptance: claimed x64 package formats build and pass existing checks; installed app launches, update/reinstall and removal preserve unrelated profiles and documented retained data.
- Verification: exercise clean and repeat lifecycle paths in disposable state; separate container install smoke from real desktop/daemon/native voice observations inherited from L1.
- Preserve: existing Debian/Arch target mapping, runtime integrity and unsupported-target failures; do not substitute x64 proof for ARM64.
- Non-goals: Windows code, a new installer architecture, changing package-manager contracts or ARM64/macOS first-stable delivery.

### UI1 — Existing application-flow regressions

**Owner: Mars. Dependencies: none; may run in parallel with I1.**
- Goal: reproduce and fix integration regressions in existing navigation, chat, settings and application-owned error flows, without redesign.
- Detail: verify open/hide/navigation, streamed chat, settings persistence and visible recovery/error states using existing behavior as the reference.
- Proposed edit areas: `packages/ui/src/` presentation/components and focused `packages/ui/test/` regressions, plus relevant UI behavior docs; exact files agreed first.
- Shared/reserved: R applies; native shell/config, protocol, daemon and shared state contracts require Maicol rather than unilateral UI changes.
- Parent handoff: reproduction, before/after screenshots or bounded observations without personal content, focused regression results and required platform follow-ups.
- Acceptance: existing flows remain usable and errors remain visible/actionable on the integration; settings retain prior semantics and rejected actions leave owned state unchanged.
- Verification: observe RED/GREEN for reproduced deterministic bugs and one preservation test per touched existing behavior; native/window claims require native observations.
- Dependencies delivered: supply UI1 results and stable control-state expectations to UI2 and Maicol, not an assertion that platform runtime is qualified.
- Non-goals: redesign, new features, native IPC changes, provider-account access or approving Windows/Linux acceptance on their owners' behalf.

### UI2 — Voice-control interaction

**Owner: Mars. Dependencies: UI1, W2 and L1 acceptance.**
- Goal: qualify existing voice-control status, device selection, stop/cancel and errors against PabloGNU's Windows and Cinlo's Linux results.
- Detail: reconcile UI states with actual platform availability; device, transcription and playback availability are distinct.
- Proposed edit areas: `packages/ui/src/useVoice.ts`, `packages/ui/src/voice-*.ts`, `packages/ui/src/voice-output.ts`, `packages/ui/src/speech.ts`, existing `packages/ui/src/components/` voice controls and focused `packages/ui/test/voice*`.
- Shared/reserved: R applies; native voice/IPC/protocol changes require named Maicol/PabloGNU/Cinlo coordination; shared tests need an agreed writer.
- Parent handoff: W2/L1 evidence references, control-state matrix, exact test results and separately consented real-platform observations.
- Acceptance: stop/cancel retires pending work, device/state errors are visible, unavailable hardware is not shown as ready, and late results do not resurrect cancelled output.
- Verification: deterministic state/error/cancellation regressions plus authorized Windows/Linux observations; preserve existing transcript review and opt-in pause-to-send semantics.
- Dependencies missing: report UI-only checks separately; do not declare cross-platform voice accepted before W2/L1 supply native evidence.
- Non-goals: redesign, new voice features, changing native IPC contracts alone or treating mocks as hardware acceptance.

### I2 — Shared integration and reviewable slices

**Owner: Maicol. Dependencies: approved contributor slices as they become available.**
- Goal: steward the main integration branch and shared contracts, integrating reviewable dependent PRs at explicit baselines.
- Detail: preserve full intent/history while splitting oversized changes; the existing full PR233 candidate stopped at `lens_context_budget_exceeded` and remains unapproved.
- Proposed edit areas: approved shared integration surfaces in R, schema/protocol, Rust shell/config/security, lockfiles and common CI, with exact per-slice authorization.
- Shared/reserved: Maicol is custodian, not a bypass; name affected platform/UI reviewers and transfer any common-file ownership explicitly.
- Parent handoff: dependency order, base/head SHAs, full-history/intent references, exact scoped diff/checks and the public next integration baseline.
- Acceptance: approved slices compose without unrequested shared-contract changes; Windows contracts remain preserved and evidence maps to the actual integrated tree.
- Verification: scoped checks, preservation/differential evidence where shared contracts are affected, then authorized native/CI checks; coordinate the existing test-only Windows Cargo WIP transfer.
- Review limit: no force bypass, receipt reset or reuse of consumed review authority; splitting is not permission to omit intent or evade review limits.
- Non-goals: blind trunk rebases, unapproved correction-budget renewal, merging main or release publication authority.

### I3 — One release-candidate qualification dossier

**Owner: Maicol. Dependencies: I1, W1–W3, L1–L2, UI1–UI2 and I2.**
- Goal: freeze one candidate SHA and propose the first stable Windows x64/Linux x64 version from the same published source tree.
- Detail: collect current native functional tests, CI results, artifact identities, known limitations and machine/OS/tool versions; prior-commit evidence stays labeled historical.
- Proposed edit areas: candidate evidence in `docs/stable-integration-handoff.md` and `docs/distribution.md`, with any additional evidence document explicitly scoped first; product or CI fixes return to owner cards.
- Shared/reserved: R changes are not silently folded into qualification; any code change creates a new candidate and requires applicable checks again.
- Parent handoff: one published candidate SHA, all ten named task dispositions, per-target acceptance and every failed/skipped/unverified check; parent owns final decision/publication.
- Acceptance: Windows x64 and Linux x64 runtime, installation, UI and voice evidence all qualify that candidate; native tests and required CI gates pass with documented scope.
- Blocking rule: no gate waives privacy or failed required checks. Unverified voice means **candidate not qualified**; missing provider/hardware consent is never invented.
- Verification: reconcile evidence SHAs/targets and limitations before a release proposal; explicitly separate subsequent ARM64/macOS work.
- Non-goals: publishing a release, silently waiving limitations, using a newer build with older proof or treating documentation completion as stable readiness.

## Common PR delivery template

Use one template per scoped behavior PR; keep parent-confirmed issue references blank/pending until publication is read back.

```text
Task ID / named owner / reviewers and shared-file handoff:
Related issue: pending parent confirmation (then confirmed URL)
Base SHA / head SHA / dependency PRs / intended integration baseline:
Goal / reproduced behavior / non-goals / exact scoped files:
RED / GREEN / preservation / differential results, or specific applicability exception:
Functional/native observations: target, machine/OS/tool versions, artifact/runtime identities:
Exact commands: exit code, counts, reviewed/redacted stdout/stderr or observation reference:
Every failed / skipped / cancelled / unavailable check and remaining limitation:
Privacy/owned-state preservation evidence; no credentials, .env or profile logs:
Native/device/provider approval scope and results, or explicitly unverified:
Review status / next owner / parent decision needed / qualification not yet established:
```

## Reference path and next action

Start with the [README](../README.md), [installation guide](install.md), [desktop notes](../apps/desktop/README.md),
[Windows testing](windows-testing.md), [runtime discovery](windows-runtime-discovery.md), [Windows voice](windows-voice-output.md),
[Linux testing](linux-testing.md), [platform packaging](platform-packaging.md) and [distribution boundaries](distribution.md).
Historical status sections in platform docs are not current acceptance; use the explicit candidate SHA and this handoff's privacy/consent boundaries.
Next: Maicol scopes I1 and Mars scopes UI1 against the agreed baseline, then the platform owners follow the dependency table. Use the confirmed issue for each delivery. Implementation, native acceptance and release remain future work; this documentation publication grants no extra execution or release authority.
