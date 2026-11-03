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
