# Windows Engram discovery

The daemon resolves Engram on Windows without starting a login shell or rewriting the user's environment. This is a binary-discovery boundary only; it does not establish Windows data-directory privacy or installer integrity.

## Resolution order

1. A non-empty `ENGRAM_BIN` must be an existing, readable, absolute Windows `.exe` file. Invalid explicit configuration fails instead of silently selecting another binary.
2. Search absolute entries from `PATH` in order, then `<user-home>\go\bin` and `<user-home>\.local\bin`, then `<runtime>\bin`.
3. User home uses absolute `USERPROFILE` first, then absolute `HOMEDRIVE` + `HOMEPATH`; environment-name casing is ignored. It does not use inherited `HOME` for Windows discovery.

Windows paths are parsed with `win32` rules. Quoted PATH entries are unwrapped, empty and relative entries are skipped (so the current directory is not searched), and duplicate candidates are suppressed case-insensitively. Absolute drive and UNC paths are accepted; drive-relative and root-relative paths are not. File checks establish readable-file discovery, not binary trust. A valid junction is allowed and is not an integrity or ACL verdict.

## Platform boundary

`resolveEngramBin` delegates to this resolver only on `win32`. The Unix path remains `ENGRAM_BIN`, login-shell PATH, known folders, then packaged fallback. Source-checkout resolution remains unchanged; this Windows discovery applies when an installed runtime is configured.

This unit does not prove standalone Windows ACL/private-data safety, native lifecycle behavior, packaged-installer acceptance, capture/input/voice/panic behavior, or a complete Windows port. Those remain separate work units with their own evidence.

## Evidence and rollback

Focused checks for this unit:

- `node --test scripts/windows/test/runtime.test.mjs` — passed, 9/9.
- `node node_modules/vitest/vitest.mjs run packages/daemon/test/runtime.test.ts --maxWorkers=2` — passed, 9/9.
- `node node_modules/typescript/bin/tsc -b` — passed.
- `git diff --check` — passed.

These tests check resolution and runtime selection, not an actual Windows process launch or installer acceptance; runtime harness: N/A because this resolver change adds no process-launch boundary. Rollback is the whole work-unit change in `packages/daemon/src/windows-runtime.ts`, `packages/daemon/src/runtime.ts`, `packages/daemon/src/isolation.ts`, their focused tests, `scripts/windows/test/runtime.test.mjs`, and this document; consider downstream consumers before reverting it.
