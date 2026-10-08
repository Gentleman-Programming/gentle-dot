# Gentle Dot — Design

Gentle Dot is an always-available personal assistant. It floats on the macOS desktop, is summoned from the menu bar or a global shortcut, and is also reachable from a browser. Behind it runs Gentle Shell (Pi + Gentle extensions + Engram), hidden from the user.

Status: design for local development. The VPS deployment is documented, not performed.

## 1. Goals and non-goals

Goals:

- One assistant, always on, reachable from the desktop (floating Dot, menu bar, global shortcut) and from a web page.
- The agent behaves exactly like Gentle Shell: same tools, ODD workflow, subagents, skills, and Engram memory.
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

- Spawns `gentle-shell --mode rpc --session-dir <dataDir>/sessions --append-system-prompt <identity file>` with `cwd` = configured workspace (default: home directory).
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
| `new_conversation` | — | `new_session` |
| `list_conversations` | — | daemon reads the session dir |
| `open_conversation` | `conversationId` | `switch_session` |
| `get_history` | — | `get_messages` |

Daemon to client:

| type | meaning |
|---|---|
| `ready` | `agentState`, `conversationId`, `model` (display name only); pending asks and an `interrupted` notice follow it |
| `user_message` | a user message entered from any client |
| `agent_state` | `starting` \| `idle` \| `thinking` \| `working` \| `needs_you` \| `restarting` \| `error` |
| `message_delta` | assistant text delta for message `messageId` |
| `message_done` | final assistant message |
| `ask_resolved` | an ask was answered or timed out |
| `conversations` | `conversations` (`id`, `title`, `updatedAt`) and `activeId` |
| `interrupted` | the agent restarted while a run was active |
| `activity` | `messageId` plus sanitized tool activity: `id`, `kind` (`read`, `edit`, `run`, `search`, `memory`, `delegate`, `other`), `title`, `status` |
| `ask` | sanitized `extension_ui_request` dialog: `requestId`, `method` (`select`, `confirm`, `input`, `editor`), `title`, `message`, `options`, `timeoutMs` |
| `toast` | sanitized `notify` |
| `history` | conversation messages for rendering |
| `error` | `code`, `message` safe for the user |

Every daemon message carries `seq` (monotonic per connection) so the UI can detect gaps and request `get_history`.

## 5. White-label layer

- **Identity**: `--append-system-prompt` with `identity.md`: the assistant is "Gentle Dot", a personal assistant; it must not mention Gentle Shell, Pi, el Gentleman, ODD, or Engram by name, and describes them as "my workflow" and "my memory" when needed. It keeps every behavior.
- **Event sanitizer** (`packages/daemon/src/white-label.ts`, unit-tested): rewrites internal names in toasts, ask titles, messages, and options (answers are mapped back to the agent's original option strings), final assistant text, and history. Informational `notify` records are harness chatter and are hidden; warnings and errors are shown. `setStatus`, `setWidget`, `setTitle`, and terminal-only requests are dropped. Tool names map to activity kinds and neutral titles (for example `mem_search` -> `memory` "Checking my notes"). Streamed deltas are not rewritten; the UI replaces them with the final text.
- **Commands**: `gentle:*` slash commands are never exposed, and a message starting with `/gentle:` is refused with `unsupported`; the UI has no command palette in this version.
- **Errors**: provider or process errors become neutral messages; raw details go to the daemon log only.

## 6. User experience

### The Dot (collapsed)

- A 56 px circular orb, always on top, draggable, snaps to the nearest screen edge; position is persisted.
- The state is shown by motion and color:
  - `idle`: slow breathing glow
  - `thinking`: orbiting particle
  - `working`: steady pulse with a small kind icon
  - `needs_you`: amber ring with a badge
  - `restarting` and `error`: grey and red ring
- Click, the global shortcut `⌥ Space`, or the menu bar item expands it.

### The panel (expanded)

- 420 × 640 px, rounded 20 px, translucent (macOS vibrancy), anchored to the Dot.
- Header: conversation title, new-conversation button, conversations list, collapse.
- Body: message list with streaming Markdown and code blocks; activity rows are collapsed one-liners grouped under the assistant turn ("Read 3 files · Ran tests").
- Ask cards: when the agent needs the user, an inline card with the question and buttons (select and confirm) or a text field (input and editor). The Dot turns amber until the user answers.
- Composer: multiline, Enter sends, Shift+Enter adds a new line. While the agent works, the composer offers "Stop", and sending a message steers the current run.
- `Esc` collapses back to the Dot; the conversation keeps running.

### Menu bar

- Template icon with a state dot.
- Menu: Open (`⌥ Space`), New conversation, Open in browser, Restart assistant, Launch at login (toggle), Quit.

### Web

- The same UI at `http://127.0.0.1:4317`, full-height layout without the orb. The token is passed once through `/#token=…` and stored in `sessionStorage`.

### Visual system

- Dark-first, with a light theme that follows the system setting.
- Tokens:
  - `--bg` `#0E0F13`
  - `--surface` `rgba(28,30,38,0.72)`
  - `--text` `#ECEDEF`
  - `--muted` `#8A8F98`
  - `--accent` `#7C5CFF`
  - `--amber` `#F5A524`
  - `--danger` `#F0506E`
- Type: system UI (SF Pro), 14/20 body, 12/16 meta; monospace SF Mono for code.
- Motion: 180 ms ease-out for expand and collapse; the Dot animations respect "Reduce motion".

## 7. Recovery

- Pi sessions persist under `~/.gentle-dot/sessions`, and the daemon reopens the last active one after any restart.
- After a crash, the turn that was in flight is lost. The conversation history remains, and the UI shows "I was interrupted. Continue?" with a Continue button that sends "Continue where you left off."
- Engram keeps decisions and progress across conversations; the Gentle workflow already consults it when resuming.
- Pi Durable is reconsidered only for unattended or scheduled work.

## 8. Security (local)

- The daemon binds `127.0.0.1` only. A random 256-bit token is stored in `~/.gentle-dot/token` (mode 0600). The desktop app reads it; the browser receives it once by URL fragment.
- WebSocket upgrades check `Origin` against an allowlist (`http://127.0.0.1:4317`, `tauri://localhost`).
- The VPS guide requires HTTPS, a reverse proxy with authentication, and a dedicated Docker container with no access to personal machines.

## 9. Desktop shell contract (Tauri 2 <-> UI)

The desktop app bundles the built UI (`packages/ui/dist/app`) as its frontend, so its origin is `tauri://localhost`, which the daemon allows. It has no dock icon (macOS accessory activation policy).

### Windows

| Label | Size | URL | Properties |
|---|---|---|---|
| `dot` | 56 × 56 | `index.html?surface=dot` | transparent, no decorations, always on top, not resizable, skip taskbar, visible on all workspaces, shadow off |
| `panel` | 420 × 640 | `index.html?surface=panel` | transparent with macOS vibrancy (`HudWindow`), no decorations, always on top, hidden at start, skip taskbar |

When the panel opens, it is placed next to the Dot on the side with more room, and it stays inside the monitor.

### Rust commands the UI calls (`@tauri-apps/api/core` `invoke`)

| Command | Arguments | Result |
|---|---|---|
| `connection_info` | — | `{ "url": "ws://127.0.0.1:<port>/ws", "token": "…", "webUrl": "http://127.0.0.1:<port>/#token=…" }`, read from `~/.gentle-dot/config.json` and `~/.gentle-dot/token` |
| `toggle_panel` | — | shows and focuses the panel next to the Dot, or hides it |
| `hide_panel` | — | hides the panel |
| `set_dot_state` | `{ "state": AgentState }` | updates the tray icon tooltip and title marker |

The Dot drags with `getCurrentWindow().startDragging()` (permission `core:window:allow-start-dragging`). After a drag ends (no move events for 300 ms), Rust snaps the Dot to the nearest monitor edge with a 12 px margin and saves the position in `~/.gentle-dot/desktop.json`; the next launch restores it, or defaults to the right edge, vertically centered.

### Events Rust emits to the UI (`@tauri-apps/api/event` `listen`)

| Event | Payload | Meaning |
|---|---|---|
| `dot://new-conversation` | — | the tray item "New conversation" was chosen; the panel starts a new conversation and opens |
| `dot://panel-shown` | — | the panel became visible; the UI focuses the composer |

### Menu bar and shortcut

Tray menu: Open (`⌥ Space`), New conversation, Open in browser, Restart assistant, Launch at login (check item), Quit. The global shortcut `Alt+Space` (configurable as `shortcut` in `config.json`) toggles the panel. Launch at login uses `tauri-plugin-autostart`; Open in browser uses `tauri-plugin-opener` with `webUrl`.

### Daemon lifecycle

On launch, the app checks `GET /health`. If the daemon does not answer, the app spawns it: `<node> <repo>/packages/daemon/src/cli.ts`, with the `PATH` captured at build time (apps launched from Finder get a minimal `PATH`, and the daemon needs `gentle-shell`). `build.rs` records the absolute `node` path, the daemon script path, and `PATH`; `GENTLE_DOT_NODE` and `GENTLE_DOT_DAEMON_SCRIPT` override them at runtime. A daemon spawned by the app is stopped on Quit. Restart assistant restarts a spawned daemon, and reports through a dialog when the daemon was started outside the app. The UI connects only after `/health` answers.

## 10. Configuration

`~/.gentle-dot/config.json`, all optional:

```json
{ "port": 4317, "workspace": "~", "shortcut": "Alt+Space", "launchAtLogin": false }
```

Environment overrides: `GENTLE_DOT_PORT`, `GENTLE_DOT_HOST` (default `127.0.0.1`; `0.0.0.0` only inside a container), `GENTLE_DOT_DATA_DIR`, `GENTLE_DOT_WORKSPACE`, `GENTLE_DOT_UI_DIR`, `GENTLE_DOT_AGENT_BIN`, `GENTLE_DOT_AGENT_ARGS` (JSON array), `GENTLE_DOT_ALLOWED_ORIGINS` (JSON array).
