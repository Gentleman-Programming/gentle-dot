# Windows Engram discovery

The daemon resolves Engram on Windows without starting a login shell or rewriting the user's environment. This is a binary-discovery boundary only; it does not establish Windows data-directory privacy or installer integrity.

## Resolution order

1. A non-empty `ENGRAM_BIN` must be an existing, readable, absolute Windows `.exe` file. Invalid explicit configuration fails instead of silently selecting another binary.
2. Search absolute entries from `PATH` in order, then `<user-home>\go\bin` and `<user-home>\.local\bin`, then `<runtime>\bin`.
3. User home uses absolute `USERPROFILE` first, then absolute `HOMEDRIVE` + `HOMEPATH`; environment-name casing is ignored. It does not use inherited `HOME` for Windows discovery.

Windows paths are parsed with `win32` rules. Quoted PATH entries are unwrapped, empty and relative entries are skipped (so the current directory is not searched), and duplicate candidates are suppressed case-insensitively. Absolute drive and UNC paths are accepted; drive-relative and root-relative paths are not. File checks establish readable-file discovery, not binary trust. A valid junction is allowed and is not an integrity or ACL verdict.

## Git on the bundled daemon PATH

On Windows, the desktop launcher keeps `<runtime>\bin`, `<runtime>\node`,
`<SystemRoot>\System32`, and `<SystemRoot>` first. It then appends only the first
absolute directory on the launch environment's PATH containing a `git.exe` file.
Custom locations, spaces, and Unicode are supported, including quoted PATH entries.
The selected directory is serialized with Windows PATH quoting rules: a directory
containing a semicolon stays one quoted entry. An entry that cannot be serialized
losslessly is not appended; the existing runtime/system prefix stays unchanged.
Windows environment-variable lookup is case-insensitive (`PATH` and `Path` name
the same variable). Empty and relative entries are skipped; missing Git is nonfatal.

The launcher does not import the rest of the ambient PATH, install Git, start a
shell, or change global environment variables. Bundled Node retains precedence;
explicit `GENTLE_DOT_NODE` / `GENTLE_DOT_DAEMON_SCRIPT` overrides, source-checkout
launches without a bundled daemon, and Unix PATH behavior are unchanged. Adding a
Git directory also makes other executables in that directory discoverable, after
the runtime and system entries; file discovery is not a binary-integrity check.

Native `launch_spec` tests use temporary, non-executed `git.exe` fixtures to check
selection order, custom paths with spaces, semicolons and Unicode, emitted PATH
entry boundaries, environment-name casing, missing Git, restricted PATH contents,
source fallback, and overrides. These tests establish
launch configuration, not installed Git execution or installer acceptance.

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
