# Windows computer provider preparation

The daemon prepares **only Windows x64** managed eyes (ScreenView 0.2.1)
and hands (the audited Dot-only InputControl 0.2.1-dot.1). It never substitutes
the upstream blue hands artifact. macOS keeps its existing native helper
registration; other platforms have no managed provider.

## Host integration

`startDaemon({ computerComponents: { eyes, hands }, ... })` accepts trusted,
already-acquired local component records. Each record supplies absolute
`archivePath` and `executablePath`. No environment flag, engine configuration,
WebSocket message or app-channel registration supplies these records.

Preparation checks archive size/SHA256, the exact executable entry basename,
and executable SHA256 against fixed production pins in `computer-providers.ts`.
Missing files, wrong hashes, non-files and invalid identities fail closed.
ScreenView's executable pin was derived without execution from the unique
`screenview-mcp.exe` entry in its SHA256-verified Arise archive. Hands pins come
from the local audited derivative manifest. There is no download or installation.
The resolver's optional expected-record argument is a deterministic test seam;
daemon composition always uses production pins.

`DotDaemon.computerProviders` exposes only `{ status, kind }`, never paths or
credentials. `ready` means **artifact preparation only**, not permission to
capture or control the desktop. Defaults are unavailable because acquisition
has not supplied paths. `native-macos` describes routing, not helper readiness.

## Read-only archive validation

`readComputerArchive(bytes, kind)` in `computer-archive.ts` uses the fixed
`COMPUTER_ARTIFACTS` pins. Its optional expected-pins argument is only a deterministic
test seam. It verifies exact archive size/SHA256 before decoding, then returns
all regular files as `{ path, bytes, sha256 }`, including the complete PyInstaller
`_internal` payload. Directory entries are validated but not returned. Returned
buffers do not alias the input. Nothing is exposed until every entry passes and
exactly one case-exact executable basename matches its pinned SHA256.

The supported subset is single-disk ZIP32, stored or raw deflate, ASCII safe
Windows paths, flags zero or UTF-8, and regular files/empty stored directories.
Local and central metadata must agree; CRC, expanded length, contiguous ranges,
case-fold uniqueness and directory ancestry are checked. Encryption, ZIP64,
extra fields, comments, descriptors, links/reparse attributes, unsafe names and
other formats fail closed with `Invalid computer archive`. Limits are 64 MiB
archive, 256 MiB expanded total, 64 MiB per file and 4096 entries; inflation is
bounded by the declared size. This is intentionally not a general ZIP library.

This API performs no filesystem writes, extraction, network access or execution.
Acquisition must preserve the entire returned onedir payload, not just the EXE.
It is not yet connected to daemon activation or the component cache.

## Not activation

No managed provider starts, no managed tools enter the engine's MCP config,
and readiness grants no session or approval exemption. Existing app-channel
`computer_register` and generic connector per-call approvals are unchanged.

Acquisition remains a later slice of the selected separate app/runtime/eyes/hands
component distribution. Activation must validate the full extracted payload,
revalidate executable identity and ownership at launch, obtain an authentic
native session grant, and implement effective Stop before exposure. It must
reuse the daemon's existing McpProxy stdio lifecycle, not add another process
manager. Pink frame/halo remain exclusively hands-owned; no Dot overlay is added.
This preparatory slice does not complete T5 or establish working Windows control.
