# Windows daemon ownership and app channel

Windows daemon launches use an owned Job Object and anonymous standard-I/O pipes for the app's private channel. This describes implemented source and focused checks only; Rust code has not been compiled or exercised on Windows here.

## Launch and shutdown boundary

- The desktop creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before launch. For app-channel launches, the child starts behind a one-byte bootstrap gate; it is assigned to the Job before that gate is released, so the daemon cannot start spawning engine descendants first. Assignment failure kills and reaps the launched child.
- With the app channel enabled, stdin/stdout carry the private protocol. `GENTLE_DOT_APP_STDIO` selects that mode and is removed before child processes can inherit it. The Node daemon validates both handles as pipes, then reserves stdout for frames and sends startup text to stderr.
- The Node child receives `NODE_OPTIONS` and `NODE_PATH` removed. Windows hides the child console. The Job handle remains owned with the child wrapper; closing it also terminates descendants.
- Channel shutdown marks the writer closed and attempts a non-blocking writer-handle close. If a write is stuck, it does not wait on that lock; the Job's bounded child-stop path remains responsible for cleanup. EOF is therefore opportunistic, not the sole cleanup guarantee.
- The desktop only uses a daemon it launched when an app channel is present. A recorded PID plus process start time distinguishes its prior child; an unowned daemon on the port is refused rather than attached to. Closing the app channel also makes the launched daemon close itself.

## Data-directory guard and limits

Before launch, Windows source creates the configured data directory, rejects non-absolute/general-folder/reparse-point targets, canonicalizes it, and applies a protected DACL granting Owner Rights and SYSTEM full access, inherited to children. Unix retains its existing private directory and socket path.

This is source behavior, not a verified Windows ACL result. No Rust Windows target build or runtime test is claimed. Credential Manager is a later work unit; this unit does not prove secure credential storage, installed-app acceptance, native control/voice/panic capabilities, or a complete Windows port.

## Verification and rollback

- `node --test scripts/windows/test/channel.test.mjs` — passed, 1/1 on Windows; validates the anonymous-stdio protocol, EOF closure, and that the selector is not inherited by the test child.
- `node node_modules/vitest/vitest.mjs run packages/daemon/test/app-channel.test.ts --maxWorkers=2` — passed, 9/9.
- `node node_modules/typescript/bin/tsc -b` — passed.
- `git diff --check` — passed.
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` — not rerun; earlier native attempt was blocked because MSVC `link.exe` was unavailable. Metadata API checking is not binary compilation evidence.

The Node integration test is a real Windows pipe/EOF harness, not proof of Rust Job assignment or descendant cleanup. Rust Job/backpressure/data-directory tests remain unverified. Rollback is the W2 work-unit change in `apps/desktop/src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `icons/icon.ico`, `src/app_channel.rs`, `src/config.rs`, `src/daemon.rs`, `src/lib.rs`, `src/platform.rs`, `src/status.rs`, `src/windows_process.rs`, `packages/daemon/src/app-channel.ts`, `packages/daemon/src/cli.ts`, `scripts/windows/test/channel.test.mjs`, and this document; consider downstream consumers before reverting it.
