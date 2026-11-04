# Resume Windows and Spanish reconciliation

Continue on `feat/windows-spanish-integration` in `Gentleman-Programming/gentle-dot`. The first batch is implemented and committed; **blocks 4–13 are not complete**. The owner explicitly paused development to continue on another PC.

## Quick path

1. Fetch the authorized repository and check out this branch without resetting any existing work:
   ```bash
   git fetch origin
   git switch --track origin/feat/windows-spanish-integration
   ```
   If the local branch already exists, use `git switch feat/windows-spanish-integration` and inspect its state before updating it.
2. Read [the canonical specification, task list and decision log](tasks/windows-spanish-upstream-reconciliation.md), including `## Log`.
3. Confirm the unresolved decisions below before implementing the next unit. Do not restart completed work or silently broaden permissions.

The implementation base is `65bac1710690a46365d1429ccfcc46bf694751d9`, the selected maintainer feature base, not current main. Do not automatically import main, PR #188, or the old contribution branch.

## Held implementation commits

| Commit | Scope | Authored lines |
|---|---|---:|
| `cde0a12eb5c21dc6bd31164ebdbcdf386a1d4c50` | Incoming UTF-8 frame byte bounds, public-interface tests and documentation | 214 |
| `9944a2dea8ddee9e08d462d54465685d569e54db` | Allowlisted child environments and retained Windows fixtures | 126 |
| `e2e2dae9b59147163bd00e7b036bc12a5fe9973c` | Packaging flags, read-only preflight, mandatory payload checks, NSIS/MSI selection, tests and documentation | 508 |

Keep `chain_strategy=feature-branch-chain`. The 508-line unit was retained as the best cohesive code/test/doc slice after one honest slicing pass. No size exception, PR, merge or further publication is implied.

## Verified scope, not release acceptance

Independent checks ran in a physically copied dependency environment:

| Gate | Observed result |
|---|---|
| Complete app-channel test file | 16 passed, no skips |
| Full Windows contract suite | 42 passed, 1 skipped, 0 failed |
| Full strict TypeScript build | Exit 0, empty stdout/stderr |
| Public boundary/preservation probes | Passed |
| Original checkout preservation | 31 WIP files, HEAD, raw index, bytes and metadata preserved |

The skipped check was `pwsh.exe unavailable; PowerShell 7 not verified`. The owner accepted only the verified Windows PowerShell 5.1 offline-fixture subset and explicitly deferred PowerShell 7. Selecting NSIS/MSI in a fixture is **not** proof that installers were generated.

No actual installed-runtime, other-OS, CI, Windows voice, physical computer-control or packaged-app acceptance is claimed. No native review approval is claimed. Earlier unavailable verification, inventory timeout and probe-harness failure remain historical failures; later passes did not relabel them.

Relevant implementation docs:
- [Channel framing](../docs/windows-channel-framing.md)
- [Packaging validation](../docs/windows-packaging-validation.md)
- [Windows runtime discovery](../docs/windows-runtime-discovery.md)
- [Windows daemon lifecycle](../docs/windows-daemon-lifecycle.md)

## Next decisions and remaining work

| Area | Current state and next action |
|---|---|
| Runtime/startup/paths, block 5 | Existing discovery, absolute PATH handling, private directories and profile locking already exist. A possible Windows-native home-variable gap needs a synthetic RED test before any claimed fix. Do not rewrite working discovery by default. |
| Packaging, rest of block 6 | Bundled Git acquisition/inclusion/discovery is explicitly deferred pending a real producer/provenance contract. Actual installers and installed-runtime checks remain open. |
| Credentials, block 7 | Reject values above 2560 UTF-8 bytes before writing; preserve originals/current data. Establish the legacy encrypted format/source first. No truncation, overwrite, resurrection or silent partial migration. |
| Private memory, block 8 | Existing environment-selected app-local Engram backend, global default. Persisted app config/UI preference is absent. Confirm privacy scope, default/override precedence and application-on-restart behavior; do not invent per-chat/per-project isolation or migrate data. Windows lifecycle is not proven. |
| Diagnostics, block 9 | Still pending. Found, configured and actually working must be distinct states. |
| Spanish UI, block 10 | Still pending. Translate app-owned strings, not arbitrary backend replies. |
| Native computer control, block 11 | Still pending on this selected base. Preserve consent, sessions, effective Stop and stdio/Job ownership. |
| Windows voice, block 12 | Still pending, including audio/devices/recording/dictation/Parakeet/playback and preferences. |
| Cross-cutting validation, block 13 | Only the first-batch gates above are accepted. Broader native/build/install/CI/platform proof remains open. |

The last proposed next-unit decisions were **not answered**: persistent private-memory semantics and extending the temporary test-root purpose beyond the initial blocks 4/6. Resolve them with the owner instead of treating a proposal as permission.

## Environment and evidence portability

- Read `.nvmrc`, workspace manifests and `pnpm-lock.yaml` before preparing this PC. Prior matching dependency reuse was test-tool reuse, **not a frozen production installation**.
- Windows source-mode tests need the checked-in Go private-storage helper preparation. This machine reused a verified existing helper; its executable is not committed. Prepare from source only with the new environment's authorization. This is separate from the exhausted provider compilation allowance.
- Prior test tools included SDK 1.0.4, Vitest 5.0.3 and TypeScript 7.0.2. Do not substitute versions silently.
- Raw receipts and copied dependencies remain on the previous PC under `C:/Users/maicolj/AppData/Local/Temp/gentle-dot-windows-es-verify` and the earlier factory root. They are **not in Git** and may be unavailable here. The recorded results above are historical evidence, not proof that this PC has run the checks.
- The former 4-GiB root grant and other absolute-path permissions were session/target scoped. They do not authorize directories, profiles, hardware or actions on this PC.
- Do not read actual credential stores/profiles, record audio, capture/control the desktop, start real providers, download components, install globally or rebuild providers without the required fresh explicit scope.
- Preserve inputs, fixtures, failures and artifacts. Never persist full `process.env`; use explicit child-environment allowlists and isolated HOME/APPDATA/TEMP/cache directories.
- All old native review lineages are consumed. Never query, reuse or recover them as approval for this branch. No active approval is transferred by this guide.

## What is intentionally absent

The original checkout's 31 unrelated uncommitted files, generated TOMLs, caches, binaries, SDK copies, secret/profile data and private other-feature notes were not included. Earlier unreconciled local work at original-branch commit `92379a0eb61e9fae6184097feba7260fdb165621` was not imported or published by this single-branch handoff.

The owner chose this handoff instead of sending a Discord update. No message or delivery-time commitment was sent to Pablo. Continue from the versioned tasks, not an assumed completed Windows/Spanish release.
