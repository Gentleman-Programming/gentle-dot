# Windows runtime and packaging compatibility

Windows packaging retains automatic staging, `--skip-stage`, `--check`, and
NSIS/MSI output while using the current runtime layout. The explicit
`--runtime` route remains available. This document describes the source
contract, not installed-app or Windows acceptance.

## Packaging commands

Run packaging on native Windows x64 with the checkout's existing toolchain.
These commands build packages; they are not validation commands to run against
an ordinary development checkout without preparing its build prerequisites.

| Invocation | Staging | Bundles | Payload verification |
| --- | --- | --- | --- |
| `pnpm package:windows` | Automatic, `build/runtime/windows-x64` | NSIS + MSI | None |
| `pnpm package:windows --skip-stage` | Reuse the default stage | NSIS + MSI | None |
| Either above plus `--check` | As above | NSIS + MSI | Extract and compare both payloads |
| `pnpm package:windows --runtime <staged-dir>` | Never stage | NSIS only | None |
| `--runtime <staged-dir> --check` | Never stage | NSIS only | Extract and compare NSIS |

`--skip-stage` with `--runtime` is redundant and accepted. `--help` alone shows
both routes without reading a stage. Malformed arguments and unsupported hosts
are rejected before staging or packaging. The default route retains `CI=true`;
the explicit-runtime route retains the caller's environment.

Packaging invokes the local Tauri JavaScript CLI through Node, not a command
shell. The frontend path is relative to `src-tauri`; the runtime resource mapping
and packaged-runtime admission marker remain intact. A stage on another Windows
volume or UNC share is refused because that frontend path cannot be relative.
The embedded WebView2 bootstrapper policy is unchanged.

## Runtime layout and integrity

- The staging target is `windows-x64`, not `win-x64`.
- Node is `node/bin/node.exe`; npm is under `node/lib/node_modules/npm`.
  The engine wrapper is `bin/pi.cmd`, not `bin/pi.exe`.
- `daemon/native/windows-stop.node` is mandatory. Packaging checks its presence
  before console compatibility or bundling. Native ownership and authenticated
  shutdown remain separate runtime contracts.
- The integrity checker requires the stage manifest, daemon/package metadata,
  Engram, the private-storage helper, UI, launcher, and exactly one native
  Gentle AI executable. It rejects links and non-file entries, checks Windows
  executable headers, and inventories the complete tree. Verification checks
  both hashes and payload admission; matching hashes alone are insufficient.
- The target dependency graph remains SDK **1.5.0** / gentle-pi **4.6.0**, with
  engine sibling overrides derived from its lockfile. No dependency upgrade,
  downgrade, alternate backend, or new runtime prerequisite is implied.
- Windows runtime builds invoke the existing Go builder for `bin/private-storage.exe`;
  a missing stop addon refuses before output writes, and a Go failure propagates.
  Staging retains the explicit Go admission and isolated installer environment.
  Native ACL/private-storage admission and runtime-cache ownership must not be
  replaced with file-existence-only approval. Credentials remain on the target
  DPAPI backend; packaging does not migrate or inspect them.
- Engram discovery retains explicit overrides, Windows home/PATH rules, and the
  bundled fallback. Unix discovery and wrappers are unchanged. Git comes from
  the inherited system environment; MinGit is not staged.

## Source-bound console compatibility

The adapter admits only gentle-pi **4.6.0** and its inspected launcher bytes
(SHA-256 `f4e246c2da503ec84820b2dce067cc4a569b13809e5b2b9fa4001bbd677cc937`).
It also checks the consumed launch-planning and startup-relaunch helper hashes.
Five child creation sites gain only Windows-conditional `windowsHide`; command,
argv, environment, shell policy, signal forwarding and native ownership are unchanged.
The existing hidden Engram spawn is untouched. Unknown or partially patched source
fails closed; applying the exact adaptation twice is harmless.

Console compatibility is loaded only after host/Go admission. Windows staging
awaits read-only admission of the local declared package before replacing output
or downloading, then adapts only the staged dependency after installation. Unix
staging does not load it. Packaging awaits staged compatibility before bundling,
including asynchronous refusal, and requires a canonical existing stage manifest.
Neither route edits the project's installed dependency or changes its version.
Actual Windows staging and bundling still need verification; inert source/mocked
checks are not release readiness.

## Payload checks and verification boundary

`--check` uses 7-Zip for NSIS extraction and `msiexec /a` for MSI administrative
extraction, not product installation. It compares full file lists and selected
hashes, including Node, the stop addon, engine wrapper, Engram, daemon, and native
Gentle AI binary. Missing/small installers, extractor failures, missing/extra
files, and changed hashes fail the command. Scratch cleanup remains in a
`finally` block.

Focused inert tests exercise command plans, admission ordering, failure paths,
payload comparison, and synthetic integrity trees. They do not run staging,
downloads, installers, native helpers, providers, or the installed application.
Finite Discord startup diagnostics are retained elsewhere; no retired raw
trace/debug-report UI is restored by packaging.

Integrated typechecking, builds, browser checks, native security/concurrency
review, and real Windows package/runtime acceptance remain separate checks.
Historical results for other source trees are not evidence for this candidate.
