# Verify a staged Windows x64 split runtime offline

This producer-side preflight checks a staged Dot-private runtime for Shell **5.0.0** and Pi **1.6.0** against an independently pinned inventory. A pass does not activate the runtime or change the existing bundled Windows package.

## Desktop opt-in is not a release candidate

The default Windows package remains bundled. The desktop Cargo feature `windows-split-runtime` is off by default, Windows x64 only, and incompatible with `local-preview`. Do not enable it in packaging: it does not produce a working app-only installer.

Split startup refuses before loading app configuration or starting services; it never falls back to the bundled app. There is no trusted production inventory compiled in and no runtime override or production path lookup. The binary exits `1` and reports `Gentle Dot split runtime: no trusted inventory pin compiled in.` if stderr is available; it opens no window and writes no profile log. Even a verified component cannot start services.

The private native adapter consumes a sealed plan that owns the admitted tree and names its exact `node\node.exe` and `daemon\cli.mjs`. It uses the existing suspended-create, Job, channel and stop-record pipeline without the bundled environment overlay or a new bootstrap executable. A trusted caller must provide separate writable state; the same path is the working directory, environment data root and stop-record directory. The plan checks ordinary absolute DOS spelling and rejects equal or nested runtime/state paths in either direction, ignoring case at component boundaries.

The plan supplies only `GENTLE_DOT_RUNTIME`, `GENTLE_DOT_DATA_DIR`, `GENTLE_DOT_PORT`, and `PATH` (the runtime's `bin` and `node` directories). It inherits nothing and does not synthesize `SystemRoot`. The native child retains the tree guards through checked process/Job cleanup and unfinished failures. If final drop cannot establish completion, one guard is quarantined for the rest of the app process, and further split launches are refused. App exit or Job handle closure is not proof of child termination.

No production path selects this adapter. The plan does not provision state, resolve filesystem aliases, verify state ACLs or alternate streams, or guarantee same-user safety. An inert Windows test helper is not evidence that a real Node/Shell runtime can run with this environment. Trusted production inventory, private root/state provisioning and isolated runtime acceptance are separate gates.

## Run the check

```text
node scripts/windows/split-runtime-verify.mjs verify ROOT MANIFEST EXPECTED_SHA256
```

Supply a local, exclusively owned staging directory and a separate JSON manifest outside it. Supply the 64-character lowercase SHA-256 of the **raw manifest bytes** from an independent trusted source. A checksum that merely accompanies the manifest is not independent provenance or a signature. Use `--help` to show usage. Exit `0` reports verification on stdout; exit `1` reports a refusal on stderr; exit `2` reports invalid usage on stderr.

## Inventory format

| Field | Accepted value |
|---|---|
| `schema`, `target` | `1`, `"windows-x64"` |
| `shell`, `pi` | `"5.0.0"`, `"1.6.0"` |
| `files` | Array of records with exactly `path`, `type` (`"file"`), `size` (nonnegative safe integer in bytes), and `sha256` (64 lowercase hex characters) |

The UTF-8 JSON manifest is limited to 16 MiB and must have exactly the top-level fields above, without duplicate field names. The verifier compares its bytes against the supplied digest before parsing or inspecting the staged tree. The inventory must include the [existing Windows required core](../scripts/windows/runtime-integrity.mjs). Each listed path uses `/` separators and only ASCII letters, digits, `.`, `_`, `@`, `+` and `-` within components. Paths are limited to 240 characters and components to 120. Leading dots are allowed for ordinary package names. Windows devices, short-name alias syntax, trailing dots or spaces, case collisions, and file/directory collisions are refused.

The tree must contain all and only the listed regular, single-linked files at the listed spelling, plus their implied directories. Extra files, even metadata, and extra empty directories are refused. Each file must match its byte length and digest. The verifier refuses flagged private names and archive names without opening them; give it only known public packaging inputs, never user homes, private data, or old stage or audit archives. A name check cannot detect private contents disguised under an ordinary name.

## Limits and next gate

Keep the manifest, root and their ancestors stable and under exclusive producer control for the entire check. Use ordinary local directories and files, not aliases or reparse points. The verifier refuses links exposed by Node's filesystem metadata but does not establish complete Windows reparse-point or alternate-stream coverage, nor protect against concurrent replacement. It checks ordinary file bytes, not whether the binaries execute or match the declared versions internally. It does not create an inventory, fetch anything, verify a publisher signature, install the component, or admit it at native launch. Validated production provenance and native admission remain separate gates; see [distribution contracts](distribution.md).
