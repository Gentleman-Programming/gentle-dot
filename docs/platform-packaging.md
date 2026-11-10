# Native packaging targets

**Implemented:** target selection in Dot's existing Tauri producers. This adapts
Arise's six native OS/CPU jobs, not its Python/Qt/Inno application or installer.
**Not verified:** six native builds, installed acceptance, or publication. See the
[distribution ownership and evidence gates](distribution.md).

| Target | Producer | Native staging requirement |
| --- | --- | --- |
| `darwin-arm64` | `node scripts/package/package-mac.mjs` (unchanged default) | ARM64 macOS, matching Node/Rust |
| `darwin-x64` | `node scripts/package/package-mac.mjs --target darwin-x64` | Intel macOS, matching Node/Rust |
| `linux-x64` | `node scripts/package/package-linux.mjs --target linux-x64` | Existing amd64 Docker builder |
| `linux-arm64` | `node scripts/package/package-linux.mjs --target linux-arm64` | Existing arm64 Docker builder |
| `windows-x64` | `powershell -NoProfile -File scripts/windows/package.ps1` (unchanged default) | x64 Windows, matching Node/Go/Rust |
| `windows-arm64` | `powershell -NoProfile -File scripts/windows/package.ps1 -Target windows-arm64` | ARM64 Windows, matching Node/Go/Rust |

## Options and output

macOS accepts `--target darwin-arm64|darwin-x64`; existing signing, skip-stage,
DMG-check and Finder-layout options remain. The standalone POSIX runtime stager
also accepts `darwin-x64`; it still refuses a mismatched host **before writes**.
Windows uses its separate ZIP/EXE stager, not that POSIX layout. Each command
accepts `--target` only once, including repetitions of the same value; repetition
fails with `--target may be specified only once.` before side effects.

Linux retains `--arch amd64|arm64`, output directory, Engram version and
`--no-arch-package`. Use either `--target` or `--arch`, not both. Target aliases
reuse the existing container architecture mapping. The Arch package remains
amd64-only; ARM64 still produces a Debian package. Containers may be emulated;
runtime staging inside them must match their Node process architecture.

Windows stage/package scripts accept `-Target windows-x64|windows-arm64` and
`-Help`. `stage.ps1 -CheckHost` checks the native OS, Node and Go targets without
staging; packaging additionally checks Rust. Invalid targets/host mismatches
exit 2 before downloads or output creation. Default Windows staging remains
`build/windows/runtime`; use separate clean workspaces per target, never stage
both into the same directory. Explicit Windows targets use Tauri's target-specific
bundle directory; the default retains `target/release/bundle`. Intel macOS uses
`target/x86_64-apple-darwin/release/bundle`; ARM retains its existing directory.

## Integrity and capability boundary

Node remains pinned to 24.14.1, Windows Engram to 3.4.0. Archive checksums,
Windows full-runtime sealing, NSIS path guards/current-user installation, and
macOS pinned Gentle AI signature/digest preservation remain in place. Missing
upstream checksum entries still fail closed; no replacement hashes are invented.
Gentle Pi's Windows Gentle AI dependency uses its verified Go source-build path,
not an invented signed Windows archive. Native build dependencies remain required.

Windows staging passes its validated target to `runtime-integrity.mjs seal ROOT
[TARGET]`; verification is `verify ROOT REFERENCE_MANIFEST [TARGET]`. The path
guard's `hook ROOT OUTPUT.nsh [TARGET]` and `destination ROOT DESTINATION [TARGET]`
use the same identity check. `TARGET` is `windows-x64` (default) or
`windows-arm64`, stored as `win32-x64` or `win32-arm64` in schema 1. Existing x64
manifests remain compatible. ARM64 requires explicit selection; unknown or
mismatched identities fail before changing manifests or hook output. These static
checks retain existing executable/header and full-inventory guards; they do not
establish native execution or provider compatibility.

The selected **separate app/runtime/eyes/hands** distribution is not implemented
by these installer changes. There is no new component downloader or activation.
Existing Windows provider pins do not establish ARM64 eyes/hands artifacts; do
not advertise those providers as ARM64-supported or substitute x64 payloads.

**Next unit:** wire package commands and native CI matrix/artifact/checksum jobs,
then obtain platform-native runtime and installed evidence. No `package.json`,
workflow, Rust, provider, or installed application is changed by this unit.
