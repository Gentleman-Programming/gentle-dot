# Windows private local storage

Windows local runtime private directories and files use a small packaged helper, not POSIX mode bits. The helper creates or tightens only the requested application-owned directory and writes files through a protected, exclusive same-directory temporary file followed by atomic replacement.

## Runtime behavior

- The Windows runtime build emits `bin/private-storage.exe` alongside the native engine launcher. The build host needs Go; the installed user's PC does not. For local source development on Windows, run `pnpm prepare:windows-private-storage` from the repository root; it builds the helper into ignored `build/windows/local-tools/bin/`, separate from `build/windows/runtime/` packaging staging. The daemon resolves that helper relative to its own source module, never the current working directory. No app startup compilation, Go installation, download, or tool discovery occurs.
- The daemon invokes the helper with a fixed operation and path argument. Private file contents travel over standard input, never the command line or logs.
- New directories and files on available local volumes receive a protected DACL allowing only the current Windows account and SYSTEM. Before private state is read, an existing file is checked and its DACL repaired in place only when it is owned by the current account, has exactly one hard link, and sits under a protected owned parent. The file contents are preserved; unsafe owner, hard-link, reparse, wrong-type, or parent conditions refuse access without deleting data. Network volumes are refused. Existing directories are tightened only at the requested path, not at its ancestors or general profile folders.
- Model-auth initialization protects only the selected agent home and secures an existing `auth.json` before the SDK reads it. For a missing file, the SDK creates its empty store beneath that private home; the daemon then protects the file DACL before exposing sign-in. SDK JSON parsing, credential bytes, cross-process locks and in-place writes remain unchanged. Malformed stores are not replaced, and unsafe linked or reparse files fail closed. Explicit agent-home overrides select the same boundary; ancestors are not tightened.
- Unix keeps its existing 0700/0600 owner checks. Windows `stat.mode` bits are not treated as privacy evidence.
- Installed mode uses only the helper packaged in that runtime and fails closed if it is missing. Source mode uses only the checkout-local helper produced by the explicit preparation command above and fails closed with that command when it is missing; it never falls back to the packaged runtime or searches the current directory.

## Trust boundary and tradeoffs

The helper is a synchronous process invocation per private directory or file operation, so Windows startup and write paths pay a small process-launch cost. This avoids relying on POSIX `chmod` semantics that Windows does not provide. The helper uses only the Go standard library and is packaged as a standalone executable.

These DACLs protect app data from other Windows accounts. Repairing a legacy file protects future reads; it cannot undo any prior disclosure or make an untrusted backup private. The helper refuses a hard-linked file rather than changing the shared file object and thereby changing an alias outside the app directory. The boundary does not isolate a malicious process running as the same account or a host administrator. Windows server-mode identity switching is not implemented by this helper; it runs as the daemon's current Windows account and does not emulate POSIX uid/gid changes.

## Proof

Windows tests independently inspect the actual owner, protected DACL, and allowed SIDs through .NET ACL APIs. New temporary fixtures verify inherited and explicit broad Everyone ACEs, first-read legacy repair with content preservation, hard-link refusal without alias mutation, file/directory protections, atomic replacement, unchanged parent ACLs, and reparse refusal. They do not touch an existing user folder or alter `GENTLE_DOT_RUNTIME`.

Offline model-auth tests also cover protected home/file DACLs, legacy BOM/whitespace byte preservation, public runtime API-key writes/reads and fresh-runtime visibility, malformed-store write rejection, and hard-link refusal without alias mutation. The installed SDK does not export `AuthStorage`; tests use the daemon's public model-auth runtime rather than importing private SDK storage internals.

The proof covers the native fixture and helper on the Windows test host. It is not clean-machine installation or full desktop/server acceptance evidence.
