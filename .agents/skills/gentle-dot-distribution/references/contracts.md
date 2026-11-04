# Distribution evidence checklist

Read [the canonical distribution contract](../../../../docs/distribution.md) first. This checklist routes evidence; it does not restate upstream review authority or define a second release schema.

| Question | Source to inspect |
| --- | --- |
| Which launcher, private home and runtime does Dot use? | [Daemon configuration](../../../../packages/daemon/src/config.ts) and [runtime discovery](../../../../packages/daemon/src/runtime.ts) |
| Is staging actually frozen and host-compatible? | [Stager](../../../../scripts/package/stage-runtime.mjs), [target helpers](../../../../scripts/package/lib.mjs) and the producer's recipe/lock |
| What Windows packaging currently exists? | [Windows package entry](../../../../scripts/windows/package.ps1) and [installation documentation](../../../../docs/install.md) |
| Are provider identity and readiness being confused with permission? | [Provider preparation](../../../../docs/windows-computer-providers.md) and [dispatch limits](../../../../docs/windows-inputcontrol-dispatch.md) |
| Does a summary overstate implementation? | Compare its verbs to observed commands/results and the [current-versus-planned table](../../../../docs/distribution.md#what-exists-and-what-remains-planned) |

For the selected target, report:

1. Exact component tuple, producer/source, recipe and lock identities.
2. Archive/full-payload identity, size, licenses and real origin evidence; distinguish checksums from signatures.
3. Isolated functional results and explicitly missing platform/runtime/installed checks.
4. Binary activation/rollback boundary and data compatibility. Identify any migration that still needs separate authorization.

For documentation-only work, validate metadata, section order, local links and discovery path. Do not run an installer, package manager, provider, migration or desktop-control flow to check this checklist. Keep the short skill and canonical contract linked instead of copying their rules into new prompts.
