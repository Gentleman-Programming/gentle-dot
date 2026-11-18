# Gentle Shell 4.8: resume the Windows qualification

**Source compatibility is verified. The real launcher and packaged Windows runtime are not.** Resume at [ODD task T6](../odd/tasks/gentle-shell-4-8.md#tasks), starting with recovery of the Pi executor rather than rerunning the source tests.

## Checkpoint

- Work on `feat/gentle-shell-4-8`. Its base is `7decec6`, the isolated Mars/Windows CI candidate the user previously validated, not a Shell 4.8 installer.
- `e2a0866`: pins Gentle Shell (`gentle-pi`) 4.8.0, keeps SDK 1.5.0 and its sibling pins, and denies inherited opt-in to the interactive host only for Dot's bundled default engine. Explicit custom launch settings retain their environment. Existing setup and provisioning guards stay in place.
- `b803275`: characterizes the real NaN provider factory and SDK extension-loader integration with a synthetic transport. See [the compatibility note](gentle-shell-compatibility.md) for contract details.

## Evidence already collected

| Check | Result and boundary |
| --- | --- |
| Independent source snapshot | 4 dependency/launch contracts, 17 selected daemon cases and daemon TypeScript passed. The parent verified 75 source inputs without drift. |
| NaN and auth follow-up | 4 streaming cases and 6 auth cases passed with the typecheck; 11 earlier selected cases passed separately. The parent verified 76 inputs without drift. This is not a single full-suite run or a new independent verdict. |
| Latest local source recheck | 4/4 passed with an isolated home. It did not launch Shell. |
| Windows runtime | Actual launcher RPC, pinned native helper acquisition, staging/smoke, frozen pnpm install and installed Shell 4.8 acceptance have not been demonstrated. |

If the original worktree is still available, its ignored `build/gentle-shell-4-8-evidence/independent/` contains `resume-2d028dab` and `nan-proof-v3-bed0017a`, with the preparation and post-run integrity receipts. These local evidence directories are not part of the branch.

## Resume in this order

1. **Recover the Pi executor.** Close Pi normally and reopen it in the same workspace. Before launching any worker, confirm that the previous child exited and that the executor is usable through supported controls. The previous task reported `child exit unconfirmed after 1000ms; capacity quarantined`; a later diagnosis stalled at startup. An empty task list or no visible attached descendant does not resolve the old child. If the state cannot be confirmed, stop there and preserve the results below this checkpoint.
2. **Test the real Shell RPC.** Use the exact 4.8 launcher with SDK 1.5.0, synthetic state, both existing launch guards, and effective loopback-only confinement for the launcher and every descendant. Verify `get_state`, `get_available_models`, and clean process exit. An in-process fetch mock is not descendant containment.
3. **Stage and smoke the Windows runtime.** Acquire and verify the pinned Gentle AI 4.5.0 Windows helper through the supported provenance checks. Stage the runtime in owned output, verify the manifest, package and binary identities, and check that the staged runtime starts and shuts down. Record the exact commands, exits and proof locations. Do not use a dev-binary override, install over the existing app, publish a release, or replay passing source checks without a changed input.

If a prerequisite is missing, record the blocker in the [ODD log](../odd/tasks/gentle-shell-4-8.md#log). Keep the prior failure evidence and correction limits; do not bypass the quarantine or weaken the checks.
