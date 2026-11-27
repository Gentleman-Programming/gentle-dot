# Emit an inventory for a clean Windows split runtime

Use the repository's local producer CLI to inventory an exclusively owned Windows x64 build of the Dot-private runtime for Shell **5.0.0** and Pi **1.6.0**. The CLI checks a predeclared layout and emits the [offline verifier's manifest format](windows-split-runtime.md#inventory-format). It does not build or activate the runtime, and it does not change the bundled Windows package.

## Run the producer

```text
node scripts/windows/split-runtime-inventory.mjs emit ROOT PLAN EXPECTED_PLAN_SHA256
```

| Input | What the wrapper supplies |
|---|---|
| `ROOT` | A fresh build output, on a local filesystem, from a trusted producer using a reviewed recipe and dependency lock. Use stable, ordinary paths under exclusive producer control. |
| `PLAN` | A UTF-8 JSON file **outside** `ROOT` containing the exact file paths approved for that recipe. Do not generate it by listing the candidate output. |
| `EXPECTED_PLAN_SHA256` | The 64 lowercase hex characters of the SHA-256 of the **raw plan bytes**, obtained from independent trusted configuration. Do not calculate it from the supplied plan just to make the command pass. |

The plan has exactly five fields, with no duplicate keys. `files` is an array of path strings, not manifest records. This is a layout example; any additional file from the approved recipe must also be declared:

```json
{
  "schema": 1,
  "target": "windows-x64",
  "shell": "5.0.0",
  "pi": "1.6.0",
  "files": [
    "bin/engram.exe",
    "bin/pi.exe",
    "bin/private-storage.exe",
    "daemon/cli.mjs",
    "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs",
    "node/node.exe",
    "ui/index.html"
  ]
}
```

On exit `0`, `emit` writes only compact JSON with one final LF to stdout. File records are sorted by path and contain `path`, `type: "file"`, `size` in bytes and lowercase `sha256`. Capture the exact bytes outside `ROOT` and use them only after the process succeeds. Exit `1` means refusal on stderr without an inventory; exit `2` means invalid usage on stderr. Use `--help` for usage. The CLI does not write to either input. The plan and output inventory are each limited to 16 MiB.

## What the CLI refuses

The CLI checks the plan digest before parsing it or walking the runtime tree. It admits the entire declared layout and checks on-disk types and metadata before opening any member for hashing. Paths use `/` and the verifier's restricted ASCII names. The CLI refuses traversal, ambiguous Windows spellings (including device names, short-name syntax and stream syntax), flagged private or archive names, case and file/directory collisions, and any unexpected or missing entry. Directories are implied by the file list; undeclared empty directories are refused.

Use only known public packaging inputs. Never point the CLI at a user home, private data, an archive, or previously staged, blocked or rejected output. The CLI does not inspect archive contents, and a filename rule cannot identify private content under an ordinary name.

## Trust and filesystem limits

- Keep `ROOT`, `PLAN` and their ancestors stable and under exclusive producer control throughout. The CLI refuses hard-linked files and the links and junctions that Node reports. Node does not expose all Windows reparse tags or enumerate alternate data streams here. Use input known to have neither; the CLI hashes the ordinary file stream only. It does not pin file handles across inspection and hashing or protect against concurrent replacement.
- Record the producer, source revisions, exact compatible recipe and lock, immutable dependency identities, and target separately. The plan pins names and the declared tuple, not upstream authenticity or the versions embedded in the binaries. The emitted inventory is a record of observed bytes, not a signature or upstream attestation.
- A consumer must get the **output manifest's** expected SHA-256 through its own independent trusted channel. A digest computed from a manifest delivered with the runtime does not make it trusted. The plan digest is not the output digest.

This implements local inventory emission only. Inert fixtures demonstrate format interoperability; no production provenance, native admission, CI build, publication or installation is established. See [distribution contracts](distribution.md) for the separate release gates.
