# Windows Engram discovery

The daemon resolves Engram on Windows without starting a login shell or rewriting the user's environment. This is a binary-discovery boundary only; it does not establish Windows data-directory privacy or installer integrity.

## Resolution order

1. A non-empty `ENGRAM_BIN` must be an existing, readable, absolute Windows `.exe` file. Invalid explicit configuration fails instead of silently selecting another binary.
2. Search absolute entries from `PATH` in order, then `<user-home>\go\bin` and `<user-home>\.local\bin`, then `<runtime>\bin`.
3. User home uses absolute `USERPROFILE` first, then absolute `HOMEDRIVE` + `HOMEPATH`; environment-name casing is ignored. It does not use inherited `HOME` for Windows discovery.

Windows paths are parsed with `win32` rules. Quoted PATH entries are unwrapped, empty and relative entries are skipped (so the current directory is not searched), and duplicate candidates are suppressed case-insensitively. Absolute drive and UNC paths are accepted; drive-relative and root-relative paths are not. File checks establish readable-file discovery, not binary trust. A valid junction is allowed and is not an integrity or ACL verdict.

## Bundled Windows launch paths

The desktop launcher constructs the bundled Node program, CLI script, and runtime
PATH directories with native path-component joins. This preserves ordinary drive,
UNC, and canonical verbatim (`\\?\`) roots. OS program and PATH entries retain
their namespace.
Forward-slash suffixes under a verbatim root are not valid Windows executable
paths: an isolated native `launch_spec` fixture reproduced OS error 123 at process
creation before this correction. The bundled-runtime presence check also joins
`daemon` and `cli.mjs` separately.

The regression copies the build-time Node into an owned temporary runtime with
spaces and a semicolon, canonicalizes its root, and executes only a tiny fixture
CLI through the generated program, arguments, and environment. Native proof on
Node 24.14.0 passes with exit 0, exact stdout, empty stderr, native program
components, canonical script identity, and restricted PATH entry boundaries.
Component joins alone cleared OS error 123 but exposed Node CLI `EISDIR`
(`lstat 'C:'`) for the raw verbatim script argument.

Only the bundled Node entry argument uses a purpose-specific bridge: verbatim
Disk/UNC paths round-trip through `tauri::Url::from_file_path` / `to_file_path`.
The resulting ordinary path is selected only when both paths canonicalize to the
same existing script. Failed or ambiguous conversions retain the original path,
not an alternative file. The negative native fixture creates distinct trailing-dot
and ordinary directories: the bridge rejects the alias, and Node exits 1 with
empty stdout rather than executing either script. No experimental flags, loader,
namespace string stripping, new dependency, or override mutation is introduced.
This check is not an atomic file-integrity guarantee against concurrent changes.

The tests do not execute the installed app, real daemon, or runtime engine.
Verbatim UNC conversion is subject to the same filesystem-equivalence check;
execution from a live UNC share was not exercised.
Every emitted Windows PATH directory uses `join_paths` quoting; unserializable
entries are omitted rather than split into additional search directories. Unix
launch strings and source/build-time fallback are unchanged.

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

## Key Learnings

1. A canonical Windows runtime root can carry a verbatim namespace prefix; adding
   slash-delimited suffixes as strings reproduced native executable error 123.
2. Native component joins clear the executable spawn failure, while Node's CLI
   needs a separate representation bridge verified against canonical identity.
   PATH serialization separately preserves semicolon-containing directories.
3. Source fixture execution proves this launch-spec boundary only. Windows Job
   ownership, private channel transport, permissions, installed readiness, and the
   remaining installer lifecycle are not revalidated by this regression.

## Platform boundary

`resolveEngramBin` delegates to this resolver only on `win32`. The Unix path remains `ENGRAM_BIN`, login-shell PATH, known folders, then packaged fallback. Source-checkout resolution remains unchanged; this Windows discovery applies when an installed runtime is configured.

This unit does not prove standalone Windows ACL/private-data safety, native lifecycle behavior, packaged-installer acceptance, capture/input/voice/panic behavior, or a complete Windows port. Those remain separate work units with their own evidence.

## Evidence and rollback

Native desktop correction checks:

- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml launch_spec`
  — passed, 7/7, including benign Node execution and ambiguous-alias rejection.
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml`
  — passed, 367 tests, 2 existing ignored tests; main/doc tests passed with no cases.
- Isolated baseline/candidate launch-spec comparison — ordinary, source, explicit
  override, and incomplete-runtime fixtures all matched exit 0, exact stdout, and
  empty stderr. Scratch sources were extracted outside the repository; committed
  tests do not read Git history.

These are previously observed results, not new checks at local closure. The
independent Cargo launch-spec run also passed 7/7. Its supplementary extracted
probe did not establish additional independent comparison evidence: after a CRLF
extraction correction, malformed JavaScript in the probe fixture prevented three
cases from running meaningfully. That is an unavailable supplement, not a
candidate failure or a passing independent differential. The maintainer accepted
this limitation for local closure; no additional verification round was run.
Installed readiness and the remaining installer lifecycle are still unverified.

Earlier resolver checks (not rerun by the desktop correction):

- `node --test scripts/windows/test/runtime.test.mjs` — passed, 9/9.
- `node node_modules/vitest/vitest.mjs run packages/daemon/test/runtime.test.ts --maxWorkers=2` — passed, 9/9.
- `node node_modules/typescript/bin/tsc -b` — passed.
- `git diff --check` — passed.

The earlier resolver checks establish resolution and runtime selection only. The
native desktop fixture additionally proves benign Node process creation and CLI
entry execution, not installed acceptance. Desktop rollback is the cohesive
`daemon.rs` launch-spec correction plus its tests and this documentation.
The earlier resolver rollback is the whole work-unit change in `packages/daemon/src/windows-runtime.ts`, `packages/daemon/src/runtime.ts`, `packages/daemon/src/isolation.ts`, their focused tests, `scripts/windows/test/runtime.test.mjs`, and this document; consider downstream consumers before reverting it.

## Separate daemon-to-engine Node entry boundary (T13)

The desktop Rust bridge above covers only `daemon/cli.mjs`. The daemon then
starts its default engine with `process.execPath` and the launcher returned by
`bundledGentleShell`: `daemon/node_modules/gentle-pi/bin/gentle-shell.mjs`, not
`bin/pi.exe`. The runtime environment deliberately retains its OS namespace.

A separate native Node 24.14.1 fixture reproduced the engine failure through
public `loadConfig`: verbatim runtime, spaces, semicolon, and URL-reserved
characters; child exit 1, empty stdout, `EISDIR` at `lstat 'C:'` in Node's
JavaScript realpath/CLI resolver. The fixture is on C:, unlike the installed D:
failure; it runs only a harmless fake launcher, not the SDK or a provider.

`config.ts` bridges only the bundled Windows verbatim engine entry via Node's
`pathToFileURL` / `fileURLToPath`. Before returning an ordinary argument, it
compares `realpathSync.native` of the original with the native canonical identity
of the ordinary argument resolved by JavaScript `realpathSync` (as used by Node's
CLI). No prefix is stripped manually. Missing conversions/targets, unequal
canonical identities, or ambiguous namespace-only trailing-dot/space components
fail configuration with `The bundled assistant engine has no equivalent Node
entry path: <path>`, before any child is started. Node itself can preserve some
trailing-dot spellings; these are conservatively refused because ordinary Win32
consumers can alias them. Tests retain distinct dotted/ordinary scripts and an
unpaired dotted directory, checking rejection leaves fixture bytes/tree unchanged.

Ordinary paths, Unix paths, source fallback, explicit `GENTLE_DOT_AGENT_BIN` and
`GENTLE_DOT_AGENT_ARGS`, and the runtime OS namespace are unchanged. There is no
loader, experimental flag, dependency, global PATH, transport, Go, or Rust change.
This is an execution-representation guard, not an atomic integrity guarantee:
files/junctions can change after the identity check. Live UNC-share execution and
an actual Unix runtime were not available. Native app acceptance remains unproven;
the producer SDK export mismatch is the separate T14 unit. Earlier Rust proof is
historical and was not rerun for T13.

Local closure retains an explicit proof limit: the independent probe observed
ordinary/verbatim execution, canonical identity, namespace preservation and paired
alias rejection, but generated-script syntax errors prevented its remaining
negative and override checks. One bounded correction was exhausted. The maintainer
accepted this limit; the final direct config/runtime suite passed 19/19 with Node
24.14.1 and TypeScript passed. This is not a claim that the incomplete independent
checks passed, and no further verifier or installed-app run was performed.
