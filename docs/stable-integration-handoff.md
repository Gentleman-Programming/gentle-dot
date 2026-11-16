# First stable integration: owner handoff

**Proposed, PENDING ACCEPTANCE: PabloGNU takes I1 + existing W1–W3; Cinlo takes I2/I3/C5/C4 + existing L1/L2 and shared reservation R; Mars retains UI1/UI2 and his existing Windows deliveries. Maicol has no remaining execution duties.**
Recipients first accept; ownership transfer is not delivery or execution consent. W1 is **BLOCKED** on I1 PR/EXACT candidate SHA/test scope; C5 stays paused and C4 follows C5. Target: **Windows x64 and Linux x64**; ARM64 and macOS are later milestones. Technical work is not accepted or green because this document exists.

## Quick path: one agreed baseline

1. Read current instructions without changing a dirty implementation branch:
   ```sh
   git fetch origin docs/stable-integration-team
   git show origin/docs/stable-integration-team:docs/stable-integration-handoff.md
   git show origin/docs/stable-integration-team:odd/tasks/stable-integration.md
   ```
   These are contributor instructions, not commands executed by this handoff. Do not `git pull`, reset or rebase current dirty branches just to read docs. Each ID has an explicit owner; the parent owns tracker transitions.
2. Use consolidated product checkpoint `375b3f5fb9196f904b2915f2e3b5d4c0a500497a` on `docs/stable-integration-team` (preview slice `80baa1d54376c7d77b9fac675b99af44eab46a0c`); the original PR merge baseline was `0b2f98fca6f48e751c9daf29fca8909b1840b2da`. UI1 keeps this agreed code base; later public docs-only updates do not require Mars to rebase code. Read the latest handoff/evidence before choosing any other implementation SHA.
3. After recipient acceptance and separate authorization, agree the exact base SHA and file list with Cinlo as integration custodian; use `feat/stable-<ID>-<slug>` for the first contributor branch and identify dependent PRs.
4. Reproduce one bounded behavior, deliver code + tests + relevant docs together, then hand off the evidence template below. Creating this plan grants no execution consent.
5. Cinlo, after acceptance and applicable authorization, coordinates approved integration slices and a new public candidate SHA; parent retains terminal Git/publication and human delivery decisions. Contributors align with that candidate, not a blind rebase onto trunk.

This branch now consolidates the full PR232/PR233 history, the ten selected preview/test source files from the original integration worktree, and the seven selected primary CI/helper/test/doc files. Source manifests record byte-identical transfers; the source worktrees remain untouched. Generated binaries, caches, unrelated WIP and private data are not committed.
Fresh upstream `main` at `f97d56d884b1d3c178f415b95d486464e7b220bf` was already included (zero main-only commits), so no merge from main was needed.
This is a common **testing checkpoint**, not preview-ready or stable acceptance. I1 memory-startup isolation and the historical T6 native-containment proof remain open.
The authoritative scope and owner association are [S1–S11](../odd/tasks/stable-integration.md#specs). A dedicated exact-branch Windows x64/Linux x64 workflow runs tests/builds and disposable installation checks only, never deployment or release.

## Deliverables and confirmed issue mapping

Named owners are people, not inferred GitHub handles or assignees. All ten issues were originally created/read back with the earlier owners and no GitHub account assignees or labels. This docs-only reassignment does not modify issue bodies or accounts; the current proposed owners below supersede the historical document assignments only, pending recipient acceptance.
Publication is coordination, not technical acceptance or execution permission.

| ID | Named owner | Deliverable | Dependencies | GitHub issue |
| --- | --- | --- | --- | --- |
| I1 | PabloGNU (PENDING ACCEPTANCE) | Preview isolation and launcher identity | None | [#237](https://github.com/Gentleman-Programming/gentle-dot/issues/237) |
| W1 | PabloGNU | BLOCKED; checkpoint startup/runtime/owned-shutdown gaps; reuse Mars's Windows work | I1 PR/EXACT candidate SHA/test scope; compare #215/22b/23 deltas | [#238](https://github.com/Gentleman-Programming/gentle-dot/issues/238) |
| W2 | PabloGNU | MATRICES-only preparation proposal approved, not done; future PR232-integrated voice/UI2 evidence | W1; qualify older evidence | [#239](https://github.com/Gentleman-Programming/gentle-dot/issues/239) |
| W3 | PabloGNU | MATRICES-only preparation proposal approved, not done; future disposable lifecycle | W1 | [#240](https://github.com/Gentleman-Programming/gentle-dot/issues/240) |
| L1 | Cinlo | Linux x64 desktop/daemon/native acceptance | I1 for shared isolation | [#241](https://github.com/Gentleman-Programming/gentle-dot/issues/241) |
| L2 | Cinlo | Linux x64 producer and installation lifecycle | L1 | [#242](https://github.com/Gentleman-Programming/gentle-dot/issues/242) |
| UI1 | Mars | [PR247](https://github.com/Gentleman-Programming/gentle-dot/pull/247) Escape-menu / [PR248](https://github.com/Gentleman-Programming/gentle-dot/pull/248) select-groups submitted; review/integration pending | Base 375b3f5; parallel with I1 | [#243](https://github.com/Gentleman-Programming/gentle-dot/issues/243) |
| UI2 | Mars | Voice-control interaction acceptance | UI1, W2, L1 acceptance | [#244](https://github.com/Gentleman-Programming/gentle-dot/issues/244) |
| I2 | Cinlo (PENDING ACCEPTANCE) | Delta reconciliation, shared integration and reviewable slices | Approved slices; C5 remains paused | [#245](https://github.com/Gentleman-Programming/gentle-dot/issues/245) |
| I3 | Cinlo (PENDING ACCEPTANCE) | One stable candidate qualification dossier | I1, W1–W3, L1–L2, UI1–UI2, I2 | [#246](https://github.com/Gentleman-Programming/gentle-dot/issues/246) |

### Handoff starts

1. Recipients first accept the new assignments. Cinlo then owns shared R/dependency coordination, not blanket shared-file permission; L1/L2 remain his. Maicol is not an ongoing blocker-approval gate. Human consent/delivery decisions stay separate; D5 reassignment was published as `da7e6a8`; recipient acceptance remains pending.
2. PabloGNU scopes I1 as a bounded shared security unit, with exact files/checks/consent and independent review; old exhausted limits, worker prohibitions and authority remain. A new executor cannot bypass them: obtain bounded human disposition before execution. Publish I1 PR/EXACT candidate SHA/check scope only when applicable authorization exists; ownership is not an already delivered fix.
3. Cinlo receives PUBLIC repository test-import-fix context for C5, but the corrected `packages/daemon/test/secret-file.test.ts` exists **only uncommitted on Maicol's worktree**, no PR/commit and no promise of availability by fetch. Exact change: add `statSync` to the existing `node:fs` import; SHA256 `0980c0857e3855ffcf8e6e9cce7ce81c0ca21d65fba35ef5f5548f9346fca76a`. This is not authorization to apply/retry it.
4. C5 remains **paused**: source correction 1/1 and auxiliary repair 1/1 consumed. Preparation failed first because TypeScript 7.0.2 has no classic API, then with "Resolution metadata differs: tsconfig.json". Human bounded disposition is required; handoff grants no automatic third preparation attempt or new budget. Cinlo's C4 stays ordered after C5; neither is accepted/executable.
5. W1 stays BLOCKED until I1 PR/EXACT SHA/test scope. W2/W3 may prepare matrices only (cases, existing tests, prerequisites, expected evidence, SHA dependencies and pending consent); matrices are not done. No tests, devices, installers or R3 re-verification authorized. Mars retains UI1/UI2 and all Windows deliveries below.

`375b3f5fb9196f904b2915f2e3b5d4c0a500497a` remains the code checkpoint. `e7ff3b7ce9e30a47f40133af22fd9244fd73267b` and this update are documentation-only, not an I1 fix or a new code candidate. No new CI, main merge, release, deploy or GitHub assignee operation is authorized. Passive documentation risk: none; no enforcement change.

## Existing contributions, dependencies and evidence

Reuse before rewriting; these remain **Mars's deliveries**, not new PabloGNU implementation assignments.

| Delivery / evidence | Current boundary | Reuse / next owner action |
| --- | --- | --- |
| [PR215](https://github.com/Gentleman-Programming/gentle-dot/pull/215) | Parent-checked: OPEN, non-draft, base `main`, head `a583a68a205900f7a9eb2a130caa413a13439ab3`; eight aggregate PR checks SUCCESS | Mars retains ownership; user reports waiting for Quique. Cinlo, pending acceptance, compares actual delta before reuse: some content may have arrived through other branches; do not claim inclusion in 375b3f5. |
| [Run 42699458220](https://github.com/Gentleman-Programming/gentle-dot/actions/runs/42699458220) | Parent-checked SUCCESS at the same head; four Windows jobs: Typecheck/lint, Native addon, Rust shell, Native app channel | Green checks are not review approval, integrated-candidate acceptance or merge permission. |
| 22b: [`test/windows-failure-paths`](https://github.com/MarsSall/gentle-dot/tree/test/windows-failure-paths), `2b65fc2be509ef6b7160fed0e079ab3627eda7f2` | Parent-confirmed PUBLIC branch, no PR; depends on PR215 as reported; error-write/unreadable-sign-in tests, three mutants reported caught | Mars retains authorship; PabloGNU reuses rather than recreates error paths/suite. |
| 23: [`docs/windows-port-docs`](https://github.com/MarsSall/gentle-dot/tree/docs/windows-port-docs), `906a63fd5c4a3bc2bbcf7b611a0bc7efd450637c` | Parent-confirmed PUBLIC branch, no PR; six documentation files; needs author rebase as reported | Mars owns any rebase after coordination; PabloGNU reuses docs, not rewrites the port guide. |
| Windows PC / WASAPI real mic | AUTHOR-REPORTED, TEST SHA NOT SUPPLIED: 96/96, related #199; installed app indicators working, typing uncorrupted during app stalls, typing stops when foreground changes | Obtain base SHA, host/tool versions and exact commands before reuse. Not independently observed, not PR232 or new-candidate acceptance. |

22b/23 are delivery labels, not issues; public branches do not mean reviewed, merged or automatically transferred work. No blind cherry-pick, rebase, migration, GitHub assignee changes, PR approval or merge is authorized here.

**Pablo 11:43 report (human-forwarded, author-reported):** R3-001 is **CLOSED; no more verification**. His own `odd/tasks/stable-windows-acceptance.md` and commit `31f09d7` remain evidence references, not locally available or edited here. Do not infer I1 delivery: W1 still needs the I1 PR/EXACT candidate SHA/test scope. The conversation-approved W2/W3 matrices-only preparation proposal is not completed and grants no tests/device/installer work.

**Owner starts:** follow the acceptance-first sequence above. Mars supplies existing evidence and supports UI1 review, then UI2. PabloGNU owns only bounded, authorized I1 work after acceptance and later W1 gaps; W2/W3 remain matrix preparation only now. Cinlo retains L1/L2 and proposed I2/I3/C5/C4/R coordination; no extra features or PRs are requested.

## Working practices and boundaries

### Scoped ownership, not folder exclusivity

The areas in each card are **proposed repository-relative implementation boundaries**, not authority to edit everything beneath a folder.
Before implementation, the parent must approve an exact file list and checks. Findings outside it return to Cinlo as proposed integration custodian; unresolved scope/consent decisions return to the human, not Maicol; do not expand a task silently.
Platform owners change only their OS-specific adapters inside shared trees. Windows and Linux helper/common files must not receive parallel writes.

**Shared reservation R — Cinlo is proposed custodian (PENDING ACCEPTANCE); coordinate and record a named handoff before any change:**
`apps/desktop/src-tauri/src/shell.rs`, `apps/desktop/src-tauri/src/config.rs`, shared Rust shell/channel/daemon modules and Tauri configuration;
`packages/daemon/src/isolation.ts`, `packages/daemon/src/config.ts`, `packages/protocol/`, shared daemon/helper contracts;
all `package.json` files, `pnpm-lock.yaml`, `apps/desktop/src-tauri/Cargo.lock`, Cargo manifests/dependency changes, security settings, and `.github/workflows/`.
An owner label never bypasses R. Shared UI/native/protocol changes need both affected platform owners and Cinlo; separate human authorization remains required; platform acceptance remains with the named platform owner.

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
- Historical native review warning `R3-001` concerned fast refusal exhausting twelve probes before the thirty-second deadline. Current disposition per forwarded Pablo 11:43 report: **CLOSED, no more verification**; retain his own tracker/31f09d7 as author-reported evidence, unavailable locally. No review reopening or R3 re-test.
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

Parent Git-diff confirmation attributes the removed import to **our merge `c8e11d7`**, not Mars. It was already missing at the original integration/pre-consolidation baseline; consolidation did not edit it. This is a test-source compile failure, not an observed production runtime failure, and PR215 does not establish a fix for it.
**C5 remains paused:** Maicol's import-only local correction is uncommitted, unpublished and unverified; typecheck, focused tests and new CI must not resume through this docs update. Both preparation failures and consumed budgets remain in the ODD history. Do not relax gates or rerun CI blindly. The observer's initial network failure was recovered by watching the same run, not by launching a second run.

## Task cards

All cards require the common PR template, applicable R coordination, and parent acceptance of their exact scope before work. Acceptance below is a future observable target.

### I1 — Preview isolation and launcher identity

**Missing evidence attached (S11):** [original inert launcher/observer, recorded identity digests and post-S7/S8 stop record](evidence/i1-handoff/README.md). These are original sources, not an I1 fix or runnable bundle. The packet distinguishes original integration S7/S8 from stable S8/C5; no ownership reconfirmation, implementation, checks or CI is requested. Existing limits require bounded human disposition or stop, not an automatic new attempt.

**Proposed owner: PabloGNU (PENDING ACCEPTANCE). Dependencies: none; old exhausted limits require bounded human disposition.**
- Goal: prevent preview startup from using an unowned or ambiguous private-memory listener; reconcile the launcher executable pin without altering production defaults.
- Detail: the occupied/ambiguous startup path is a confirmed **source gap, not a proven privacy breach**. The original preview/test source is now consolidated here, but this startup gap is not corrected by copying it.
- Proposed edit areas: `packages/daemon/src/isolation.ts`, its tests under `packages/daemon/test/`, the consolidated preview boundary and the existing launcher preparation in the original integration worktree (`build/pr-preview-open/`, excluded build evidence). Agree a tracked launcher surface before transferring that ignored helper; no generated binary/cache copy.
- Shared/reserved: R applies, especially isolation/config and launcher identity policy; no incidental production/shared contract changes.
- Parent handoff: a separately bounded correction proposal, exact files/checks/consent and canonical ownership proof, coordinated through Cinlo/R after acceptance. Old S7/S8 correction limits remain exhausted; no reusable old receipt or authority, and no bypass by changing executor. Independent security review remains required; publish PR/EXACT candidate SHA/test scope only under applicable authorization.
- Acceptance: approved preview-owned listener starts successfully; occupied unowned and ambiguous listeners are refused before preview use, without mutation/termination of unrelated state; production defaults retain prior behavior.
- Pin evidence: the qualified Engram EXE digest differs from the archive digest. Establish canonical executable/ownership identity; do not pin the EXE to a ZIP hash or weaken the check.
- Verification: test the startup boundaries through existing public behavior, with exact outputs/exits and no unintended state changes; independently review the security unit before downstream qualification.
- Non-goals: proving a historical breach, global memory migration, production default changes, personal-state inspection, or reopening exhausted authority.

### W1 — Windows native runtime and owned shutdown

**Owner: PabloGNU. BLOCKED until I1 PR/EXACT candidate SHA/test scope; compare Mars's #215/22b/23 deltas before reuse. Owning I1 is not its delivery.**
- Goal: verify compatibility and close checkpoint-specific Windows x64 startup/runtime/owned-shutdown gaps, not implement the port or recreate Mars's suite, error paths or docs.
- Detail: reuse existing deliveries; identify remaining Node selection, restricted PATH, engine readiness, private stdio/fd3 admission, Job ownership and owned-descendant shutdown gaps. R3-001 is CLOSED per forwarded author report; no further verification.
- Proposed edit areas: Windows adapters in `apps/desktop/src-tauri/src/daemon/`, `apps/desktop/src-tauri/src/app_channel/windows.rs`, `packages/daemon/src/windows-*.ts`, `scripts/windows/test/`, and relevant Windows docs.
- Shared/reserved: R applies to common Rust channel/daemon/shell/config and helper contracts; Cinlo coordinates any shared transfer after accepting R custody; human scope/consent remains required.
- Parent handoff: native host/tool versions, I1 base SHA, exact scoped tests, Node/executable identity, PATH observations, ownership and quit/relaunch evidence.
- Acceptance: a real Windows x64 desktop reaches daemon/engine readiness using verified runtime Node and restricted PATH; unowned admission is refused and unrelated processes remain untouched.
- Verification: exercise orderly Quit and owned Job cleanup, channel loss and relaunch; record exit/status and remaining-owned-process observations. Forced smoke cleanup alone does not prove graceful shutdown.
- Preserve: source fallback/explicit overrides and approved production fd3 ownership contract; the retired stdio selector cannot authorize access.
- Non-goals: global PATH changes, trusting PID files as ownership, new transport contracts, ARM64 or installer/device qualification.

### W2 — Windows native voice

**Owner: PabloGNU. Dependencies: W1. Current scope: MATRICES-only preparation proposal approved in conversation, not completed.**
- Now: prepare cases/existing tests/prerequisites/expected evidence/SHA dependencies/pending consent only; no tests, devices or R3 re-verification. Remaining bullets describe future separately authorized qualification, not current permission.
- Goal: qualify PR232-integrated capture, device selection, transcription and spoken output with appropriately consented real-device checks; hand evidence to Mars/UI2. Mars's separate Windows report has no supplied test SHA; it is a reuse lead, not acceptance.
- Detail: follow existing WASAPI Capture/Devices, SAPI-to-WAV and Parakeet paths only where actually supported; model presence is not device readiness.
- Proposed edit areas: Windows adapters in `apps/desktop/src-tauri/src/voice/`, corresponding native fixtures, focused `packages/ui/test/voice*` in coordination with Mars, and `docs/windows-voice-output.md`.
- Shared/reserved: R and common voice engine/IPC modules require Cinlo/R coordination; Mars owns UI-control changes. Agree file ownership before any shared test edit.
- Parent handoff: separately approved hardware/provider scope, installed voice/model/device availability, exact native results and UI observations for Mars.
- Acceptance: authorized real capture produces a reviewable transcript; supported local playback is audible; device/model/voice failures are explicit rather than success-shaped fallbacks.
- Verification: stop/cancel/mute and device errors retire active/pending work; late callbacks do not revive speech. Keep typed-only replies silent and existing review-before-send behavior.
- Evidence: memory-WAV/mocked IPC tests supplement but do not prove capture/audibility. A helpers-disabled preview is not voice acceptance.
- Non-goals: unsolicited microphone/playback permission, unsupported Parakeet claims, new voice providers or redesigning the native IPC contract.

### W3 — Disposable Windows installation lifecycle

**Owner: PabloGNU. Dependencies: W1. Current scope: MATRICES-only preparation proposal approved in conversation, not completed.**
- Now: prepare cases/existing tests/prerequisites/expected evidence/SHA dependencies/pending consent only; no tests, installers or R3 re-verification. Remaining bullets describe future separately authorized qualification, not current permission.
- Goal: qualify fresh disposable Windows x64 install, update/reinstall and uninstall on an authorized machine/profile, reusing the existing producer, docs and guards.
- Detail: distinguish source startup from installed startup; identify installer, runtime manifest and candidate SHA at every stage.
- Proposed edit areas: `scripts/windows/package.ps1`, `scripts/windows/stage.ps1`, `scripts/windows/smoke-install.ps1`, related Windows tests and packaging docs, subject to exact-file approval.
- Shared/reserved: R covers runtime identity/security/config/lockfiles; producer changes touching common packaging helpers go to Cinlo/R.
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
- Shared/reserved: R applies to shared packaging helpers, manifests, runtime contracts, CI and dependency files; coordinate with Cinlo/R and affected owners, never parallel-edit common helpers with Windows.
- Parent handoff: target, package/runtime manifest hashes, producer commands, distro results and native lifecycle observations tied to SHA.
- Acceptance: claimed x64 package formats build and pass existing checks; installed app launches, update/reinstall and removal preserve unrelated profiles and documented retained data.
- Verification: exercise clean and repeat lifecycle paths in disposable state; separate container install smoke from real desktop/daemon/native voice observations inherited from L1.
- Preserve: existing Debian/Arch target mapping, runtime integrity and unsupported-target failures; do not substitute x64 proof for ARM64.
- Non-goals: Windows code, a new installer architecture, changing package-manager contracts or ARM64/macOS first-stable delivery.

### UI1 — Existing application-flow regressions

**Owner: Mars. Dependencies: none; may run in parallel with I1.**
- Submitted, not accepted: two independent OPEN PRs by `MarsSall`, targeting `docs/stable-integration-team`, with agreed code baseline `375b3f5fb9196f904b2915f2e3b5d4c0a500497a`; bodies use **Refs #243**, not Closes. Review/integration remain planned until both are accepted.
- [PR247](https://github.com/Gentleman-Programming/gentle-dot/pull/247): `feat/stable-UI1-escape-menu`, head `cbe22797d34291f17829b0eb347aef2fd6177419` — ONLY `packages/ui/src/components/HeaderMenu.tsx` and `packages/ui/test/window.test.tsx`.
- [PR248](https://github.com/Gentleman-Programming/gentle-dot/pull/248): `feat/stable-UI1-select-groups`, head `56fa0f264b1c327c7756798453bed5343756c154` — ONLY `packages/ui/src/components/SelectMenu.tsx` and `packages/ui/test/select-menu.test.tsx`.
- Read-only supplied patches show capture-phase Escape handling with `preventDefault` and group offsets into flat indices, consistent with the reported scope; this is not technical approval or functional reproduction. Optional `header.test`, `profiles.test`, `settings.test` remain outside the edit scope; no `App.tsx` without new coordination.
- Shared/reserved: R applies; native shell/config, protocol, daemon and shared state contracts require Cinlo/R coordination rather than unilateral UI changes.
- Parent handoff: reproduction, before/after screenshots or bounded observations without personal content, focused regression results and required platform follow-ups.
- Acceptance: reproduced Escape-menu and grouped-selection regressions pass their scoped tests while prior behavior is preserved; both PRs require acceptance before #243 can close.
- AUTHOR-REPORTED local evidence, latest Linux Node 24.14.1/pnpm 11.5: base 375b3f5 370/370; PR247 371/371 (one added RED→GREEN); PR248 372/372 (one RED→GREEN plus one preservation). Prior 373 was a combined review worktree with three added cases, not parametrization. Mars reports local UI tsc/Biome clean; no whole-repository suite or native execution. These supersede the earlier Node 26 report, not independent reproduction.
- Hosted snapshot from parent-supplied metadata, not live/final CI: PR247 `typescript`, `rust`, `Native app channel` FAILED; PR248 `typescript`, `rust` FAILED; other checks QUEUED and `installer` SKIPPED on both. Causes are undiagnosed; do not attribute all failures to statSync. Neither PR is CI-green or native acceptance.
- Dependencies delivered: supply UI1 results and stable control-state expectations to UI2 and Cinlo, not an assertion that platform runtime is qualified.
- Non-goals: settings navigation, mailto/http/https allowlist fixes, redesign, new features, native IPC changes, provider access or platform acceptance. Existing Windows PRs remain Mars's deliveries.

### UI2 — Voice-control interaction

**Owner: Mars. Dependencies: UI1, W2 and L1 acceptance.**
- Goal: qualify existing voice-control status, device selection, stop/cancel and errors against PabloGNU's Windows and Cinlo's Linux results.
- Detail: reconcile UI states with actual platform availability; device, transcription and playback availability are distinct.
- Proposed edit areas: `packages/ui/src/useVoice.ts`, `packages/ui/src/voice-*.ts`, `packages/ui/src/voice-output.ts`, `packages/ui/src/speech.ts`, existing `packages/ui/src/components/` voice controls and focused `packages/ui/test/voice*`.
- Shared/reserved: R applies; native voice/IPC/protocol changes require named Cinlo/PabloGNU/Mars coordination; shared tests need an agreed writer.
- Parent handoff: W2/L1 evidence references, control-state matrix, exact test results and separately consented real-platform observations.
- Acceptance: stop/cancel retires pending work, device/state errors are visible, unavailable hardware is not shown as ready, and late results do not resurrect cancelled output.
- Verification: deterministic state/error/cancellation regressions plus authorized Windows/Linux observations; preserve existing transcript review and opt-in pause-to-send semantics.
- Dependencies missing: report UI-only checks separately; do not declare cross-platform voice accepted before W2/L1 supply native evidence.
- Non-goals: redesign, new voice features, changing native IPC contracts alone or treating mocks as hardware acceptance.

### I2 — Shared integration and reviewable slices

**Proposed owner: Cinlo (PENDING ACCEPTANCE). Dependencies: approved contributor slices as they become available; C5 paused and C4 after C5.**
- Goal: compare actual Mars delivery deltas before integrating approved slices at explicit baselines; do not assume PR215 is included in 375b3f5. Steward shared contracts and the integration branch.
- Detail: preserve full intent/history while splitting oversized changes; the existing full PR233 candidate stopped at `lens_context_budget_exceeded` and remains unapproved.
- Proposed edit areas: approved shared integration surfaces in R, schema/protocol, Rust shell/config/security, lockfiles and common CI, with exact per-slice authorization.
- Shared/reserved: Cinlo is proposed R custodian pending acceptance, not a bypass; name affected platform/UI reviewers and transfer any common-file ownership explicitly.
- Parent handoff: dependency order, base/head SHAs, full-history/intent references, exact scoped diff/checks and the public next integration baseline.
- Acceptance: approved slices compose without unrequested shared-contract changes; Windows contracts remain preserved and evidence maps to the actual integrated tree.
- Verification: future scoped checks, preservation/differential evidence and separately authorized native/CI checks; C5 code/typecheck/tests/CI remain paused. Cinlo is proposed custodian of our merge c8e11d7 statSync regression, not Mars; the uncommitted correction remains only on Maicol's worktree, with no fetchable PR/commit; no root verification is authorized by this handoff.
- Review limit: no force bypass, receipt reset or reuse of consumed review authority; splitting is not permission to omit intent or evade review limits.
- Non-goals: blind trunk rebases, unapproved correction-budget renewal, merging main or release publication authority.

### I3 — One release-candidate qualification dossier

**Proposed owner: Cinlo (PENDING ACCEPTANCE). Dependencies: I1, W1–W3, L1–L2, UI1–UI2 and I2.**
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
Next: recipients accept the proposed assignments first; follow **Handoff starts**. Cinlo coordinates R/shared deltas after acceptance; PabloGNU scopes I1 only within separately authorized limits, with W1 blocked and W2/W3 matrices only. Mars retains UI1/UI2 and Windows deliveries; Cinlo retains L1/L2. Use the confirmed issue references without modifying their bodies here. Maicol has no ongoing execution/approval-gate role. C5 code/checks/new CI stay paused; this documentation publication grants no extra execution or release authority.
