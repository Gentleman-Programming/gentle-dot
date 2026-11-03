# Windows computer provider preparation

The daemon prepares **only Windows x64** managed eyes (ScreenView 0.2.1)
and hands (the statically audited Dot-only InputControl 0.2.1-dot.2). It never substitutes
the upstream blue hands artifact. macOS keeps its existing native helper
registration; other platforms have no managed provider.

## Host integration

`startDaemon({ computerComponents: { eyes, hands }, ... })` accepts trusted,
already-acquired local component records. Each record supplies absolute
`archivePath` and `executablePath`. No environment flag, engine configuration,
WebSocket message or app-channel registration supplies these records.

When `computerComponents` is absent, startup calls the read-only
`discoverComputerComponents(dataDir)` and passes its result through the same
fixed-production-pin resolver. Discovery inspects only Windows x64; other
platforms keep their existing routing without inspecting the cache. Explicit
host records, including `{}` or a partial pair, take priority: they are never
merged with or silently replaced by cached records. Missing or invalid caches
remain unavailable without repairing the cache, installing, downloading or
starting a provider. Ordinary daemon startup still creates its own runtime files.

Preparation checks archive size/SHA256, the exact executable entry basename,
and executable SHA256 against fixed production pins in `computer-providers.ts`.
Missing files, wrong hashes, non-files and invalid identities fail closed.
ScreenView's executable pin was derived without execution from the unique
`screenview-mcp.exe` entry in its SHA256-verified Arise archive. Hands pins come
from the local audited derivative manifest. There is no automatic download or installation.
The resolver's optional expected-record argument is a deterministic test seam;
daemon composition always uses production pins.

### Current hands identity and evidence limits

Dot.2 pins the local, unpublished archive to **22,421,353 bytes**, SHA256
`3117d925cd397fd79bfbb786723a294cfdc1bcc775790bbd4e2e10c78aedca0a`, and its EXE to
`ea581fe8a586daa3c3e0ae7521453ec60440f5af966c4ee40776b048c0a4703f`.
Independent static inspection verified all 1,042 payload files and all 15 embedded
provider modules against the intended sources, including responsive dispatch,
release-failure fencing and the hands-owned pink indicator.

The original compile command still records exit 1: its preservation guard rejected
six additional historical dependency `ctime` changes. The operator accepted only
those exact historical changes after the independent audit; all 6,269 input file
hashes and sizes matched. This is not a successful-build claim or a blanket metadata
exception. Failed receipts remain intact. Runtime dependency completeness, the
physical indicator and effective physical Stop are **not yet verified**.

Older Dot.1 caches remain on disk but do not satisfy current fixed pins. There is
no downgrade or upstream fallback, automatic migration, deletion or invented release URL.
Pinning the audited bytes does not install, start or grant permission to a provider.

`DotDaemon.computerProviders` exposes only `{ status, kind }`, never paths or
credentials. `ready` means **artifact preparation only**, not permission to
capture or control the desktop. Default startup is unavailable unless discovery
finds a complete verified cached pair. `native-macos` describes routing, not helper readiness.
The returned status object is frozen and contains only `status` and `kind`.

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
The cache API below consumes this reader; daemon startup uses its read-only
discovery, while acquisition and activation remain separate work.

## Private full-payload cache API

`computer-components.ts` exports synchronous, trusted-host-only APIs on Windows x64:

- `installComputerComponent(dataDir, archiveBuffer, kind)` validates all acquired bytes
  before any filesystem mutation and returns `{ archivePath, executablePath }`.
- `verifyCachedComputerComponent(dataDir, kind)` returns a verified record, `undefined`
  when absent, or throws the path-free `Invalid computer component cache` error.
- `discoverComputerComponents(dataDir)` returns only a complete verified eyes/hands pair,
  or `undefined`. Discovery is read-only, including when missing or invalid.

Production uses fixed `COMPUTER_ARTIFACTS`; optional expected pins are test-only.
Versions live below the existing daemon data directory at
`components/windows-x64/<kind>/<version>-<full archive SHA256>/`, with the original
`archive.zip` separate from `payload/` (including every `_internal` file).
Installation uses exclusive random staging, native private directories/buffer writes,
full staged verification and a non-replacing Windows directory rename. Same-process
calls serialize synchronously; a concurrent winner is reused only after verification.
Old/invalid versions and failed staging are never overwritten or removed; no cache GC.

Every verification revalidates the full pinned archive and compares the exact payload
file/directory list and all file hashes, without trusting a generated receipt.
Junctions/symlinks, escaping paths and multiply linked files fail closed. Native writes
also reject reparse ancestors and enforce current-user/SYSTEM protected DACLs.
This is artifact preparation, not a launch-time ownership check or a session grant.
No network, executable loading, MCP exposure, model/WebSocket API or startup install
is added. Public eyes download and honest local unpublished Dot-hands sourcing are
still unimplemented, as are native grant and effective Stop. Cached readiness is
cryptographic artifact verification only: full payload and ownership must be
revalidated before any future launch.

## Not activation

No managed provider starts, no managed tools enter the engine's MCP config,
and readiness grants no session or approval exemption. Existing app-channel
`computer_register` and generic connector per-call approvals are unchanged.

Source acquisition remains a later slice of the selected separate app/runtime/eyes/hands
component distribution. Activation must validate the full extracted payload,
revalidate executable identity and ownership at launch, obtain an authentic
native session grant, and implement effective Stop before exposure. It must
reuse the daemon's existing McpProxy stdio lifecycle, not add another process
manager. Pink frame/halo remain exclusively hands-owned; no Dot overlay is added.
This preparatory slice does not complete T5 or establish working Windows control.
