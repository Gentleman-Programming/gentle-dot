# Runtime report retired

The runtime diagnostic report and `/diagnostics` command have been retired from source. The retired command is refused as unsupported; it does not become an assistant prompt or collect a report. Typed report requests are no longer part of the protocol.

The added Discord/MCP diagnostic commands (`/discord-debug`, `/discord-trace`, `/discord-status`, `/mcp-inventory`) are also retired, together with their opt-in Discord capture and the added `/mcp` diagnostic toast. They use the same unsupported refusal; ordinary `/mcp` still forwards to the SDK.

Ordinary errors, voice device checks, Computer behavior and operational MCP remain. The optional Settings debug preference and private RDD capture are also retired from source. Existing stored keys, captures, logs and audit records are left untouched.

Existing finite [review failure guidance](windows-rdd-indicative-diagnostics.md) and explicit `dot_review_status` observations remain unchanged. They do not confer review or delivery authority.

The owner compiles. Node seam checks are source evidence only, not rendered UI or installed Windows acceptance. No runtime cleanup, installation, environment replacement or automatic repair is authorized.
