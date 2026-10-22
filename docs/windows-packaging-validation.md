# Windows runtime packaging and validation

The Windows packaging path stages a relocatable runtime, records file hashes, builds a per-user NSIS installer, and provides a separate install smoke test. Source and fixture checks below do not prove a working installer or clean-machine acceptance.

## What the staged path does

- `package:windows` runs `scripts/windows/package.ps1`, which generates an icon, stages `build/windows/runtime`, then invokes Tauri to build an NSIS bundle configured for current-user installation.
- Staging pins Node `24.14.1` and Engram `3.4.0`; each archive is checked against the upstream SHA-256 listing before extraction. The daemon bundle is built, then its runtime dependencies are installed with npm `--omit=dev` and no bin links; a relocatable `pi.cmd`, Engram, UI, and integrity manifest are assembled.
- The manifest inventories runtime files by SHA-256, rejects links/unsupported entries, requires key runtime files and exactly one bundled Gentle AI executable, and checks only the `MZ` prefix of selected executables. Verify compares both missing/changed and unexpected files to the supplied manifest.
- This detects later tree drift relative to that manifest. It does not authenticate the manifest, establish publisher trust, verify a PE signature, or prove all executable bytes are valid. Upstream archive checksums likewise are not a signature guarantee.
- `smoke-install.ps1` is a separate acceptance harness: isolated per-user install, runtime-manifest check, daemon health wait, stopped-app reinstall, canary preservation, then uninstall. Its `taskkill /T /F` cleanup is test cleanup, not proof of graceful shutdown or emergency-stop behavior.

## Evidence and boundaries

- `node --test scripts/windows/test/*.test.mjs` — passed, 15/15 on Windows with zero skips.
- `node --test scripts/windows/test/integrity.test.mjs scripts/windows/test/stage.test.mjs` — passed, 5/5; fixture-tree integrity and real checksum function with mocked network responses.
- PowerShell AST `ParseFile` checks — passed for `package.ps1`, `stage.ps1`, and `smoke-install.ps1` under both Windows PowerShell 5.1 and pwsh. Scripts were not executed.
- `git diff --check` — passed.

No runtime lock or clean staging tree is established here: an earlier staging attempt reached `npm install` and stalled for about 16.8 minutes before it was cancelled after verifying and stopping only owned processes. The Windows packager, downloader, installer, and smoke-install script were not run for this W4 preparation; no installer was created. The runtime dependency tree may therefore depend on current resolution. CI workflow and broader integration evidence are W5, not this unit.

Rollback is the W4 unit in `scripts/windows/package.ps1`, `scripts/windows/stage.ps1`, `scripts/windows/runtime-integrity.mjs`, `scripts/windows/smoke-install.ps1`, `scripts/windows/test/integrity.test.mjs`, `scripts/windows/test/stage.test.mjs`, `package.json`, `apps/desktop/src-tauri/tauri.windows.conf.json`, and this document; consider downstream consumers before reverting it.
