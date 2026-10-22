# Windows CI validation boundary

The Windows workflow defines independent TypeScript and Rust gates, then permits installer smoke validation only after both pass. It is configured, not yet executed: no CI run or installer result is available.

## Workflow contract

- Triggers are feature-branch pushes, pull requests, and manual dispatch. Workflow permissions grant `contents: read`; concurrency cancels an older run for the same ref.
- The Windows 2022 TypeScript job performs frozen pnpm installation, typecheck, full Vitest, Windows Node contracts, and PowerShell parser checks.
- The separate Windows 2022 Rust job installs stable Rust, builds the UI and Windows icon, then runs locked Cargo tests.
- The installer job `needs: [typescript, rust]`. Only after both prerequisites pass does it build the per-user NSIS installer, run the isolated install/readiness/reinstall/uninstall smoke harness, and upload the QA installer plus runtime manifest. No release trigger, publish step, or `continue-on-error` is configured.

## Local evidence and current blockers

- `node --test scripts/windows/test/*.test.mjs` — passed, 15/15 with zero skips.
- `node node_modules/typescript/bin/tsc -b` — passed.
- `node node_modules/vitest/vitest.mjs run packages/daemon/test/engine-access.test.ts --maxWorkers=2` — partial: 7/8 passed; one Windows private-file mode assertion failed (`expected 384` / `0600`, got `438` / `0666` from `stat.mode & 0o777`). This reflects POSIX mode assumptions, not a DACL privacy proof; the broader Windows private-data gap remains open.
- `python` PyYAML `BaseLoader` parse — passed; checked read-only content permission, TypeScript/Rust job prerequisites for installer, absence of a release trigger, and absence of `continue-on-error`. Node `yaml` and `js-yaml` packages were unavailable.

No workflow run, Rust application test/build, Credential Manager/Job/ACL execution, installer, or clean-install acceptance has been observed. The known focused Vitest failure remains visible and is not skipped or weakened. Until the workflow is committed/published and a run completes, its gates are configuration only.

Rollback is the W5b unit in `.github/workflows/windows-native.yml`, `packages/daemon/test/engine-access.test.ts`, and this document; consider downstream consumers before reverting it. The runtime contract tests exercise fixture and pipe behavior but are not a workflow-run or installation harness.
