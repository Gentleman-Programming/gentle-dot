# Windows Native Independent Port — Recovery Tasks

This document recovers task tracking for the authorized Windows port of the official Gentleman-Programming/gentle-dot repository on feat/windows-native-independent, based on 8cb20ee888c88be2b359258a65499c20b59e2a86. It was created after implementation had already begun under prior instructions; it is not represented as a pre-write plan. The goal is a native Windows implementation that preserves the existing security, privacy, confirmation, and bounded process-cleanup guarantees.

## Scope and operating constraints

- Source: official Gentleman-Programming/gentle-dot; branch: feat/windows-native-independent. Do not use PR #57, modify main, or publish releases.
- The parent cloned and applied ../independent-windows.patch. Invalid ambient GITHUB_TOKEN was excluded process-only; the Maicololiveras keyring gh authentication is valid for MAINTAIN.
- W1 `9a5c0b4e7c1aac6d82e7b46630268520e65f89e0`, W2 `ea1ade4f97209e98714e43b09e46ded435d25329`, W3 `70cabf981d494525a4a63789c82ee44ffd67afb7`, and W4 `45213ba240c6c6e3cc40a2a82b149910c0b76961` are pushed to official `feat/windows-native-independent`. W1/W2 and the accumulated W3+W4 slice have approved, acknowledged native reviews. `gh run list` still reports no runs; the Windows workflow remains staged for W5. No PR or merge has occurred; approval is not native executable/installer proof.
- Review mode is on by default. W1 and W2 reviews are approved and acknowledged (authority burned); their candidate-scoped human grants were explicit. Neither approval establishes unexecuted Windows runtime behavior.
- Current reviewed boundary is W4 `45213ba240c6c6e3cc40a2a82b149910c0b76961`. Review only a work-unit commit or PR slice, never the accumulated feature branch.
- Preserve existing grants, confirmations, privacy boundaries, and bounded owned-process cleanup. Do not apply global ACLs, touch unrelated processes, or claim unrun checks passed.
- Delivery strategy: ask-on-risk; chain strategy: feature-branch-chain, explicitly selected by the user's answer `1` on 2026-10-22. Keep integration on feat/windows-native-independent. Push to that feature branch and CI inspection are already authorized; PR creation, additional remote branches, and merges are not.
- TDD mode is unresolved and its source unconfirmed. Test/framework presence does not enable TDD; resolve the mode before the next source implementation, and do not invoke sdd-init to determine it.

## Work units

The broader acceptance tasks remain open; W1 is committed with bounded discovery proof, while full platform acceptance remains pending. Routes record the execution path and trigger evidence.

| ID | Outcome / route | Progress and acceptance evidence | Status |
|---|---|---|---|
| T1 | Restore the independent patch on the official branch. Inline — mechanical parent clone/apply state. | Patch restoration and source state were observed; commit is pending. Accept when the intended patch is present on the stated branch and its work-unit commit is recorded. | [ ] |
| T2 | Implement Windows lifecycle and security behavior. Delegated — multiple non-trivial files; lifecycle, Credential Manager, Job Object, and lock behavior need coordinated implementation. | Source implementation exists but is not natively linked. Credential Manager and Job Object tests remain pending. The P1 stop-lock correction was independently structurally verified, not executed in Rust. Accept after native linkage, lifecycle/security tests, and commit. | [ ] |
| T3 | Make staging/checksum scripts portable and fail safely. Delegated — multiple non-trivial script/test files. | 15 Node contracts passed. Actual PowerShell 5.1 and pwsh SHA checksum-valid/tampered production-function tests passed; PowerShell parsing passed. Accept after applicable tests, review of failure handling, and commit. | [ ] |
| T4 | Port tests and preserve privacy controls. Delegated — multi-file test portability and security evidence. | tsc passes. Earlier full Vitest: 78 failures, 470 passes, 19 existing skips, and 28 worker errors. Latest focused run: 11 failures, 53 passes, 1 existing skip; Unix socket EACCES took 517.48s. No broad skips were added. Native CLI chmod does not prove DACL privacy; DACL proof remains missing. Fail-closed unsupported identity behavior is preserved. | [ ] |
| T5 | Complete native build and installer path. Delegated — multi-file native/build work and external execution. | MSVC link.exe unavailable; vswhere found none. Metadata API was checked only. Packaging replaced Get-FileHash and Expand-Archive with .NET SHA256 streams and ZipFile; verified Node download/extraction and daemon bundling were reached, then runtime installation stalled. The 16.8-minute install was cancelled after re-verifying and stopping only owned PIDs 28924 and 3128. No installer exists. | [ ] |
| T6 | Implement native desktop control and emergency stop. Delegated — multi-file native UI/input work; must preserve stop/cleanup guarantees. | Native screen, input, UI Automation, and panic backends are not implemented. Accept only with real native behavior and bounded cleanup tests; do not count mocks or metadata checks as native acceptance. | [ ] |
| T7 | Implement native voice support. Delegated — separate multi-file platform behavior. | Not implemented. Accept with Windows voice path, failure/permission handling, applicable tests, and commit. | [ ] |
| T8 | Complete clean-install acceptance and publication CI. Delegated — end-to-end installer/CI execution across multiple files. | No installed acceptance or CI run. Accept with observed installation checks, CI evidence, and commit. Push to feat/windows-native-independent and CI inspection are authorized; clean-machine claims require separate actual evidence. | [ ] |

## Checks and evidence

Observed successful checks: parent and independent verifier's 15 Node tests (0 skipped, 15–20 seconds); production checksum functions on both PowerShell 5.1 and pwsh for valid and tampered inputs; PowerShell script parsing; TypeScript build (node node_modules/typescript/bin/tsc -b); whitespace check. Generated build/windows files are ignored; no secrets are recorded here.

Known exact runners (applicability/mode still unresolved):

- node --test scripts/windows/test/*.test.mjs
- node node_modules/typescript/bin/tsc -b
- node node_modules/vitest/vitest.mjs run --maxWorkers=2
- cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml

The latest and earlier Vitest failures above remain unresolved; do not convert them into skips. Native Rust tests, build/link, installer, Windows DACL/privacy verification, desktop control, voice, install acceptance, and CI remain pending or unavailable as stated.

## Delivery and next step

### Resume verification (2026-10-22)

Re-read START_HERE.md and the supplied LOCAL_AGENT_HANDOFF.md; reconciled this document with its full Engram mirror before continuing. The user authorized publication of the official feature branch; W1 passed native review and exact acknowledgement, then commit `9a5c0b4e7c1aac6d82e7b46630268520e65f89e` was pushed. `gh run list` returned no CI runs; the Windows workflow remains staged for W5. No PR, merge, or release occurred.

Bounded independent checks passed: 15 Node contracts with zero skips; TypeScript build; six syntax parses (three scripts on Windows PowerShell 5.1 and pwsh); whitespace check; and 18 Vitest tests across runtime.test.ts and app-channel.test.ts with maxWorkers=2 and zero skips. The parent spot-check reran all 15 Node contracts successfully. This is not a full-suite pass and does not resolve the earlier 11 focused failures or native build/installer/capability blockers.

Verification caveat: an incorrectly quoted first syntax-check command inadvertently invoked the scripts. Staging refused the existing generated directory; no installer was produced. Correct EncodedCommand/ParseFile checks then passed. Working-tree versus index comparison showed no tracked source changes; generated icon output remains build-only. Logs are under ignored build/windows/resume-*. TDD configuration/source remains unconfirmed.

Forecast remains above 1,913 authored lines; committed W1 count is 321 including its recovery documentation. Chain strategy is feature-branch-chain, confirmed with answer `1`. Resolve TDD mode/source before further source implementation. Continue coherent work-unit commits with tests/docs and native per-commit assessment. Publish only the authorized feature branch and inspect its CI; do not infer PR, merge, or release authorization.

### Work-unit organization

The user explicitly selected `feature-branch-chain` with answer `1`; no pull request has been created. Planned slices are provisional and remain on `feat/windows-native-independent` until the user separately authorizes PR work. Keep each behavior with its tests and documentation; record actual proof and commit identity only after observed.

1. **W1 — Windows Engram discovery**: `packages/daemon/src/windows-runtime.ts`, `packages/daemon/src/runtime.ts`, `packages/daemon/src/isolation.ts`, `packages/daemon/test/runtime.test.ts`, `packages/daemon/test/isolation.test.ts`, `scripts/windows/test/runtime.test.mjs`, and `docs/windows-runtime-discovery.md`. Discovery documentation and focused checks are prepared; this task remains open pending the parent-owned commit and required review/recording. The focused runtime Node suite passed 9/9; focused Vitest runtime suite passed 9/9; TypeScript build and `git diff --check` passed. Isolation tests were not run because earlier logs show known mode 0700/0600 failures; they remain unverified here.
2. **W2 — Private process channel, platform/home, and build integration**: keep the coupled cross-platform lifecycle behavior intact; forecast exceeds 400 authored changed lines, so do not split artificially. Revisit PR sizing under ordinary repository policy before publication.
3. **W3 — Windows credential store**.
4. **W4 — Packaging and runtime integrity**.
5. **W5a — Current integration evidence and handoff docs**, then **W5b — Windows CI workflow and integration evidence**. These are distinct documentation and executable workflow behaviors; native assessment decides applicability. This split is not a size workaround.

W1 commit: `9a5c0b4` (`feat(daemon): discover Windows runtime executables safely`), 294 additions and 27 deletions. Focused Node resolver tests passed 9/9, Vitest runtime tests passed 9/9, typecheck passed, and parent Node spot-check passed 9/9. Existing isolation/privacy failures remain outside that bounded proof. Commit identity was supplied per-command from the authenticated GitHub account's public name and private ID-based noreply address, without global configuration changes. The first commit attempt failed before writing a commit because author identity was unset; the per-command identity resolved that failure.

Native committed-only assessment from base `8cb20ee888c88be2b359258a65499c20b59e2a86` reported high risk, `review_due=true`, reason `high_risk` / `process_boundary` on isolation.ts. The human granted this candidate with answer `1`. All four provider-issued reviewer captures ran concurrently, without source mutation, and the final admitted capture approved the candidate. Its one advisory (`R2-misleading-precedence-comment`, windows-runtime.ts:35) is non-blocking future work; it did not open correction or reopen this review. The exact returned acknowledgement completed with `gentle-ai.review-acknowledged/v1`, action `acknowledged`, authority `burned`, lineage `review-6279c98b9cf8fa10`, target `sha256:01db4a4f9dfee523319f09b0f4f40e27f6baa45c16166c6be1efb28290301343`. Next reviewed boundary: W1 commit `9a5c0b4`. No further lifecycle operation is required for that target. The exact W1 commit was pushed to the authorized official feature branch; `gh run list` returned no runs. No PR is authorized or created. Other work-unit identities and full acceptance remain pending.

#### W2 preparation (2026-10-22)

W2 documentation is in `docs/windows-daemon-lifecycle.md`. Focused Node Windows channel harness passed 1/1, Vitest app-channel suite passed 9/9, TypeScript build passed, and `git diff --check` passed. The parent reran the Node channel harness successfully. The harness confirms anonymous-pipe protocol/EOF and selector non-inheritance only; Rust Job assignment, descendant cleanup, and actual Windows ACL behavior remain unverified. The prior Cargo attempt was blocked by missing MSVC `link.exe`; metadata checks do not establish compilation. W2 commit `ea1ade4f97209e98714e43b09e46ded435d25329` contains 689 additions and 88 deletions across 16 files. The coupled lifecycle unit remains intact; no PR is being created, and future PR sizing needs its own repository-policy decision. Credential Manager remains W3.

W2 committed-only native assessment against W1 was high risk (`process_boundary` in daemon.rs). The human separately granted W2 with answer `1`. All four provider-issued captures ran concurrently; final capture approved the candidate without correction and offered three non-blocking advisories: misleading prior-child documentation, platform-neutral log documentation, and the already-disclosed unverified Windows Rust execution. The exact acknowledgement returned `gentle-ai.review-acknowledged/v1`, action `acknowledged`, authority `burned`, lineage `review-8bc62474ca5b0e3b`, target `sha256:09ce41bdb77afa62c3ce49de138bb2f5a87f4fdc1c141b292ce063b8fe5a9ab9`. The ordinary authorized push then updated the remote feature branch to W2; `gh run list` still returned no runs. Do not reopen this target or treat advisory findings as an offered correction. Native Rust build/tests, Job/ACL execution, and installed acceptance remain unverified.

#### W3 preparation (2026-10-22)

W3 documentation is prepared in `docs/windows-credential-store.md`. Read-only inspection confirms `#[cfg(windows)]` selects `CredentialStore`, not `MemoryStore`; the W2 Cargo dependency already enables `Win32_Security_Credentials`. `rustfmt --check --config max_width=120,use_small_heuristics=Max,skip_children=true apps/desktop/src-tauri/src/secure_store/windows.rs apps/desktop/src-tauri/src/secure_store/mod.rs` passed; `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -p windows-sys@0.61.2` passed for that dependency crate only; `git diff --check` passed. The actual Credential Manager round-trip test was not run because MSVC `link.exe` is unavailable. No credential-store operation was performed, and no commit identity/checkmark is recorded. W3 remains pending parent commit/review and native runtime evidence.

#### W3 commit and assessment (2026-10-22)

W3 `70cabf981d494525a4a63789c82ee44ffd67afb7` (`feat(security): store Windows credentials in Credential Manager`) contains four files, 178 additions and seven deletions. Targeted rustfmt, dependency-only windows-sys metadata check, and whitespace checks passed; the parent repeated the metadata check. No native Credential Manager round-trip or application compilation was executed. Full acceptance stays open. Native committed-only assessment against reviewed W2 returned medium risk, 185 lines, `review_due=false`, `review_due_reason=under_budget`. This pending medium slice retains W2 as its reviewed boundary; no consent or approval is fabricated. The ordinary authorized push updated the remote branch to W3; gh still reports no CI runs.

#### W4 preparation (2026-10-22)

W4 documentation is prepared in `docs/windows-packaging-validation.md`. The Windows contract glob passed 15/15 with zero skips; explicit integrity/staging tests passed 5/5; `ParseFile` syntax checks passed for all three PowerShell scripts under Windows PowerShell 5.1 and pwsh; `git diff --check` passed. Fixture checks do not validate a produced installer. No package, staging, download, install, or smoke-install script was run, and no installer was created. The earlier staging attempt reached runtime `npm install`, stalled about 16.8 minutes, and was cancelled after verifying and stopping only owned processes; runtime dependency locking/reproducibility remains unresolved. W4 is only prepared and remains open pending parent commit/review. W5 owns the CI workflow and broader integration evidence. No commit identity or completion checkbox is added.

#### W4 commit and accumulated slice (2026-10-22)

W4 `45213ba240c6c6e3cc40a2a82b149910c0b76961` (`feat(build): stage and verify Windows runtime packages`) contains ten files, 344 additions and two deletions. All 15 Node contracts and five focused integrity/stage tests passed with zero skips; both PowerShell hosts parsed all three scripts. The parent reran the five W4 contracts successfully. No packaging/install command was executed for this work unit; the known runtime npm stall, missing runtime lock, native build, installer, and acceptance gaps remain. Native assessment against W2 covered W3+W4: medium risk, 529 lines, `review_due=true`, `slice_budget_reached`. The human separately granted that consolidated candidate with answer `1`. Its one provider-issued capture approved without correction; advisory findings about non-deterministic runtime dependencies and smoke failure cleanup are non-blocking separate follow-ups, not an offered correction. Exact acknowledgement completed with authority `burned`, lineage `review-cdd53f40561350b4`, target `sha256:ef23ef66d9b8893e98dab2c617960656e1b1cc11d9bd24e19a2f892892f277f3`. The ordinary authorized push updated remote HEAD to W4; gh still lists no CI runs. Do not reopen this consumed target. W3 under-budget status was not itself approval, and the later native approval does not establish unexecuted platform behavior.

#### W5a preparation — current integration evidence and handoff docs (2026-10-22)

Prepared documentation-only updates in `docs/windows-native-independent.md` and `LOCAL_AGENT_HANDOFF.md`. The main guide now leads with the current W1–W4 publication/review checkpoint, bounded verification results, native Rust/installer/CI and capability gaps, and the W5a/W5b boundary; older snapshots are labeled historical. The supplied Spanish handoff body is preserved with a brief English banner linking to the current guide and tracker. Readback and `git diff --check` passed. No code, tests, workflow, commit, or completion checkbox changed. W5b remains pending; no CI run currently exists. No PR, merge, or release is authorized.

#### W5a commit and review (2026-10-22)

W5a commit `3a5826333672deadccf7a758ef3137c81389033d` (`docs(windows): preserve handoff and native validation evidence`) received a separate human grant, native approval, and exact acknowledgement; authority is burned. Push is in flight under parent ownership and is not claimed complete here. This documentation review is not functional Windows proof.

#### W5b preparation (2026-10-22)

Prepared `docs/windows-ci-validation.md` for the staged workflow and engine-access fixture unit. `node --test scripts/windows/test/*.test.mjs` passed 15/15 with zero skips; `node node_modules/typescript/bin/tsc -b` passed; PyYAML parsed the workflow and confirmed read-only contents permission, installer prerequisites on TypeScript/Rust, no release trigger, and no `continue-on-error`. The focused `node node_modules/vitest/vitest.mjs run packages/daemon/test/engine-access.test.ts --maxWorkers=2` was partial: 7 passed, 1 failed because Windows `stat.mode & 0o777` returned 0666 instead of the POSIX 0600 expectation. No skip or code change was made. No CI workflow execution, Rust application build/test, installer, or clean-install acceptance is available. W5b remains prepared, without a commit ID or task completion mark; broad acceptance remains open.

#### W5a/W5b current checkpoint (2026-10-22)

W5a `3a5826333672deadccf7a758ef3137c81389033d` is pushed and received native approval plus exact acknowledgement. W5b `247e176c152a8c50e72442751a0c209e60b3b416` is pushed; Windows CI run `39792526724` failed with 52 failed tests across 22 files, 744 passed, and 18 skipped. The Windows Rust suite reported 360 passed and 2 ignored. Installer execution was skipped and produced no artifacts. The user explicitly abandoned W5b's native review; that target is not approved, and the review-mode switch was not disabled. These outcomes do not close broad Windows acceptance.

The user explicitly confirmed strict TDD (`si confirmo`) on 2026-10-22. Source: user choice. Exact runner: `node node_modules/vitest/vitest.mjs run packages/daemon/test/config.test.ts packages/daemon/test/runtime-build.test.ts --maxWorkers=2`.

#### W6 — Windows-native absolute-path fixtures (delegated)

Route: delegated direct; reading that prepares a write and two non-trivial test files. First observed the unchanged focused Vitest runner fail 6 tests: four config assertions used Unix-root paths or slash-only separators, the runtime self-check supplied `/x/engram` instead of an existing readable absolute Windows `.exe`, and the runtime wrapper asserted Unix execute bits on Windows. Production validation requires the explicit override to be absolute, `.exe`-suffixed, and a readable existing file. Replaced only the non-native fixture paths and separator assumptions, using native `node:path` helpers and a readable temporary `.exe` fixture. The config suite now passes 6/6 and the runtime self-check succeeds; the exact combined runner remains partial at 10 passed, 1 failed because the wrapper test asserts POSIX execute bits (`0o111`) on Windows. Left that assertion unchanged rather than weakening Unix proof or inventing Windows chmod evidence. No production code, security assertions, or permissions changed. `node node_modules/typescript/bin/tsc -b` passed; `node --test scripts/windows/test/*.test.mjs` passed 15/15 with zero skips; `git diff --check` passed (Git reports the task document will be CRLF-normalized on a future touch). W6 remains partial; broad Windows acceptance remains open, and future root units for DACL, transport, denial, and server identity remain deferred.
