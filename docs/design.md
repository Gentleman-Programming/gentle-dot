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

- Catalog (`packages/daemon/src/connectors.ts`): Notion `https://mcp.notion.com/mcp`, Linear `https://mcp.linear.app/mcp`, and Atlassian `https://mcp.atlassian.com/v2/mcp`, each remote OAuth, with a curated list of read-only tools. Slack, Gmail, Discord, assistant-drafted servers (S19), and imports (S20) add catalog entries or drafts that go through the same store.
- The daemon holds the approved connector state (each connector's `enabled` and `mode`) in memory. It reads `<dataDir>/connectors.json` once, when it starts; after that the state changes only through the Connectors screen. The daemon is the only writer of `connectors.json` and `<agentHome>/mcp.json`, both rendered from memory, atomically, mode 0600. The engine's policy (below) also comes from memory, never from the files. The files are watched (folder watches plus a check every second, because file events on macOS can be missed right after a watch starts), and they are also checked before every agent start and after every run. A change made by anything else is put back, a project `<workspace>/.pi/mcp.json` is removed (a `.pi` link loses the link, never its target), and every window gets "A change to your connectors was blocked." Residual: a change made to the files while the daemon is not running is loaded at its next start; stage 2 (S25) moves enforcement out of the files. Every server is `exposure: "direct"` (the assistant turns codemode off). "Read only" adds `toolExposure: {"*": "hidden", <curated tool>: "direct"}`; the engine prefers exact names over patterns, so an unknown tool stays hidden.
- Sign-in runs the engine's own command line as a separate process, `node <pi-coding-agent>/dist/bundle/cli.js mcp login <id>`, with the agent's isolated environment and `PI_CODING_AGENT_DIR=<agentHome>`. The daemon relays the printed authorization URL (`auth_event` `auth_url`) and offers a `manual_code` prompt: when the browser cannot reach this computer's loopback callback, the user pastes the address it ended on, and the daemon opens it locally only when its origin and path equal the authorization URL's `redirect_uri` and its `state` matches. Cancel stops the process by PID. Flow ids start with `connector-`, so `auth_reply` reaches the right flow; typed and printed text is never logged (URLs are masked).
- Status: `connected` when `mcp-auth.json` holds tokens under `mcp__<id>|<url>` (token values are dropped while parsing); `needs_signin` otherwise; `error` after a failed sign-in.
- Approval guard (`packages/daemon/src/extensions/approval-guard.ts`, `tool_call` hook, nested calls included): a connector tool runs without asking only when it declares `readOnlyHint: true` AND it is on the curated list. Anything else asks through `ctx.ui.confirm`: an ask card ("Allow Notion to create pages?") with every argument, key fields first, up to 8,000 characters (beyond that it says "(truncated, N more characters)"), shown in a scrollable block. It is blocked when declined, when no one can answer, or when the connector is "Read only". A server outside the policy is blocked; without a valid policy every connector call asks.
- Credential and control files: `<agentHome>/auth.json`, `mcp-auth.json`, `models.json` (it can hold API keys), `mcp.json`, `<dataDir>/connectors.json`, `<dataDir>/token`, and the guard itself. The file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) are blocked on them by resolved path (any spelling, `@` prefix, case, symlink, or hard link), and `grep` also on any folder that contains one. Commands (`bash`) are blocked when, with quotes, backslashes, and string concatenation removed, they name one of those files (any case; a pattern such as `mcp-a*` counts), the data folder `.gentle-dot`, `PI_CODING_AGENT_DIR`, `security find-generic-password` (or other keychain reads), or `mcp add|login|logout|remove`. The command check is best effort, not a security boundary: the assistant runs as the user with a shell, so a command can always build a name the check does not see. The in-memory connector state above does not depend on it, and stage 2 (S25) moves tokens out of the engine's reach.
- Subagents are off in the assistant's engine (`GENTLE_PI_AGENTS=0`, §3): Gentle Shell's subagent child engines get only its own child extensions, not the approval guard, so a child could run connector tools or read credentials unchecked. Turning them back on needs S25 (enforcement in the daemon) or forwarding the guard to child engines.

### Switching and history races (S21)

- Opening or starting another conversation while the assistant answers first asks the user ("Stop and switch" or "Cancel"). The daemon then aborts the run and waits, bounded to 10 s, for it to settle before it sends `new_session` or `switch_session` (abort-then-switch): Pi would otherwise end the run inside the new session. That stop is reported as `stopped`, never as an error.
- A message sent while a switch or a rotation runs waits for it, so it lands in the new session after that session's `history`.
- History replaces what a window shows, so it is read again (up to twice) when a message arrived while it was loading. Pi writes a message to its session file right after announcing it, so the daemon makes one `get_state` round trip before each read.

### One continuous chat (S22)

The UI shows one endless chat: no conversations list, no new conversation, and the header shows the assistant (the rose glyph and "Gentle Dot"). The code and protocol for several conversations stay behind `features.conversations` (`GENTLE_DOT_CONVERSATIONS=1`); with it off, the UI also ignores the menu bar's `dot://new-conversation`. The daemon rotates the session underneath when it grows (§7), and `history` / `get_earlier` read through the chain of session files, so earlier messages, including those before any compaction, stay reachable with "Show earlier".

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
- Header (one continuous chat): the rose glyph and "Gentle Dot", then Accounts, Profiles, Connectors (a plug; also `/connectors`), and Hide as 18 px stroke icons with tooltips. With `features.conversations` on, the conversation title, the conversations list, and New conversation return.
- "Show earlier" at the top of the chat loads the previous page; a subtle "Earlier messages" divider marks where the chat's earlier session ends.
- Body: message list with streaming Markdown and code blocks; activity rows are collapsed one-liners grouped under the assistant turn ("Read 3 files · Ran tests").
- Ask cards: when the agent needs the user, an inline card with the question and buttons (select and confirm) or a text field (input and editor). The Dot turns amber until the user answers.
- Composer: multiline, Enter sends, Shift+Enter adds a new line. While the agent works, the composer offers "Stop", and sending a message steers the current run.
- `Esc` collapses back to the Dot; the conversation keeps running.

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

The desktop app bundles the built UI (`packages/ui/dist/app`) as its frontend, so its origin is `tauri://localhost`, which the daemon allows. It has no dock icon (macOS accessory activation policy).

### Windows

| Label | Size | URL | Properties |
|---|---|---|---|
| `dot` | 72 × 72 pt (the rose in a 66 pt black disc) | `index.html?surface=dot` | transparent outside the disc, no decorations, always on top, not resizable, skip taskbar, visible on all workspaces, shadow off; placed in logical points |
| `panel` | 420 × 640 | `index.html?surface=panel` | transparent with macOS vibrancy (`HudWindow`), no decorations, always on top, hidden at start, skip taskbar |

When the panel opens, it is placed next to the Dot on the side with more room, and it stays inside the monitor.

### Rust commands the UI calls (`@tauri-apps/api/core` `invoke`)

| Command | Arguments | Result |
|---|---|---|
| `connection_info` | — | `{ "url": "ws://127.0.0.1:<port>/ws", "token": "…", "webUrl": "http://127.0.0.1:<port>/#token=…" }`, read from `~/.gentle-dot/config.json` and `~/.gentle-dot/token` |
| `toggle_panel` | — | shows and focuses the panel next to the Dot, or hides it |
| `hide_panel` | — | hides the panel |
| `set_dot_state` | `{ "state": AgentState }` | updates the tray tooltip and swaps the tray glyph for the state |

The Dot drags with `getCurrentWindow().startDragging()` (permission `core:window:allow-start-dragging`). After a drag ends (no move events for 300 ms), Rust snaps the Dot, by its real window size, to the nearest monitor edge with a 12 px margin and saves the position in `~/.gentle-dot/desktop.json`; the next launch restores it, or defaults to the right edge, vertically centered.

### Events Rust emits to the UI (`@tauri-apps/api/event` `listen`)

| Event | Payload | Meaning |
|---|---|---|
| `dot://new-conversation` | — | the tray item "New conversation" was chosen; with the conversations list on, the panel starts a new conversation and opens; in the single chat (default) the UI ignores it |
| `dot://panel-shown` | — | the panel became visible; the UI focuses the composer |

### Menu bar and shortcut

Tray menu: Open (`⌥ Space`), New conversation (only with `GENTLE_DOT_CONVERSATIONS=1`, read like the daemon reads it), Open in browser, Restart assistant, Launch at login (check item), Quit. The global shortcut `Alt+Space` (configurable as `shortcut` in `config.json`) toggles the panel. Launch at login uses `tauri-plugin-autostart`; Open in browser uses `tauri-plugin-opener` with `webUrl`.

### Daemon lifecycle

On launch, the app checks `GET /health`. If the daemon does not answer, the app spawns it: `<node> <repo>/packages/daemon/src/cli.ts`, with the `PATH` captured at build time (apps launched from Finder get a minimal `PATH`, and the daemon needs `gentle-shell`). `build.rs` records the absolute `node` path, the daemon script path, and `PATH`; `GENTLE_DOT_NODE` and `GENTLE_DOT_DAEMON_SCRIPT` override them at runtime. A daemon spawned by the app is stopped on Quit. Restart assistant restarts a spawned daemon, and reports through a dialog when the daemon was started outside the app. The UI connects only after `/health` answers.

## 10. Configuration

`~/.gentle-dot/config.json`, all optional:

```json
{ "port": 4317, "workspace": "~/Documents", "shortcut": "Alt+Space", "launchAtLogin": false }
```

All keys are optional. `workspace` is the user's preferred working folder: the engine is told about it but always runs in `<dataDir>/workspace`.

Environment overrides: `GENTLE_DOT_AGENT_HOME` (default `~/.gentle-dot/agent`), `GENTLE_DOT_ENGRAM_DATA_DIR` (default: the user's Engram data folder), `GENTLE_DOT_ENGRAM` (`private` for a memory of the assistant's own), `GENTLE_DOT_ENGRAM_PORT` (private memory only, default `7438`), `GENTLE_DOT_PORT`, `GENTLE_DOT_HOST` (default `127.0.0.1`; `0.0.0.0` only inside a container), `GENTLE_DOT_DATA_DIR`, `GENTLE_DOT_WORKSPACE`, `GENTLE_DOT_UI_DIR`, `GENTLE_DOT_AGENT_BIN`, `GENTLE_DOT_AGENT_ARGS` (JSON array), `GENTLE_DOT_ALLOWED_ORIGINS` (JSON array), `GENTLE_DOT_CONVERSATIONS` (`1` turns the conversations list on), `GENTLE_DOT_ROTATE_BYTES` (default 20 MB), `GENTLE_DOT_ROTATE_COMPACTIONS` (default 10), `GENTLE_DOT_HISTORY_PAGE` (default 100), `GENTLE_DOT_MCP_CLI` (JSON array: the command line used for connector sign-in, for tests; default the bundled engine's).
