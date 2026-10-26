# Windows runtime packaging and validation

The Windows packaging path stages a relocatable runtime, records file hashes, builds a per-user NSIS installer, and provides a separate install smoke test. Source and fixture checks below do not prove a working installer or clean-machine acceptance.

## What the staged path does

- `package:windows` runs `scripts/windows/package.ps1`, which generates an icon, stages `build/windows/runtime`, then invokes Tauri to build an NSIS bundle configured for current-user installation.
- Staging requires Go on the Windows build host. The runtime builder compiles a standard-library-only native `bin/pi.exe`; it derives adjacent `node/node.exe` and the bundled engine CLI from its own location, forwards argv directly without a shell, and preserves child stdio and exit status. Unix builds keep the existing `bin/pi` shell wrapper.
- Staging pins Node `24.14.1` and Engram `3.4.0`; each archive is checked against the upstream SHA-256 listing before extraction. The daemon bundle is built, then its runtime dependencies are installed with npm `--omit=dev` and no bin links; the native launcher, Engram, UI, and integrity manifest are assembled. The Windows runtime integrity manifest requires and hashes `bin/pi.exe`.
- Windows CI run `39800141932` remains a failed integration result (47 failed, 749 passed, 18 skipped); installer execution and installed-runtime acceptance remain pending. A launcher build/test pass does not close those gates.
- The manifest inventories runtime files by SHA-256, rejects links/unsupported entries, requires key runtime files and exactly one bundled Gentle AI executable, and checks only the `MZ` prefix of selected executables. Verify compares both missing/changed and unexpected files to the supplied manifest.
- This detects later tree drift relative to that manifest. It does not authenticate the manifest, establish publisher trust, verify a PE signature, or prove all executable bytes are valid. Upstream archive checksums likewise are not a signature guarantee.
- `smoke-install.ps1` is a separate acceptance harness: isolated per-user install, runtime-manifest check, daemon health wait, stopped-app reinstall, canary preservation, then uninstall. Its `taskkill /T /F` cleanup is test cleanup, not proof of graceful shutdown or emergency-stop behavior.

## Current checksum correction (S2 / T3)

The single bounded native Windows PowerShell fetch used `Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "https://github.com/Gentleman-Programming/engram/releases/download/v3.4.0/checksums.txt"` (outer process timeout: 45 seconds). It exited 0 with HTTP 200 under PS `5.1.26100.9711`; `.Content.GetType().FullName` was `System.Byte[]`. The exact listing was logged as base64 and escaped JSON: six UTF-8/ASCII lines, LF endings, final LF, no BOM. Its Windows x64 entry was exactly:

```text
3065736ec7ff8137eb3fc607275f542ea13bb743a5157318c8a8770f11ce3289  engram_3.4.0_windows_amd64.zip
```

The production function previously applied a text regex to that byte array. It now decodes byte-array content as UTF-8 before matching; existing string handling, archive hashing, missing-entry rejection, pins and function interface remain unchanged. No executable ZIP was fetched for this diagnosis, and there is no digest fallback.

Observed validation:

- `node --test --test-name-pattern="stage handles observed PS5" scripts/windows/test/stage.test.mjs`: RED exit 1, stdout empty, script stderr `Expected 'Checksum mismatch: engram_3.4.0_windows_amd64.zip'; got 'Missing checksum for engram_3.4.0_windows_amd64.zip'`. GREEN exit 0, 1/1 passed; script stdout `PS5 checksum regression passed`, stderr empty. The fixture replays the exact fetched listing against synthetic `abc` bytes, expecting mismatch, not claiming a real archive download. Additional controlled byte/string listings verify valid bytes, tampering and absent entries. Rejections return no verified path or staged consumer artifact; absent entries initiate zero archive downloads. Tampered downloads remain untrusted temp files until fixture teardown.
- Initial fixture-runner failures were not behavioral RED: an oversized encoded invocation produced `spawnSync powershell.exe EPERM`; stdin `-Command -` then produced empty stdout without executing the final block. The fixture now evaluates stdin as one script block.
- Native PS5 differential against `b1c1876` extracted the production function from each version and used unchanged string content with valid and tampered bytes. Both exited 0, stderr empty, with identical stdout: `text: verified abc`, `Checksum mismatch: archive.zip`, `rejected: no staged artifact` (CRLF-terminated). Both temporary fixture directories were removed in teardown.
- `node --test scripts/windows/test/*.test.mjs`: exit 1, 15 passed / 1 failed. The new PS5 regression passed before the unchanged dual-host test failed on `spawnSync pwsh.exe ENOENT`. Its PS5 portion passed; PowerShell 7 coverage remains required, not waived.

Packaging risk item 5 and download-integrity risk item 2 remain review boundaries. The existing partial `build/windows/runtime` was preserved; no packaging rerun, installation or installed acceptance occurred. This correction does not establish a complete installer or successful real Engram ZIP verification.

## Historical evidence and boundaries (W4, not current-host proof)

- `node --test scripts/windows/test/*.test.mjs` — passed, 15/15 on Windows with zero skips.
- `node --test scripts/windows/test/integrity.test.mjs scripts/windows/test/stage.test.mjs` — passed, 5/5; fixture-tree integrity and real checksum function with mocked network responses.
- PowerShell AST `ParseFile` checks — passed for `package.ps1`, `stage.ps1`, and `smoke-install.ps1` under both Windows PowerShell 5.1 and pwsh. Scripts were not executed.
- `git diff --check` — passed.

No runtime lock or clean staging tree is established here: an earlier staging attempt reached `npm install` and stalled for about 16.8 minutes before it was cancelled after verifying and stopping only owned processes. The Windows packager, downloader, installer, and smoke-install script were not run for this W4 preparation; no installer was created. The runtime dependency tree may therefore depend on current resolution. CI workflow and broader integration evidence are W5, not this unit.

Rollback is the W4 unit in `scripts/windows/package.ps1`, `scripts/windows/stage.ps1`, `scripts/windows/runtime-integrity.mjs`, `scripts/windows/smoke-install.ps1`, `scripts/windows/test/integrity.test.mjs`, `scripts/windows/test/stage.test.mjs`, `package.json`, `apps/desktop/src-tauri/tauri.windows.conf.json`, and this document; consider downstream consumers before reverting it.
