# Gentle Dot — Design

Gentle Dot is an always-available personal assistant. It floats on the macOS desktop, is summoned from the menu bar or a global shortcut, and is also reachable from a browser. Behind it runs Gentle Shell (Pi + Gentle extensions + Engram), hidden from the user.

Status: design for local development. The VPS deployment is documented, not performed.

## 1. Goals and non-goals

Goals:

- One assistant, always on, reachable from the desktop (floating Dot, menu bar, global shortcut) and from a web page.
- The agent behaves exactly like Gentle Shell: same tools, ODD workflow, skills, and Engram memory. Subagents are off until S25 (their child engines do not load the connector approval guard; §4, Connectors).
- The user never sees Gentle Shell: no Gentle branding, commands, or terminal in the product surface.
- Everything runs locally first; the same daemon can later run on a VPS (HostGator) with Docker.

Non-goals for this version:

- Multi-user accounts, sharing, or teams.
- Calls, Slack, scheduled jobs.
- Pi Durable. Recovery relies on persisted Pi sessions plus Engram (see section 7).
- Actual deployment to HostGator.

## 2. Architecture

```
┌──────────────────────────────┐   ┌───────────────────────────┐
│ Desktop app (Tauri 2, macOS) │   │ Browser                   │
│  tray icon · floating Dot ·  │   │  http://127.0.0.1:4317    │
│  global shortcut · webview   │   │  (same React UI)          │
└──────────────┬───────────────┘   └─────────────┬─────────────┘
               └────── WebSocket /ws + token ────┘
                              │
┌─────────────────────────────▼─────────────────────────────────┐
│ dot-daemon (Node 24)                                          │
│  gateway: HTTP (static UI, /health) + WebSocket protocol v1   │
│  white-label layer: identity prompt, event sanitizer          │
│  agent supervisor: spawns and restarts the agent process      │
└─────────────────────────────┬─────────────────────────────────┘
                              │ stdin/stdout JSONL (Pi RPC)
┌─────────────────────────────▼─────────────────────────────────┐
│ gentle-shell --mode rpc --session-dir ~/.gentle-dot/sessions  │
│  Pi + Gentle extensions + Engram (unchanged, configured auth) │
└───────────────────────────────────────────────────────────────┘
```

Repository layout (pnpm workspace):

```
packages/protocol   shared TypeScript types for protocol v1 (client <-> daemon)
packages/daemon     supervisor, gateway, white-label layer, CLI `gentle-dot`
packages/ui         React + Vite web UI (served by the daemon, embedded by Tauri)
apps/desktop        Tauri 2 shell (Rust) for macOS
docs/               design, deployment guide, security checklist
```

### Why these choices

- **Pi RPC subprocess, not the SDK in process.** Gentle Shell is a launcher with its own home, auth, and extension loading. Spawning `gentle-shell --mode rpc` reuses all of it unchanged and isolates crashes from the daemon. Verified on 2026-10-08: the RPC process loads the Gentle extensions (82 commands) and answers `get_state`.
- **One daemon, many faces.** The desktop app and the browser are thin clients over the same WebSocket protocol, so the VPS story is "run the same daemon in Docker".
- **Tauri 2.** Native webview (small app), shares the React UI with the web, and has first-class tray, always-on-top windows, and global shortcuts.

## 3. Agent supervisor

- Spawns the bundled engine (`node <gentle-pi>/bin/gentle-shell.mjs --home <dataDir>/agent --mode rpc --session-dir <dataDir>/sessions --append-system-prompt <identity file>`) with `cwd` = the assistant's own workspace, `<dataDir>/workspace`, so the engine never reads a `.pi` project config from the user's home. A custom `workspace` (config or `GENTLE_DOT_WORKSPACE`) is never used as `cwd` and nothing is written there; it is passed as one more `--append-system-prompt` text: "The user's preferred working folder is <path>. Use absolute paths there unless told otherwise."
- Isolation (S12): the child runs with its own `HOME=<dataDir>/home` (0700) and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` under it, plus `GENTLE_PI_CONFIG_HOME=<dataDir>/gentle-ai`. `PATH` is kept, and `GIT_CONFIG_GLOBAL` points at the user's real `~/.gitconfig` when it exists, to keep their git identity. Inherited `PI_CODING_AGENT_DIR`, `GENTLE_PI_AGENT_HOME`, and `GENTLE_SHELL_CONFIG` are removed. `GENTLE_PI_AGENTS=0` turns Gentle Shell's subagents off (no `subagent_*` or `orchestrator_*` tools) until S25. The engine's first run otherwise writes into the real `~` (`~/.gentle-shell`, `~/.pi/agent/pi-pretty`, `~/.gentle-ai`), which `--home` alone does not prevent.
- Memory (S23): the engine uses the user's global Engram, always in the project `gentle-dot`. The memory plugin accepts a server only when `engram instance-id` (read from the Engram data folder, by default `$HOME/.engram`) matches the server's `/health` `instance_id`, so the child gets `ENGRAM_DATA_DIR=<real ~/.engram>` (the inherited `ENGRAM_DATA_DIR` when set; override `GENTLE_DOT_ENGRAM_DATA_DIR`) and keeps the user's own `ENGRAM_PORT` and `ENGRAM_URL` (default server 7437). If the global Engram is not running, the plugin starts it with that data folder, as Gentle Shell does. The project comes from Engram's per-folder setting: the daemon writes `<dataDir>/workspace/.engram/config.json` (`{"project_name":"gentle-dot"}`) at every start, and Engram reads it before any other detection (source `config`). The plugin has no per-client project override (`ENGRAM_PROJECT` only applies to the Engram process itself, which is the user's shared server). Memories the assistant saved earlier in its private memory (`<dataDir>/home/.engram`) are not moved. `GENTLE_DOT_ENGRAM=private` restores a private memory: no `ENGRAM_DATA_DIR`, `ENGRAM_URL` removed, `ENGRAM_PORT=7438` (override `GENTLE_DOT_ENGRAM_PORT`), data under `<dataDir>/home/.engram`. The memory server the engine starts there outlives the engine, so when nothing listened on the private port as the daemon started, the daemon stops it when it closes: the PID listening on that port (`lsof`), only when its `/health` `instance_id` matches `<dataDir>/home/.engram/.instance-id`.
- Connectors (S18): before every spawn (first start, restart, respawn) the supervisor's `prepareSpawn` hook puts back the connector files from the daemon's in-memory state (§4, Connectors), then hands the approval guard its policy, also from memory, in the child's environment (`GENTLE_DOT_CONNECTOR_POLICY`, JSON: the turned-on connectors, their modes and curated read-only tools, and the protected files). The engine cannot change its own environment, so the policy cannot be edited by the assistant. The assistant's own engine loads the guard with `-e packages/daemon/src/extensions/approval-guard.ts` (TypeScript loads as is).
- Parses stdout with strict LF framing on a byte stream. Never Node `readline` (it splits on U+2028/U+2029, which are valid inside JSON).
- Correlates commands by `id`; stdout records without `id` are session events.
- Reads stderr only as diagnostics (logged, never parsed).
- On unexpected exit: state `restarting`, exponential backoff (1s, 2s, 4s, max 30s), then respawn and `switch_session` to the last active session file.
- On daemon shutdown: closes child stdin, waits up to 5s, then SIGTERM.
- The executable is configurable (`GENTLE_DOT_AGENT_BIN`) so tests can use a fake agent that speaks the same JSONL protocol.

## 4. Protocol v1 (client <-> daemon)

Transport: WebSocket at `/ws`. The first message must be `{"type":"hello","token":"…","protocol":1}`; otherwise the socket closes with code 4401.

Client to daemon:

| type | fields | maps to Pi RPC |
|---|---|---|
| `send` | `text`, `requestId` | `prompt` (with `streamingBehavior: "steer"` while busy); a repeated `requestId` is ignored |
| `steer` | `text` | `steer` |
| `abort` | — | `abort` |
| `ui_response` | `requestId`, `value` \| `confirmed` \| `cancelled` | `extension_ui_response` |
| `new_conversation` | — | `new_session`; refused with `conversations_off` unless the conversations list is on |
| `list_conversations` | — | daemon reads the session dir |
| `open_conversation` | `conversationId` | `switch_session`; refused with `conversations_off` unless the conversations list is on |
| `get_history` | — | daemon reads the chat's session files (one `get_state` round trip first); waits for the agent to be ready instead of failing |
| `get_earlier` | `before` (id of the oldest message the window shows) | daemon reads the page before it, from the open session file and then the earlier files of the chain |
| `auth_list` | — | daemon `ModelRuntime.getProviders()` and `getProviderAuthStatus()` |
| `auth_login` | `providerId`, `method` (`oauth` \| `api_key`) | daemon `ModelRuntime.login()`; one flow at a time |
| `auth_reply` | `flowId`, `value` \| `cancelled` | answers the flow's current prompt |
| `auth_logout` | `providerId` | daemon `ModelRuntime.logout()` |
| `connectors_list` | — | daemon `connectors.json` and `mcp-auth.json` key presence |
| `connector_connect` | `connectorId` | adds or turns on the connector (new `mcp.json`, agent restart when idle), then `mcp login` when not signed in |
| `connector_signin` | `connectorId` | `mcp login <id>`; one flow at a time |
| `connector_disconnect` | `connectorId` | turns it off (the sign-in stays); agent restart when idle |
| `connector_mode` | `connectorId`, `mode` (`read_only` \| `read_write`) | new `mcp.json`; agent restart when idle |
| `connector_remove` | `connectorId` | `mcp logout <id>`, then forgets it; agent restart when idle |

Daemon to client:

| type | meaning |
|---|---|
| `ready` | `agentState`, `conversationId`, `model` (display name only), `features` (`conversations`: the list and new conversation are on; default off); the current `queue`, pending asks, and an `interrupted` notice follow it |
| `user_message` | a user message entered from any client |
| `agent_state` | `starting` \| `idle` \| `thinking` \| `working` \| `needs_you` \| `restarting` \| `error` |
| `message_delta` | assistant text delta for message `messageId` |
| `message_done` | final assistant message; `stopped: true` when the user stopped it (Stop, or a switch), `error` with a plain-language explanation when it failed (shown inline in the chat, not as a toast) |
| `queue` | `steering` and `followUp`: the complete lists of messages sent while the assistant works and not taken yet (from Pi's `queue_update`); empty lists clear it, and it is cleared when the run settles or the agent restarts |
| `ask_resolved` | an ask was answered or timed out |
| `conversations` | `conversations` (`id`, `title`, `updatedAt`) and `activeId` |
| `interrupted` | the agent restarted while a run was active |
| `activity` | `messageId` plus sanitized tool activity: `id`, `kind` (`read`, `edit`, `run`, `search`, `memory`, `delegate`, `other`), `title`, `status` |
| `ask` | sanitized `extension_ui_request` dialog: `requestId`, `method` (`select`, `confirm`, `input`, `editor`), `title`, `message`, `options`, `timeoutMs` |
| `toast` | sanitized `notify` |
| `history` | the most recent messages (100 by default, `GENTLE_DOT_HISTORY_PAGE`), `hasEarlier`; messages from earlier sessions of the chat carry `earlier: true`, and the UI draws an "Earlier messages" divider after the last one |
| `earlier` | `before`, one page of `messages` before it, `hasEarlier`; message ids are `s<file index>-<turn>` in the chain |
| `error` | `code`, `message` safe for the user |
| `auth_providers` | providers with `methods`, `oauthName`, `configured`, `source`; `open: true` when the user typed `/login` |
| `auth_prompt` | `flowId`, `kind` (`text`, `secret`, `select`, `manual_code`), `message`, `options` — sent only to the window that started the flow |
| `auth_event` | `auth_url`, `device_code`, `progress`, or `info` |
| `auth_done` | `ok`, plain-language `message` on failure or cancellation |
| `connectors` | `connectors` (`id`, `name`, `reads`, `sends`, `added`, `enabled`, `mode`, `status`: `off` \| `needs_signin` \| `connected` \| `error`); `open: true` when the user typed `/connectors` |

### Sign-in (S10) and own instance (S12)

The daemon runs the Gentle Shell bundled as its `gentle-pi` dependency, with `--home ~/.gentle-dot/agent` and `GENTLE_PI_CONFIG_HOME=~/.gentle-dot/gentle-ai`, so nothing is shared with a Gentle Shell the user may have installed. `/login` is a terminal-only command in Pi, so sign-in runs in the daemon through Pi's `ModelRuntime` on that same home (same `auth.json` format, file locking, mode 0600). Typed answers are never logged. After new credentials, the daemon refreshes every window's account list and restarts the agent once it is idle, so the new models appear. Typing `/login` in the chat opens the accounts screen.

Every daemon message carries `seq` (monotonic per connection) so the UI can detect gaps and request `get_history`.

### Connectors (S18)

- Catalog (`packages/daemon/src/connectors.ts`): Notion `https://mcp.notion.com/mcp`, Linear `https://mcp.linear.app/mcp`, and Atlassian `https://mcp.atlassian.com/v2/mcp`, each remote OAuth with one click; then three guided connectors (L36), each with in-app steps shown before "Connect" and a curated list of read-only tools (fail closed):
  - Discord: the community server `npx -y @pasympa/discord-mcp@2.2.0` (MIT, monthly releases, declares `readOnlyHint` on its tools; Discord has no official server), with the bot token in `env.DISCORD_TOKEN`. The guide covers the application, the bot, the Message Content and Server Members intents, and the invite (scope `bot` with read, send, and react permissions).
  - Slack: the official `https://mcp.slack.com/mcp` (no dynamic client registration) with the user's own Slack app: `oauth.clientId`, an optional `oauth.clientSecret`, and the fixed redirect `http://localhost:38417/callback` (`oauth.callbackUrl`, sent exactly as written). Slack accepts a loopback redirect only with PKCE turned on, which makes the app a public client (refresh tokens last 30 days), so the secret may be left empty; the guide lists the user token scopes.
  - Gmail: the official `https://gmailmcp.googleapis.com/mcp/v1` (Developer Preview) with the user's own Google Cloud project: the Gmail API and Gmail MCP API enabled, the consent screen in testing (refresh tokens last 7 days), and a Web application client with the redirect `http://localhost:38418/callback`; `oauth.scope` asks for `gmail.readonly` and `gmail.compose`. `gmail.compose` can also send mail, so the copy says so: drafting and sending ask for approval each time, and read only hides them. Each guided connector's copy describes only what its guide's permissions allow (Slack: send and schedule messages with `chat:write`; Discord: send messages and reactions).
- Typed values (S18, S19): a connector's `fields` are asked one at a time with sign-in prompts (`auth_prompt` `secret` or `text`, flow id `connector-setup-*`, `optional` when the answer may be empty), in the window that started them. A catalog connector is added only when every required value is there (cancel changes nothing); an approved draft or an import is added first and stays `needs_setup` until its values are typed. The values live in the in-memory state and `connectors.json` (both protected), are written into `mcp.json` in place of `${input:<key>}` placeholders, and are never sent to a window or logged. The engine resolves env values, headers, and `oauth.clientSecret` (a leading `!` runs a shell command and `$NAME` expands), so typed and imported literals are escaped (`$` → `$$`, `!` → `$!`); `clientId`, the command, its arguments, and URLs are used as written. `connector_setup` asks again (a new token). A connector whose value is missing is `needs_setup` and is left out of `mcp.json`.
- Drafts (S19): the approval guard registers `propose_connector({name, description, transport, command?, args?, url?, env_names?, needs_oauth?})`, with secrets by name only. Its result to the model is only "The user will review this connector in the app". The draft travels to the daemon as `ctx.ui.setStatus("gentle-dot:connector-draft", <json>)`: a fire-and-forget record on the engine's own RPC output, which only the daemon reads (the agent's commands cannot write to it, and no file, socket, or key is added that the agent could reach). A typed value (`${input:NAME}`) may only stand for an env value (or an http server's header): anywhere else (the command, its arguments, the URL) it would put the secret into the command line or an address the model chose, so the guard answers the model "Secrets can only go into environment variables." and sends nothing, and the daemon refuses such a draft as well. The daemon checks it (lengths, `https` or loopback URLs, env names, typed values), keeps the newest five (`MAX_CONNECTOR_DRAFTS`; the windows keep the same five and take the waiting list again after each `ready`), and shows every window a card (`connector_draft`) with the command or URL and the secret names. `connector_draft_reply` decides: declining forgets it; approving adds the server (`origin` "Drafted by the assistant"), turned on, read only with every tool hidden (`toolExposure {"*": "hidden"}`, no curated list, so in "Read and send" every call asks), then asks for each secret in the app and signs in when `needs_oauth`. The assistant still cannot write `mcp.json` or run `mcp add` (guard), so the card is the only way in. Residual, as for the rest of the state (S25): `connectors.json` edited while the daemon is not running is loaded at its next start, and it can now hold a server of the user's own (a command).
- Import (S20, `packages/daemon/src/connector-import.ts`): "Import my MCP servers" (`connectors_scan`) reads, never writes, the configs below the user's home (`GENTLE_DOT_IMPORT_HOME` in tests): Claude Desktop (`Library/Application Support/Claude/` and `.config/Claude/claude_desktop_config.json`), Claude Code (`.claude.json` `mcpServers`, its `projects[*].mcpServers`, and each project's `.mcp.json`), Cursor (`.cursor/mcp.json`), VS Code (`User/mcp.json` with `servers` and `inputs`, macOS and Linux), Windsurf (`.codeium/windsurf/mcp_config.json`, `serverUrl`), OpenCode (`.config/opencode/opencode.json`, `mcp` with command arrays and `environment`), and Gentle Shell (`.gentle-shell/agent/mcp.json`). Each entry maps to the engine's schema: `${VAR}` (Claude Code), `${env:VAR}` (VS Code, Cursor, Windsurf), and `{env:VAR}` (OpenCode) become `${VAR}`; `${userHome}` becomes the home folder; a VS Code `${input:id}` becomes a value the user types after the import; everything else is a literal. SSE servers (`type: "sse"`, or an address ending in `/sse`) are listed as not importable. The list (`connector_imports`) shows the name, the source apps, the command or address (`summary`), and env and header names only; values stay in the daemon. The summary, also shown for a custom connector in the Connectors list, is masked by structure, not by a word list: an address (an argument or the server URL, any scheme) keeps its scheme, host, and path, loses its user and password and its fragment, shows its query keys with every value as `•••`, and masks long opaque path segments (20 or more letters, digits, `_`, or `-`, mixing digits or cases); the argument after `--header`/`-H`, the value of `--header=`, and any `Name: value` argument whose name looks like a credential (Authorization, Cookie, `*key*`, `*token*`, `*secret*`, and so on) keep only the name; the argument after a flag named like a credential (`/token|secret|key|pass|auth|cred|bearer/i`) and the value of `name=value` forms of the same are masked; known token prefixes (`ghp_`, `sk-`, `xoxb-`, `AKIA`, `glpat-`, and others) and long opaque words are masked. Values the engine resolves at start are noted before the import (`notes`): "Runs a command on your computer to get this value." for a leading `!` (the command is not shown), and "Reads the environment variable NAME." for `$NAME`/`${NAME}`. Duplicates (the same command without npm versions, or the same URL) of a connector the user has, or of a catalog entry, are marked and cannot be imported. `connector_import` copies the chosen entries with their values into the private state, read only with every tool hidden, and never touches the source files.
- The daemon holds the approved connector state (each connector's `enabled` and `mode`) in memory. It reads `<dataDir>/connectors.json` once, when it starts; after that the state changes only through the Connectors screen. The daemon is the only writer of `connectors.json` and `<agentHome>/mcp.json`, both rendered from memory, atomically, mode 0600. The engine's policy (below) also comes from memory, never from the files. The files are watched (folder watches plus a check every second, because file events on macOS can be missed right after a watch starts), and they are also checked before every agent start and after every run. A change made by anything else is put back, a project `<workspace>/.pi/mcp.json` is removed (a `.pi` link loses the link, never its target), and every window gets "A change to your connectors was blocked." Residual: a change made to the files while the daemon is not running is loaded at its next start; stage 2 (S25) moves enforcement out of the files. Every server is `exposure: "direct"` (the assistant turns codemode off). "Read only" adds `toolExposure: {"*": "hidden", <curated tool>: "direct"}`; the engine prefers exact names over patterns, so an unknown tool stays hidden.
- Sign-in runs the engine's own command line as a separate process, `node <pi-coding-agent>/dist/bundle/cli.js mcp login <id>`, with the agent's isolated environment and `PI_CODING_AGENT_DIR=<agentHome>`. The daemon relays the printed authorization URL (`auth_event` `auth_url`) and offers a `manual_code` prompt: when the browser cannot reach this computer's loopback callback, the user pastes the address it ended on, and the daemon opens it locally only when its origin and path equal the authorization URL's `redirect_uri` and its `state` matches. Cancel stops the process by PID. Flow ids start with `connector-`, so `auth_reply` reaches the right flow; typed and printed text is never logged (URLs are masked).
- Status: `needs_setup` while a typed value is missing; for servers that sign in with OAuth, `connected` when `mcp-auth.json` holds tokens under `mcp__<id>|<url>` (the id with `-` as `_`, like the engine; token values are dropped while parsing) and `needs_signin` otherwise; `connected` for servers with a token or none; `error` after a failed sign-in.
- Approval guard (`packages/daemon/src/extensions/approval-guard.ts`, `tool_call` hook, nested calls included): a connector tool runs without asking only when it declares `readOnlyHint: true` AND it is on the curated list. Anything else asks through `ctx.ui.confirm`: an ask card ("Allow Notion to create pages?") with every argument, key fields first, up to 8,000 characters (beyond that it says "(truncated, N more characters)"), shown in a scrollable block. It is blocked when declined, when no one can answer, or when the connector is "Read only". A server outside the policy is blocked; without a valid policy every connector call asks.
- Credential and control files: `<agentHome>/auth.json`, `mcp-auth.json`, `models.json` (it can hold API keys), `mcp.json`, `<dataDir>/connectors.json`, `<dataDir>/token`, and the guard itself. The file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) are blocked on them by resolved path (any spelling, `@` prefix, case, symlink, or hard link), and `grep` also on any folder that contains one. Commands (`bash`) are blocked when, with quotes, backslashes, and string concatenation removed, they name one of those files (any case; a pattern such as `mcp-a*` counts), the data folder `.gentle-dot`, `PI_CODING_AGENT_DIR`, `security find-generic-password` (or other keychain reads), or `mcp add|login|logout|remove`. The command check is best effort, not a security boundary: the assistant runs as the user with a shell, so a command can always build a name the check does not see. The in-memory connector state above does not depend on it, and stage 2 (S25) moves tokens out of the engine's reach.
- Stage 2 integrity (S25) must cover the user's own servers too. Today `connectors.json` is trusted when the daemon starts, so a file edited while the daemon is not running can add a custom or imported server that runs an arbitrary command, turn it on, claim any `origin` ("Imported from …", "Drafted by the assistant"), and carry env or header values that are not escaped (`!command`, `$NAME`), which the engine runs or expands at the next start. S25's integrity check (state the agent cannot write, or a signature it cannot forge) must cover every field of those entries: command, arguments, URL, env, headers, `enabled`, `mode`, and `origin`.
- Subagents are off in the assistant's engine (`GENTLE_PI_AGENTS=0`, §3): Gentle Shell's subagent child engines get only its own child extensions, not the approval guard, so a child could run connector tools or read credentials unchecked. Turning them back on needs S25 (enforcement in the daemon) or forwarding the guard to child engines.

### Switching and history races (S21)

- Opening or starting another conversation while the assistant answers first asks the user ("Stop and switch" or "Cancel"). The daemon then aborts the run and waits, bounded to 10 s, for it to settle before it sends `new_session` or `switch_session` (abort-then-switch): Pi would otherwise end the run inside the new session. That stop is reported as `stopped`, never as an error.
- A message sent while a switch or a rotation runs waits for it, so it lands in the new session after that session's `history`.
- History replaces what a window shows, so it is read again (up to twice) when a message arrived while it was loading. Pi writes a message to its session file right after announcing it, so the daemon makes one `get_state` round trip before each read.

### One continuous chat (S22)

The UI shows one endless chat: no conversations list, no new conversation, and the header shows the assistant (the rose glyph and "Gentle Dot"). The code and protocol for several conversations stay behind `features.conversations` (`GENTLE_DOT_CONVERSATIONS=1`); with it off, the UI also ignores the menu bar's `dot://new-conversation`. The daemon rotates the session underneath when it grows (§7), and `history` / `get_earlier` read through the chain of session files, so earlier messages, including those before any compaction, stay reachable with "Show earlier".

### Computer control (macOS, S24)

The assistant can see the screen and operate apps through a built-in MCP server that the desktop app serves. macOS only (L59); the web page and a VPS never offer it.

- S24.1 Helper: native Rust inside the Tauri app (`apps/desktop/src-tauri`), never in the daemon or the engine. It serves MCP (JSON-RPC 2.0 over streamable HTTP) on `http://127.0.0.1:<random port>/mcp` and requires `Authorization: Bearer <key>`, a fresh random key per app launch.
- S24.2 Tools: `screenshot`, `click`, `move`, `drag`, `scroll`, `type`, `key`, `open_app`, `list_apps`, `wait`, each with an optional `intent`. Screenshots of the display under the pointer are downscaled to a long edge of 1280 px; coordinates are pixels of the latest screenshot; actions return a fresh one; Gentle Dot's own windows are left out.
- S24.3 Session grant: the first call without a session shows a native dialog ("Allow Gentle Dot to see and control this Mac for 30 minutes?"). A session ends on timeout, Stop, the tray item, or the panic shortcut ⌥⇧Esc, and queued actions are dropped.
- S24.4 Guards: a fixed blocklist (Gentle Dot itself, System Settings, SecurityAgent, loginwindow, Keychain Access, password managers), 10 actions per second, and a native per-action confirmation for risky actions (send, pay, buy, delete, submit, confirm, transfer, and their Spanish equivalents, by Accessibility role and title, by `return` on a default button, or by the declared `intent`).
- S24.5 Permissions: the app reports and requests Accessibility and Screen Recording (`computer_permissions`, `computer_request_permission {kind}`). The Connectors screen shows a built-in "Computer" entry with both statuses, Grant buttons, Check again, the note that debug builds lose the grants on every rebuild (macOS ties them to the code signature), and a note when the current model does not accept images (`ConnectorInfo.noImages`, from the model's `input` in the engine's `get_state` and `set_model` answers).
- S24.6 Visible state: the app emits `computer://state {active, endsAt?, reason?}` (`computer_status` gives the current one). While active, the rose shows the "in control" state (`dot-in_control`, mood `control`: accent rim, steady traveling light) and the panel shows "Controlling your Mac · mm:ss left" with Stop (`computer_stop`).
- S24.7 Wiring: on every connection the desktop panel calls `computer_endpoint` and, when it returns `{url, token}`, sends `computer_register {url, token}` (the protocol accepts only `http://127.0.0.1:<port>/mcp` and a header-safe key). The daemon keeps the endpoint in memory, never in `connectors.json`, and renders `computer: {url, headers: {Authorization: "Bearer <key>"}, exposure: "direct"}` into `mcp.json`, then restarts the engine when idle. The guard's policy lists it under `builtin`, so its tools run without in-engine approval cards. It is removed on `computer_unregister` or when the window that registered it disconnects. The key is never logged or sent to a window: `connectors` lists only a built-in "Computer" entry (`builtin: true`) that the connector messages cannot change or remove, no saved or imported connector can take the name `computer`, and the import scan never offers the helper.
- S24.8 Speed: `batch {steps: [{tool, ...args}], intent?}` runs 1 to 20 steps of `click`, `move`, `drag`, `scroll`, `type`, `key`, `open_app`, or `wait` in one call and returns one screenshot. Each step takes the single tool's path (session and epoch, blocklist, risky confirmation, N1/N2 typing rules, coordinates mapped with the screenshot taken before the batch) and counts as one action for the rate limit; a full window delays the step instead of refusing it. Steps are 100 ms apart (1.5 s after `open_app`) so each step's guards read the screen the previous one left. The batch's `intent` applies to every step on top of the step's own. The first refused, declined, or failed step stops the batch; the error says which steps ran and comes with a fresh screenshot while the session lasts (none after Stop or panic). Malformed batches (empty, over 20, a nested `batch`, `screenshot`, `list_apps`, unknown tools, invalid arguments) run nothing. Actions settle 150 ms before their screenshot (`open_app` 1.5 s); screenshots are JPEG quality 65; debug builds optimize `image`, `zune-*`, and this crate (opt-level 1, because the generic encoder is compiled here).
- S24.9 Yolo mode: in memory only, off at launch. `computer_set_yolo {enabled}` and the tray item "Yolo mode" switch it; turning it on asks a native confirmation ("Turn on yolo mode? Gentle Dot will send, pay, delete, and submit without asking you first, for up to 1 hour. Stop and ⌥⇧Esc still work.", Turn On / Cancel). While on, only the risky-action confirmation is skipped; the grant, blocklist, rate limit, Stop, and panic are unchanged, and Stop or panic end the session, not yolo mode. It turns itself off after 1 hour. `computer://state` and `computer_status` add `yolo` and `yoloEndsAt?`; every switch reports the resulting state, so a declined confirmation flips the UI switch back. Connectors → Computer shows a "Yolo mode" switch, the banner shows "Yolo", and the rose carries a yellow mark (`dot-yolo`).
- S28 The pink glow where the agent acts:
  - What it shows: a pulse on a click, a trail along a drag (drawn on the display where the drag starts), short markers for moves and scrolls, and an outline around the focused element after `type` and `key`, when that element reports a frame (`AXPosition`, `AXSize`, read right after the keys); without one, nothing shows. The glow uses the accent `#f095c8`. It fades about 1.5 s after the last action (1.2 s lit, then a 300 ms fade) and clears at once when the session ends (Stop, panic, timeout). With "Reduce motion" it stays still: no pulse and no trail, only the drag's end.
  - Where the marks come from: once an action's input is posted, `perform` hands a `Mark` (global points and a kind) to the helper's glow sink. Each batch step that runs gets its own mark. A refused, declined, stopped, or failed action or step reports nothing. `open_app`, `wait`, `screenshot`, and `list_apps` report nothing either. The sink only queues the mark on a channel, so no check, order, timing, or result changes; a rig test runs the same calls with and without the sink and compares them.
  - The overlay: a Tauri window `glow` (`index.html?surface=glow`, title `Gentle Dot Glow`). It is transparent, undecorated, not focusable, out of the taskbar, and ignores cursor events. Its NSWindow sits at level 102, above menus, with collection behavior `canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary`. It is ordered in with `orderFrontRegardless` when a session starts, so it never becomes key or activates the app, and ordered out when the session ends. A thread of its own receives the marks and drops any that arrive after the session ended. That thread looks up the display (`CGDisplayBounds`), moves the overlay over the whole display, and emits `computer://glow` to that window only. The UI also ignores marks that come after a `computer://state` without a session.
  - Guards and screenshots: the overlay is a Gentle Dot window covering the display, so pointer-owner resolution skips it by its window number (`kCGWindowNumber`) and nothing else. The panel and the Dot still resolve to Gentle Dot and are refused. When the system-wide Accessibility hit test lands on the overlay while another app owns the window under the point, the risk check hit-tests that app's own element instead (`AXUIElementCreateApplication`). Screenshots leave the overlay out with every other window of our process (ScreenCaptureKit `excludingWindows`). The overlay is on screen for the whole session, so it is in the capture's window list before it draws anything.

Why enforcement lives in the app: everything inside the engine, and the daemon's WebSocket, is within the agent's reach (it has a shell, and with the daemon's access key it could answer its own approval cards, L49). The session grant, panic stop, blocklist, rate limit, and risky-action confirmations therefore run in the helper, behind native dialogs the agent cannot answer, and the in-engine guard adds nothing for these tools. macOS also attributes Accessibility and Screen Recording to the app that holds them, Gentle Dot.app. The key in `mcp.json` only reaches the helper, which still asks the user before anything happens.

### Voice (S30)

The user can talk to the assistant: a mic button in the composer, and spoken replies.

- Where speech becomes text: "Sign in with ChatGPT" cannot transcribe (L88), so voice uses an OpenAI **API key** when one is connected, and the desktop app's own recognizer otherwise. On the desktop the key is preferred when present: the panel records with `MediaRecorder` and sends the audio to the daemon. Without a key it uses the Tauri commands `voice_status`, `voice_start {locale?}`, `voice_stop` → `{text}`, and `voice_cancel`, plus the events `voice://partial {text}`, `voice://level {level}`, and `voice://error {message}` (§9). The web only uses the daemon, and shows the mic only when a key is connected and the page is a secure context (HTTPS or localhost).
- Protocol: `voice_transcribe {requestId, mime, data}` (base64, at most `MAX_VOICE_AUDIO` = 960,000 characters, so the frame stays under the 1 MiB WebSocket limit) → `voice_transcript {requestId, text}`. `voice_speak {requestId, text ≤ 4096}` → `voice_speech {requestId, mime, data}`. A failure answers `voice_unavailable {requestId, reason}`, with the reason in plain words. `ready` and `auth_providers` carry `voice: {transcribe, speak}`, so voice turns on or off as soon as Accounts changes.
- Daemon (`packages/daemon/src/voice.ts`): it reads the key through Pi's ModelRuntime (`AuthRuntime.openAIApiKey`). It returns a key only when the stored `openai` credential is an API key (`checkAuth` type `api_key`), never the ChatGPT token. Transcription is `POST /v1/audio/transcriptions` (multipart, `gpt-4o-mini-transcribe`). Speech is `POST /v1/audio/speech` (`gpt-4o-mini-tts`, voice `alloy`, mp3). The key goes only into the `Authorization` header. Logs carry only the status code, and replies never carry the key or OpenAI's error bodies. 401, 403, 429, other statuses, and network failures each map to their own reason.
- Mic button (S30.4): tap to start and tap to send. While recording, the composer shows the elapsed time, a level meter, the live partial text (desktop recognizer), and ✕. Esc also cancels, and it is handled before the panel's own Esc. Recordings stop on their own at 60 s. The transcript is sent as the user's message and stays in the chat. When voice cannot work, the button is disabled and its tooltip says why (permission, insecure page, no recorder); on the web without a key it is hidden.
- Spoken replies (S30.3): only the reply to a spoken message is read aloud, once the assistant is idle and the reply did not end in an error or Stop. Markdown, code, and links are stripped first. With `voice.speak` the daemon synthesizes it and the UI plays the mp3. Otherwise `speechSynthesis` reads it with a voice in the reply's language (a Spanish/English guess, then the browser language). A speaker toggle in the header mutes it, and the choice is kept in `localStorage` (`gentle-dot-voice-muted`). Starting to talk, or Stop (shown while speaking), cuts the speech.

### Attachments (S31)

The user can send files to the assistant (never the other way, L91).

- Upload (`packages/daemon/src/uploads.ts`): `POST /upload`, one file per request, the raw bytes as the body, the name URI-encoded in `X-File-Name`, and `X-Upload-Id` to add a file to the folder of the message's first file. The access key goes only in `Authorization: Bearer`; a key in the address is ignored. A foreign `Origin` is refused as on the WebSocket, and allowed origins (the desktop app's `tauri://localhost`) get a CORS preflight answer. The answer is `{uploadId, name, size, mime, path}`, with `path` relative to the workspace.
- Storage and limits (S31.3): `<workspace>/uploads/<uploadId>/<name>`, folders 0700 and files 0600, written with `wx`. Names keep only the last path segment, without control or invisible characters, leading dots, or reserved names (`file` when nothing is left), and duplicates become `name (2).ext`. The daemon enforces 25 MB per file and 10 files / 50 MB per message (`ATTACHMENT_LIMITS`) while the bytes arrive: a declared `Content-Length` over the limit is refused before reading, and a refused or broken upload removes its partial file. Nothing is opened or run. The type comes from the first bytes (PNG, JPEG, GIF, WebP, PDF), never from the name. An upload never sent is removed after an hour.
- Sending: `send` takes `attachments: {uploadId, name}[]` (1-10; the text may then be empty). Each upload is sent once; an unknown or used one answers `error attachment_not_found`, and nothing reaches the engine. The bridge appends an `<attachments>` block to the prompt, with one JSON line per file (name, size, type, absolute path). Images up to 3.75 MB (about 5 MB in base64) go to the engine as `images` only when the current model accepts them (`supervisor.modelImages`); otherwise the line says the model cannot see images.
- Display: the block is stored with the message in the session file, so `user_message`, `history`, the queue, and titles show the user's own text, and `attachments: {name, size, mime}[]` become chips. A plain `send` is unchanged.
- UI: a paper-clip button, drag and drop onto the chat, and pasted images add chips (name, size, ✕). The app checks the limits first and explains a refusal on the chip. Files upload on send with `XMLHttpRequest`, for progress, and an upload error stays on its chip with the message kept. In the desktop panel, HTML5 drops need the window's native drag-and-drop handler off (`disable_drag_drop_handler()` on the panel's `WebviewWindowBuilder`).

## 5. White-label layer

- **Identity**: `--append-system-prompt` with `identity.md`: the assistant is "Gentle Dot", a personal assistant; it must not mention Gentle Shell, Pi, el Gentleman, ODD, or Engram by name, and describes them as "my workflow" and "my memory" when needed. It keeps every behavior.
- **Event sanitizer** (`packages/daemon/src/white-label.ts`, unit-tested): rewrites internal names in toasts, ask titles, messages, and options (answers are mapped back to the agent's original option strings), final assistant text, and history. Informational `notify` records are harness chatter and are hidden; warnings and errors are shown. `setStatus`, `setWidget`, `setTitle`, and terminal-only requests are dropped. Tool names map to activity kinds and neutral titles (for example `mem_search` -> `memory` "Checking my notes"). Streamed deltas are not rewritten; the UI replaces them with the final text.
- **Commands**: `gentle:*` slash commands are never exposed, and a message starting with `/gentle:` is refused with `unsupported`; the UI has no command palette in this version.
- **Errors**: provider or process errors become neutral messages; raw details go to the daemon log only.

## 6. User experience

### The Dot (collapsed)

- Our neon rose inside a black circle (S9, L24): a 66 pt disc in a 72 pt transparent window. It is always on top, draggable, snaps to the nearest screen edge, and its position is persisted. Design sheet: `docs/brand/rose-design.html`.
- The rose is inline SVG built from the 178 strokes traced from the logo (`docs/brand/rose-lines.svg` → `packages/ui/src/rose/strokes.ts`, generated by `docs/brand/tools/build-rose-strokes.mjs`). The strokes carry the glow (`#FF2D7A` neon, `#FFD6E8` light core), and a light layer on the 60 longest strokes travels along them.
- The state is shown by motion and glow:
  - `idle`: the outline breathes a soft glow; sparkles twinkle
  - `thinking`: one slow light runs along each stroke
  - `working`: fast lights race through petals, leaves, and stem
  - `needs_you`: the rose pulses brighter, with an amber `!` badge
  - `starting` and `restarting`: dim grey rose with one faint light tracing
  - `error` (unavailable): dim and still
- Only `stroke-dashoffset`, `opacity`, and `filter` animate. With "Reduce motion", nothing moves: the light layer is hidden and the glow stays (stronger while working or waiting for the user).
- Click, the global shortcut `⌥ Space`, or the menu bar item expands it.

### The panel (expanded)

- 420 × 640 px, rounded 20 px, translucent (macOS vibrancy), anchored to the Dot.
- Header (one continuous chat): the rose glyph and "Gentle Dot", then Accounts, Profiles, Connectors (a plug; also `/connectors`), Hide the rose (an eye) and Full screen (desktop panel only), and Hide as 18 px stroke icons with tooltips. With `features.conversations` on, the conversation title, the conversations list, and New conversation return.
- "Show earlier" at the top of the chat loads the previous page; a subtle "Earlier messages" divider marks where the chat's earlier session ends.
- Body: message list with streaming Markdown and code blocks; activity rows are collapsed one-liners grouped under the assistant turn ("Read 3 files · Ran tests").
- Ask cards: when the agent needs the user, an inline card with the question and buttons (select and confirm) or a text field (input and editor). The Dot turns amber until the user answers.
- Composer: multiline, Enter sends, Shift+Enter adds a new line. While the agent works, the composer offers "Stop", and sending a message steers the current run.
- `Esc` collapses back to the Dot; the conversation keeps running. In full screen, `Esc` first restores the panel's size (see §9, Hiding the rose and full screen).

### Menu bar

- Template icon: the hand-drawn rose glyph (`docs/brand/rose-glyph.svg`), with one variant per state: ready, working (dashed outer petals; also used while thinking), needs you (a filled badge dot), and unavailable (dimmed; starting, restarting, and error).
- Menu: Open (`⌥ Space`), Open in browser, Restart assistant, Launch at login (toggle), Quit. New conversation appears after Open only with the conversations list on (`GENTLE_DOT_CONVERSATIONS=1`).

### Web

- The same UI at `http://127.0.0.1:4317`, full-height layout without the orb. The token is passed once through `/#token=…` and stored in `sessionStorage`.

### Visual system

- The panel and the web view follow gentlemanprogramming.com (S15, measured from the live site, L30). Dark only; there is no light theme.
- Tokens (`packages/ui/src/styles.css`):
  - `--bg` `#1a1218`, translucent header `--bg-glass` `rgba(26,18,24,0.82)` with a 12 px blur and a bottom border
  - `--surface` `#20161e`, `--surface-2` `#241822`, `--line` `#342230`
  - `--text` `#f6eff3`, `--muted` `#a78e9b`
  - `--accent` `#f095c8`; the primary button has `0 10px 30px rgba(240,149,200,.3)` and `#1a1218` text (8.60:1; white is 2.13:1)
  - notes: green `#b4e7c7`, red `#ff718f`, yellow `#e0c27a`
  - radii 8 / 12 / 16 px, pills 999 px
- Type: Inter for text, 14/20 body; an uppercase monospace eyebrow (Iosevka Term / JetBrains Mono, 12 px, letter-spacing .12em, accent color); headings in 800 weight with a light-to-pink gradient.
- The rose Dot keeps its own look (S9): neon `#FF2D7A` strokes in a black circle, with the amber `#F5A524` badge.
- Motion: 180 ms ease-out for expand and collapse; the Dot animations respect "Reduce motion".

## 7. Recovery

- Pi sessions persist under `~/.gentle-dot/sessions`, and the daemon reopens the last active one after any restart (`state.json` `sessionFile`).
- Rotation (S22): Pi's auto-compaction keeps the model context bounded, but the session file keeps every entry and grows forever, and detail fades with each summary. After a run settles, when the agent is idle (no run, no compaction, no open ask, no message on its way), the daemon checks the open session file. Past 20 MB (`GENTLE_DOT_ROTATE_BYTES`) or 10 compaction entries (`GENTLE_DOT_ROTATE_COMPACTIONS`), it rotates:
  1. It writes a new session file next to the old one, in Pi's own format (a v3 `session` header with `parentSession`, then one `custom_message` with `customType` `gentle-dot.handoff` and `display: false`). The handoff text is the latest compaction `summary` from the old file, with no extra model call, or, before any compaction, the previous handoff plus the last 12 messages.
  2. It sends `switch_session` to that file and checks that Pi opened it (`get_state` reports it) and that `get_messages` holds the handoff. Pi sends a custom message to the model as user-role context, but it is never a user message, so the chat never shows it.
  3. If Pi did not load it (for example, its session format changed), the daemon deletes nothing, logs it, and sends `new_session` with `parentSession` instead: a fresh session without the handoff, so the user always keeps a working chat. If the handoff file cannot be written, the chat stays in the current session.
  4. `state.json` `chains` maps the new file to the earlier ones (oldest first), so history pages read through them, and every window gets a fresh `history` with the earlier messages marked.
- Rotation never happens while the assistant is busy or an ask is open, and a failure is logged and leaves the current session working.
- After a crash, the turn that was in flight is lost. The conversation history remains, and the UI shows "I was interrupted. Continue?" with a Continue button that sends "Continue where you left off."
- The user's global Engram (project `gentle-dot`) keeps decisions and progress across conversations; the Gentle workflow already consults it when resuming.
- Pi Durable is reconsidered only for unattended or scheduled work.

## 8. Security (local)

- The daemon binds `127.0.0.1` only. A random 256-bit token is stored in `~/.gentle-dot/token` (mode 0600). The desktop app reads it; the browser receives it once by URL fragment.
- WebSocket upgrades check `Origin` against an allowlist (`http://127.0.0.1:4317`, `tauri://localhost`).
- The VPS guide requires HTTPS, a reverse proxy with authentication, and a dedicated Docker container with no access to personal machines.
- The assistant's engine runs as the user with a shell. Its file tools cannot read the token, sign-ins, or connector files, and the connector state lives in the daemon's memory (§4, Connectors), but shell checks are best effort: a determined command can still read what the user's account can read. Stage 2 (S25) moves connector tokens and enforcement into the daemon.

## 9. Desktop shell contract (Tauri 2 <-> UI)

The desktop app bundles the built UI (`packages/ui/dist/app`) as its frontend, so its origin is `tauri://localhost`, which the daemon allows. It has no dock icon (macOS accessory activation policy). It also runs on Linux (S13); the differences are under "Linux" below.

### Windows

| Label | Size | URL | Properties |
|---|---|---|---|
| `dot` | 72 × 72 pt (the rose in a 66 pt black disc) | `index.html?surface=dot` | title `Gentle Dot`; transparent outside the disc, no decorations, always on top, not resizable, skip taskbar, visible on all workspaces, shadow off; placed in logical points |
| `panel` | 420 × 640 | `index.html?surface=panel` (Linux: `&effects=none`) | title `Gentle Dot Panel`; transparent with macOS vibrancy (`HudWindow`), no decorations, always on top, hidden at start, skip taskbar. With `effects=none` the UI sets `data-effects="none"` on `<html>` and paints the panel opaque (`--bg`, no backdrop blur). |
| `glow` (macOS) | the display where the agent acts | `index.html?surface=glow` | title `Gentle Dot Glow`; the computer-control glow overlay (S28, §4): transparent, no decorations, not focusable, ignores cursor events, above menus, on every Space, shown only during a control session. Its own capability allows only `core:event:allow-listen` and `allow-unlisten`; it never connects to the daemon. |

When the panel opens, it is placed next to the Dot on the side with more room, and it stays inside the monitor.

### Rust commands the UI calls (`@tauri-apps/api/core` `invoke`)

| Command | Arguments | Result |
|---|---|---|
| `connection_info` | — | `{ "url": "ws://127.0.0.1:<port>/ws", "token": "…", "webUrl": "http://127.0.0.1:<port>/#token=…" }`, read from `~/.gentle-dot/config.json` and `~/.gentle-dot/token` |
| `toggle_panel` | — | shows and focuses the panel next to the Dot, or hides it |
| `hide_panel` | — | hides the panel |
| `set_dot_state` | `{ "state": AgentState }` | updates the tray tooltip and swaps the tray glyph for the state |
| `rose_hidden` | — | `true` when the user hid the rose |
| `set_rose_hidden` | `{ "hidden": boolean }` | hides or shows the Dot window, saves the choice, emits `dot://rose`; returns the resulting state |
| `set_panel_fullscreen` | `{ "on": boolean }` | fills the work area of the panel's display, or restores the frame before; returns the resulting state |

The Dot drags with `getCurrentWindow().startDragging()` (permission `core:window:allow-start-dragging`). After a drag ends (no move events for 300 ms), Rust snaps the Dot, by its real window size, to the nearest monitor edge with a 12 px margin and saves the position in `~/.gentle-dot/desktop.json`; the next launch restores it, or defaults to the right edge, vertically centered.

### Events Rust emits to the UI (`@tauri-apps/api/event` `listen`)

| Event | Payload | Meaning |
|---|---|---|
| `dot://new-conversation` | — | the tray item "New conversation" was chosen; with the conversations list on, the panel starts a new conversation and opens; in the single chat (default) the UI ignores it |
| `dot://panel-shown` | — | the panel became visible; the UI focuses the composer |
| `dot://rose` | `{ "hidden": boolean }` | the rose was hidden or shown (panel header or tray) |
| `computer://glow` (to `glow` only) | `{ "kind": "click" \| "move" \| "scroll" \| "drag" \| "key", "x", "y", "toX"?, "toY"?, "width"?, "height"? }` in points from the overlay's top-left corner | the agent just acted there (S28); `drag` adds the end point, `key` the focused element's size |

### Menu bar and shortcut

Tray menu: Open (`⌥ Space`), New conversation (only with `GENTLE_DOT_CONVERSATIONS=1`, read like the daemon reads it), Open in browser, Hide the rose / Show the rose, Restart assistant, Launch at login (check item), Quit. The global shortcut `Alt+Space` (configurable as `shortcut` in `config.json`) toggles the panel. Launch at login uses `tauri-plugin-autostart`; Open in browser uses `tauri-plugin-opener` with `webUrl`.

### Hiding the rose and full screen (S26)

- Hide the rose: the tray item "Hide the rose" (relabeled "Show the rose" while hidden) and an eye button in the panel header call `set_rose_hidden`. The choice is saved as `rose_hidden` in `~/.gentle-dot/desktop.json` next to `dot_points`; files without the key load as shown. A hidden rose is still placed at launch, only not shown. The shortcut and the tray's Open never need the Dot: with the rose hidden, the panel opens at the spot where it was last hidden when that is on the display under the pointer, or else at the right edge of that display, vertically centered. Computer control stays visible in the panel banner (and the tray's Yolo mode check) while the rose is hidden.
- Full screen: a header button and ⌘⇧F (Ctrl+Shift+F off macOS) while the panel has focus call `set_panel_fullscreen`. The panel fills the work area of its display (the menu bar and the Dock stay visible) and stays an accessory window, not a separate macOS fullscreen Space. The app remembers the frame before and restores it, kept on a display that still exists. While full screen, the panel is not moved when it opens or the Dot snaps, and the conversation, notes, and composer use a centered column of `--reading-width` (780 px, the web page's column). The web page has no button; it already fills the browser.
- `Esc` in the panel, in order: an `Esc` that something inside the panel already handled (`preventDefault`) is left alone; in full screen it restores the panel; otherwise it hides the panel.

### Second launch and `--toggle`

The app is single-instance (`tauri-plugin-single-instance`; D-Bus on Linux). A second launch hands its arguments to the running app and exits: `--toggle` toggles the panel, anything else shows it. A first launch with `--toggle` opens the panel once the app is up. Desktop shortcuts bind `gentle-dot --toggle` where the app cannot register its own (Wayland).

### Linux

`src/platform.rs` holds the decisions, as pure functions of the environment:

- GNOME on Wayland (Debian, Ubuntu): before GTK starts, the app sets `GDK_BACKEND=x11` when the session is Wayland, the desktop is not Hyprland (`HYPRLAND_INSTANCE_SIGNATURE`, or `Hyprland` in `XDG_CURRENT_DESKTOP`), `DISPLAY` is set (XWayland), and `GDK_BACKEND` is unset. Under XWayland the app places, raises, and snaps its windows as on macOS. The `Alt+Space` grab only sees keys while an X11 window has focus, so the documented shortcut is a GNOME custom shortcut running `gentle-dot --toggle`.
- Native Wayland (Hyprland on Omarchy, or a user-chosen `GDK_BACKEND=wayland`): the compositor places windows, so the app skips restoring and snapping the Dot, skips placing the panel, and does not register the global shortcut. Hyprland window rules matched by title float and pin both windows and place them; a `bind` runs `gentle-dot --toggle` (`scripts/linux/hyprland/`, in `hyprland.lua` and `hyprland.conf` forms).
- Window sizes: GTK sizes a non-resizable window to its content (the Dot came out 200 × 200 in an X11 test), so on Linux the Dot is resizable with equal minimum and maximum sizes of 72 × 72. A panel that was never shown reports 0 × 0, so placement uses the fixed `PANEL_SIZE`.
- Tray: Linux trays do not tint template images, so `icons/tray/linux/` holds 32 px glyphs in light gray over a dark outline; GNOME shows them through the AppIndicator extension.
- Delivery is from source (`scripts/linux/setup-debian.sh`, `setup-arch.sh`), because `build.rs` records the build machine's paths. Tester checklist: `docs/linux-testing.md`.

### Daemon lifecycle

On launch, the app checks `GET /health`. If the daemon does not answer, the app spawns it: `<node> <repo>/packages/daemon/src/cli.ts`, with the `PATH` captured at build time (apps launched from Finder get a minimal `PATH`, and the daemon needs `gentle-shell`). `build.rs` records the absolute `node` path, the daemon script path, and `PATH`; `GENTLE_DOT_NODE` and `GENTLE_DOT_DAEMON_SCRIPT` override them at runtime. A daemon spawned by the app is stopped on Quit. Restart assistant restarts a spawned daemon, and reports through a dialog when the daemon was started outside the app. The UI connects only after `/health` answers.

## 10. Configuration

`~/.gentle-dot/config.json`, all optional:

```json
{ "port": 4317, "workspace": "~/Documents", "shortcut": "Alt+Space", "launchAtLogin": false }
```

All keys are optional. `workspace` is the user's preferred working folder: the engine is told about it but always runs in `<dataDir>/workspace`.

Environment overrides: `GENTLE_DOT_AGENT_HOME` (default `~/.gentle-dot/agent`), `GENTLE_DOT_ENGRAM_DATA_DIR` (default: the user's Engram data folder), `GENTLE_DOT_ENGRAM` (`private` for a memory of the assistant's own), `GENTLE_DOT_ENGRAM_PORT` (private memory only, default `7438`), `GENTLE_DOT_PORT`, `GENTLE_DOT_HOST` (default `127.0.0.1`; `0.0.0.0` only inside a container), `GENTLE_DOT_DATA_DIR`, `GENTLE_DOT_WORKSPACE`, `GENTLE_DOT_UI_DIR`, `GENTLE_DOT_AGENT_BIN`, `GENTLE_DOT_AGENT_ARGS` (JSON array), `GENTLE_DOT_ALLOWED_ORIGINS` (JSON array), `GENTLE_DOT_CONVERSATIONS` (`1` turns the conversations list on), `GENTLE_DOT_ROTATE_BYTES` (default 20 MB), `GENTLE_DOT_ROTATE_COMPACTIONS` (default 10), `GENTLE_DOT_HISTORY_PAGE` (default 100), `GENTLE_DOT_MCP_CLI` (JSON array: the command line used for connector sign-in, for tests; default the bundled engine's).
