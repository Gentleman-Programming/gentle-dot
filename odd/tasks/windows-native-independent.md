# Windows Native Independent Port — Recovery Tasks

This document recovers task tracking for the authorized Windows port of the official Gentleman-Programming/gentle-dot repository on feat/windows-native-independent, based on 8cb20ee888c88be2b359258a65499c20b59e2a86. It was created after implementation had already begun under prior instructions; it is not represented as a pre-write plan. The goal is a native Windows implementation that preserves the existing security, privacy, confirmation, and bounded process-cleanup guarantees.

## Scope and operating constraints

- Source: official Gentleman-Programming/gentle-dot; branch: feat/windows-native-independent. Do not use PR #57, modify main, or publish releases.
- The parent cloned and applied ../independent-windows.patch. Invalid ambient GITHUB_TOKEN was excluded process-only; the Maicololiveras keyring gh authentication is valid for MAINTAIN.
- No commits, pushes, PRs, or merges have occurred. The user explicitly authorized publishing changes to feat/windows-native-independent and checking CI; no PR, merge, or release is authorized. All 34 source/docs/scripts files are staged; the stated changed-line count is 1,914 lines (1,913 excluding generated Cargo.lock; no binary count). This document is recovery tracking, not additional delivery authorization.
- Review mode is on by default (read-only confirmed). The preflight returned managed_assets_outdated; the exact gentle-ai sync --agent codex completed for 70 global managed files. No review START, lineage, consent, or receipt exists.
- First future review boundary is the base SHA above. Review only a future work-unit commit or PR slice, never the accumulated branch.
- Preserve existing grants, confirmations, privacy boundaries, and bounded owned-process cleanup. Do not apply global ACLs, touch unrelated processes, or claim unrun checks passed.
- Delivery strategy: ask-on-risk; chain strategy: feature-branch-chain, explicitly selected by the user's answer `1` on 2026-10-22. Keep integration on feat/windows-native-independent. Push to that feature branch and CI inspection are already authorized; PR creation, additional remote branches, and merges are not.
- TDD mode is unresolved and its source unconfirmed. Test/framework presence does not enable TDD; resolve the mode before the next source implementation, and do not invoke sdd-init to determine it.

## Work units

All tasks remain open: no work-unit commit exists, so no task meets the completion rule (observed outcome, applicable checks, and commit identity). Routes record the planned execution path and trigger evidence.

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

Re-read START_HERE.md and the supplied LOCAL_AGENT_HANDOFF.md; reconciled this document with its full Engram mirror before continuing. gh keyring authentication and MAINTAIN repository access were reverified. The remote feature branch is still absent and gh reported no CI runs for it. No source edits, commits, push, PR, merge, or review START occurred during these checks.

Bounded independent checks passed: 15 Node contracts with zero skips; TypeScript build; six syntax parses (three scripts on Windows PowerShell 5.1 and pwsh); whitespace check; and 18 Vitest tests across runtime.test.ts and app-channel.test.ts with maxWorkers=2 and zero skips. The parent spot-check reran all 15 Node contracts successfully. This is not a full-suite pass and does not resolve the earlier 11 focused failures or native build/installer/capability blockers.

Verification caveat: an incorrectly quoted first syntax-check command inadvertently invoked the scripts. Staging refused the existing generated directory; no installer was produced. Correct EncodedCommand/ParseFile checks then passed. Working-tree versus index comparison showed no tracked source changes; generated icon output remains build-only. Logs are under ignored build/windows/resume-*. TDD configuration/source remains unconfirmed.

Forecast is at least 1,913 authored lines before this recovery document; committed authored count is zero. Chain strategy is now feature-branch-chain, explicitly confirmed with answer `1`; the previous delivery-choice blocker is resolved. Resolve TDD mode/source before further source implementation. Organize the existing normalized changes into coherent work-unit commits, keep their tests/docs, record commit identities and actual checks here, and assess/review eligible committed boundaries under the user-owned native review contract. Publish only the authorized feature branch and inspect its CI; do not infer PR, merge, or release authorization.

### Work-unit organization

The user explicitly selected `feature-branch-chain` with answer `1`; no pull request has been created. Planned slices are provisional and remain on `feat/windows-native-independent` until the user separately authorizes PR work. Keep each behavior with its tests and documentation; record actual proof and commit identity only after observed.

1. **W1 — Windows Engram discovery**: `packages/daemon/src/windows-runtime.ts`, `packages/daemon/src/runtime.ts`, `packages/daemon/src/isolation.ts`, `packages/daemon/test/runtime.test.ts`, `packages/daemon/test/isolation.test.ts`, `scripts/windows/test/runtime.test.mjs`, and `docs/windows-runtime-discovery.md`. Discovery documentation and focused checks are prepared; this task remains open pending the parent-owned commit and required review/recording. The focused runtime Node suite passed 9/9; focused Vitest runtime suite passed 9/9; TypeScript build and `git diff --check` passed. Isolation tests were not run because earlier logs show known mode 0700/0600 failures; they remain unverified here.
2. **W2 — Private process channel, platform/home, and build integration**: keep the coupled cross-platform lifecycle behavior intact; forecast exceeds 400 authored changed lines, so do not split artificially. Revisit PR sizing under ordinary repository policy before publication.
3. **W3 — Windows credential store**.
4. **W4 — Packaging and runtime integrity**.
5. **W5 — Windows CI and integration evidence**.

No commit identities or task checkmarks are recorded by this preparation; all slices are provisional until each work unit's outcomes and checks are observed.

