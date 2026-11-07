# MCP operations remain; added diagnostic commands are retired

`/mcp` and its ordinary SDK subcommands still forward to the existing engine. The
added proxy-history toast, `/mcp-inventory`, `/discord-status`, `/discord-trace`
and `/discord-debug` are retired from source. Exact retired tokens, including
arguments or attachments, receive the normal unsupported-command response before
upload resolution, request deduplication, model/tool work or native requests.
Unknown slash commands and prefix lookalikes retain ordinary routing.

Discord opt-in JSONL tracing and the private startup stderr/PID cache are removed.
The optional Settings debug preference and private RDD capture are also retired.
Existing captures, settings, logs and audit records are not deleted or migrated.
There is no replacement diagnostic command or report.

## Ordinary failures and finite internal evidence

Transport, credentials, approval, lifecycle and normal RPC errors remain in place.
The internal proxy evidence store retains only finite categories/codes and indicative
connection hints; it is not an added chat collector or live health API. Deliberate
native RPC error passthrough remains separate. Generic upstream failure logging uses
fixed text rather than copying arbitrary errors.

| `kind` | Reviewed public pi-mcp transport template matched transiently |
| --- | --- |
| `stdio_incomplete_message` | Exact incomplete JSON-RPC message sentence |
| `stdio_message_limit` | Anchored numeric stdio message-limit template |
| `invalid_jsonrpc_message` | Typed `McpError(-32600)` with exact producer sentence |
| `unknown` | Any other transport error, including arbitrary JSON parser text |

The installed SDK1.5.0 producer-template check must pass before claiming compatibility;
synthetic matches alone do not verify the installed dependency. Only enum evidence survives.
The existing bounded stderr interpreter keeps finite
startup hints, not original lines, tokens or paths. Close, drop and failed connect
dispose listeners; stale callbacks cannot revive history. Configuration sync and
key changes clear history. Concurrent and idle signals remain connection-scoped;
snapshot reads are pure copies and do not resolve credentials.

## Windows Discord launcher (unchanged)

For the exact default desktop Windows command `npx -y @pasympa/discord-mcp@2.2.0`, the proxy
invokes existing `<ProgramFiles>/nodejs/node.exe` directly on the existing package's `dist/index.js`.
It validates name, version, bin, regular files and non-linked ancestors under inherited
`LOCALAPPDATA/npm-cache/_npx`; at most 64 cache directories and 32 KiB per manifest are considered.
There must be exactly one matching package. Missing, ambiguous, invalid or linked entries refuse
before process creation with `Discord cached server is unavailable or ambiguous. No download or retry was attempted.`
The cache is never repaired, downloaded or edited, and no cache hash is hardcoded. This bypasses
npm's CMD shim, which can otherwise invoke bare `node` again. An absent/invalid installation root
uses the observed standard `C:\\Program Files` location. There is no PATH/environment edit, installer,
SDK patch, command shell or extra connection. Other argument tails retain the previous absolute
Node/npm invocation unchanged. Custom/absolute commands, other connectors/platforms and server mode are unchanged.
The existing stdio transport, credentials, cwd and approval policy remain in control.
File existence alone does not prove executable health or Discord recovery. The owner
builds and verifies installed behavior; source tests do not establish Windows acceptance.
Gmail uses a remote HTTPS MCP server, not this Node launcher; OAuth connection alone
does not prove that its catalog was discovered, permitted and registered with the agent.

## Source checks

`node --test packages/daemon/test/diagnostic-command-retirement.node-test.mjs packages/daemon/test/mcp-diagnostics.node-test.mjs`

The checks use inert collaborators and synthetic data. They establish source command
refusal and retained failure behavior, not a live SDK session, native Windows behavior,
Discord recovery, complete typing or permission-engine acceptance. No build, install,
environment replacement, automatic repair or native review authority is implied.
