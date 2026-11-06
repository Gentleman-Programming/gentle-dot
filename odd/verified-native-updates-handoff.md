# Resume verified native installation and ARM64 work

**Branch:** `feat/verified-native-updates`. Implementation is paused at the user's request. This is an **incomplete, unapproved checkpoint**, not a working or verified ARM64 installer.

Native-readiness source checkpoint: `cf8bfe0992ccaf5b2702597114fc8da25f90b9aa`. Its 10 application/test/help files were committed with their working-tree bytes unchanged. The canonical requirements and evidence are in [the task document](tasks/verified-native-updates.md), now including S22–S25.

## Quick path at home

1. Obtain this branch's latest checkpoint. Remote availability requires a successful, explicitly authorized push; creating this document alone does not prove publication.
2. In a **clean checkout**, use `git fetch origin`, `git switch feat/verified-native-updates`, then `git pull --ff-only`. Do not reset, clean, overwrite local changes, or mix another feature's worktree.
3. Start the coding session in that checkout. Read this file and the canonical task document before writing or running checks.
4. Resume **T12's compatibility/API evidence map first**, then its bounded implementation. Do not assume automatic detection or Windows ARM64 already exists.

Suggested continuation prompt:

> Read odd/verified-native-updates-handoff.md and odd/tasks/verified-native-updates.md. Resume T12: native automatic OS/architecture detection and Windows/Linux ARM64 support. Preserve the unapproved T11 checkpoint and distinguish source/fixture proof from native execution. First verify the exact dependency/installer/CI matrix and native APIs. Keep the separate Windows/Spanish batch paused. Do not install Dot, provision or generate private keys, publish, or replay unavailable verification automatically.

## What is actually saved

| Area | State at this checkpoint |
| --- | --- |
| T1 release authentication primitive | Scoped verification completed; no production trust anchor or installed-flow proof. |
| T2 secure loopback session | Implemented and checked locally; installation remains disabled. |
| T7 host-owned download primitive | Implemented; fake-transport proof only, not actual HTTPS/native installation. |
| T8 browser installer shell | Implemented; Node checks and actual responsive/keyboard/CSP/cancellation browser acceptance completed. |
| T9 Gentle Design | Three concepts plus the clearer OS-card refinement are saved. Reopened for S24: the normal flow must be automatic, not a manual OS choice. |
| T10 signing preparation | Unsigned manifest-input preparation implemented and checked. No private keys, signing or updater activation. |
| T11 real readiness UI | Source, tests and help committed as **unapproved**. Standalone Rust fixture tests and mocked UI passed; full Tauri compilation and real IPC were **not run**. |
| T12 ARM64 and automatic detection | Requirements and initial read-only investigation only. **No ARM64 implementation or new ARM64 tests were written.** |
| T3 / T4 | Safe shutdown/replacement, production trust integration, native CI and installed full-flow proof remain unfinished. |

Earlier local work-unit commits: T2 `c1db992`, T7 `ec8ce49`, original design `090d0f0`, T8 `1c8dbe5`, T10 `522adda`, OS-card refinement `7afacbe`. Original published checkpoints were `a304692` / `642a5f3`; do not infer that later commits were published from that history.

## Non-negotiable automatic detection behavior

- Detect the installation host's OS and native architecture automatically; do not ask the user to choose the normal installation target.
- Do not use browser `navigator` or compiled process architecture as proof of the native CPU architecture.
- **Windows ARM64 may run an x64 process under emulation.** Report native and process architecture separately and select a genuinely supported native target.
- Keep installer target selection separate from build/staging admission: a builder running x64 Node must not stage ARM64 npm/native binaries merely because the physical machine is ARM64.
- Unknown or unsupported detection must be visible and block installation, not default silently to x64.
- Existing OS-card interactions are explicitly design previews, not real host detection. Do not relabel simulated results as real.

## Current target support: source is not native proof

| Target | Current source |
| --- | --- |
| Windows x64 | Existing native staging and NSIS packaging. |
| Windows ARM64 | Not an implemented native runtime/package target. Full dependency/build/installer/CI support still needs verification. |
| Linux ARM64 | Declared in runtime and Debian/Ubuntu `.deb` packaging; native installed behavior is not established by this checkpoint. |
| Arch Linux ARM64 | Not packaged by the current Arch matrix; Arch is AMD64-only. |
| macOS | Existing ARM64 package path; native integration/update proof remains separate. |

Relevant producers: `scripts/package/lib.mjs`, `scripts/package/windows-lib.mjs`, `scripts/package/linux-lib.mjs`, `scripts/package/stage-runtime.mjs`. Node is pinned to `24.14.1`. Verify exact Node, Engram, daemon/native stop addon, Sherpa and installer inputs before adding a target; do not invent asset names/URLs or substitute x64 emulation for native support.

Research leads, **not validated release-asset evidence**:

- [Microsoft IsWow64Process2](https://learn.microsoft.com/en-us/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process2): native-machine versus process-machine architecture.
- [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/): verify ARM64 app/NSIS bootstrapper behavior and prerequisites.
- [Engram releases](https://github.com/Gentleman-Programming/engram/releases): inspect actual assets for the selected version; a search summary claiming an ARM64 asset is insufficient.

## T11: what must not be mistaken for acceptance

The committed command has no client-selected paths or arguments. It inspects the app-owned bundled runtime and reports `processOs`, `compiledArch`, `runtimeTarget`, and file statuses `present` / `missing` / `unknown`. **Compiled architecture is not native CPU detection. Manifest presence is not authentication.** The command has a dedicated panel-only permission; preserve unrelated dot/glow grants.

Observed writer results: standalone STD Rust **3/3**, mocked UI **7/7**, TypeScript **exit 0**. One original UI harness failure and its single correction are retained. These do not prove Tauri compilation, IPC permission execution, real prerequisites, ARM64, or an installed application.

The blocked native gate needs an explicitly identified **credential-free public offline Cargo cache**, a local compatible **Sherpa static library/archive**, and a bounded native-output disk budget (or matching-candidate native proof from a prepared environment). Do not read Cargo credentials, inherit private profiles, silently download dependencies, or repeat failed preparations. No independent security/native acceptance or parent native acceptance has been claimed.

## Remaining work, in order

1. **T12:** finish the compatibility/API map; choose narrow edit surfaces and reviewable behavior slices. Preserve existing native-readiness source and evidence. Implement actual automatic detection with meaningful public-interface tests and regression coverage.
2. **T9 / T11:** connect the authoritative host result to the real UI and align the artboard's normal flow. Unknown results must remain unknown. Resolve the native gate before claiming integration acceptance.
3. **T3:** obtain an independently confirmed maintainer **public** trust root and actual signed releases through a separate authorized procedure. T10 did not create them. Implement confirmed orderly exit, application-only replacement, recovery/reopen and preservation of user data.
4. **T4:** add and execute matching native platform/architecture CI and full-flow negative checks. Unrun CI and cross-compilation are not native ARM64 execution proof.

## Boundaries and portable evidence

- No actual Dot installation, elevation, OS-security bypass, private-key generation/read/configuration, release, PR, merge, force push or publication is authorized by the implementation scope. A branch push requires its own explicit decision.
- Never read/copy/commit `.env`, `.ssh`, keychains, credentials, `secrets/`, or private key material. Do not rerun old signature fixtures that generate private keys.
- Preserve conversations, settings, memory, credentials and Engram data outside binary replacement. No file/cache/fixture cleanup or deletion.
- Missing publisher trust keeps install/update activation fail-closed. Free project signatures do not imply Apple notarization, malware guarantees or Gatekeeper approval.
- Separate Windows/Spanish work remains explicitly paused. Other worktrees and the primary checkout's unrelated WIP are outside this checkpoint.
- Raw verification logs, failed attempts, caches and fixtures remain on the development PC, mostly outside Git. Their essential outcomes/limits are recorded here and in the canonical log; do not pretend local temporary paths are available at home.
- Source-preservation receipts for this checkpoint are local-only under ignored `build/checkpoint-home-fF2zOs/`. A first checkpoint wrapper failed JavaScript parsing before any actions; the corrected file-based wrapper committed successfully and verified all 10 source byte hashes unchanged. No functional test/build was rerun for the checkpoint.

## Design and implementation references

- [Installer behavior and current limitations](../docs/installer.md)
- [Unsigned preparation and release verification](../docs/release-verification.md)
- [Chosen guided artboard](../design/native-installer/01-guided.html)
- Alternatives remain under `design/native-installer/`. Open them with Gentle Design from this branch's checkout; the old development PC's canvas address/helper is not portable.
- `design/native-installer/handoffs.json` records the chosen artboard as sent, not implemented (`queued: false`, no started/implemented timestamp). Do not mark it implemented without real application acceptance.
