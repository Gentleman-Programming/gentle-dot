# Gentle Dot

An always-available personal assistant: a floating Dot on the macOS desktop, a menu bar item, a global shortcut (`⌥ Space`), and the same interface in the browser.

Design: [docs/design.md](docs/design.md) · Plan: [odd/tasks/gentle-dot.md](odd/tasks/gentle-dot.md)

## Requirements

- Node.js 24 and pnpm 10
- Nothing else: the assistant brings its own Gentle Shell engine (the `gentle-pi` dependency) and signs in from its Accounts screen
- Rust stable (only for the desktop app)

## Run locally

```bash
pnpm install
pnpm dev          # builds the UI and starts the daemon on http://127.0.0.1:4317
```

On a terminal, the daemon prints a URL that already carries the access key; open it in a browser. When its output goes to a file (the desktop app's `~/.gentle-dot/daemon.log`, or `docker logs`), it prints the URL without the key and says where the key is: `~/.gentle-dot/token`.

## Desktop app (macOS)

```bash
PATH=/opt/homebrew/opt/rustup/bin:$PATH pnpm --filter @gentle-dot/desktop dev
```

The app puts the Dot on the desktop and an item in the menu bar, and `⌥ Space` opens the panel. If the daemon is not running, the app starts it. See [apps/desktop/README.md](apps/desktop/README.md).

## Server

`Dockerfile` and `compose.yaml` run the same daemon on a VPS behind HTTPS. See [docs/deploy-vps.md](docs/deploy-vps.md).

## How it works

The daemon starts the agent (`gentle-shell --mode rpc`) as a child process and gives it the Gentle Dot identity. It restarts the agent if it crashes, reopening the same conversation, and translates its events into a small WebSocket protocol for the desktop and web interfaces. You get one continuous chat: when its session grows too large, the daemon quietly continues it in a fresh session seeded with a summary, and earlier messages stay one "Show earlier" away (set `GENTLE_DOT_CONVERSATIONS=1` for several conversations). Sessions live in `~/.gentle-dot/sessions`; the access key is in `~/.gentle-dot/token`, and `~/.gentle-dot` is private to your user (mode 0700).

The assistant keeps to its own instance. The agent works in `~/.gentle-dot/workspace` and runs with its own home folder (`~/.gentle-dot/home`), so it never writes to your own Gentle Shell or Pi setup. To point it at a folder of yours, set `GENTLE_DOT_WORKSPACE` or `"workspace"` in `~/.gentle-dot/config.json`: the agent is told to work there, but nothing is written into that folder for setup. It keeps `PATH` and reads your `~/.gitconfig` for your git identity.

Memory uses your global Engram (`~/.engram`, server on port 7437, or your own `ENGRAM_DATA_DIR`, `ENGRAM_PORT`, and `ENGRAM_URL`), and everything the assistant remembers goes to the project `gentle-dot`. If Engram is not running, the assistant starts it with your data folder. `GENTLE_DOT_ENGRAM_DATA_DIR` points at another data folder; `GENTLE_DOT_ENGRAM=private` gives the assistant a memory of its own instead (port 7438, `GENTLE_DOT_ENGRAM_PORT`). Memories saved by earlier versions in `~/.gentle-dot/home/.engram` are not moved to the global Engram.

Connectors let the assistant use Notion, Linear, and Atlassian through their official MCP servers: open Connectors (the plug icon, or type `/connectors`), choose Connect, and approve access in the browser. Discord, Slack, and Gmail show a step-by-step guide first: Discord runs a community server (`@pasympa/discord-mcp`, pinned) with a bot token you create; Slack and Gmail use their official servers with an app or Google Cloud project of your own, whose redirect address the guide shows. "Add another connector" asks the assistant in the chat; it answers with a draft card that lists the command or address and the secrets it needs, and nothing is added until you approve it. "Import my MCP servers" reads (only reads) the configs of Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, OpenCode, and Gentle Shell, and lists what it found by name; you pick which to copy. Secrets are always typed in the app, never in the chat, and drafted or imported servers start read only with all of their tools hidden. Each connector is "Read only" (it can search and read) or "Read and send"; even then, the assistant asks you with a preview before every action that sends or changes something. The daemon reads `~/.gentle-dot/connectors.json` once when it starts and keeps your choices in memory; it alone writes that file and the engine's `mcp.json` (`~/.gentle-dot/agent`), and if anything else changes them while it runs, it puts them back and tells you "A change to your connectors was blocked." The assistant cannot read your sign-ins and keys with its file tools; its shell commands are checked too, but that check is best effort, not a security boundary.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test         # unit and integration tests (fake agent)
pnpm e2e          # Playwright against the daemon with the fake agent
```

Tests tagged `@real-agent` start the real `gentle-shell`; they are skipped when it is not installed.

To check that a first start writes nothing outside the assistant's instance and that memory goes to the global Engram in the project `gentle-dot` (it uses a temporary stand-in Engram, never yours; it installs the engine's companion packages, so it needs internet access, `engram`, and `lsof`):

```bash
GENTLE_DOT_ISOLATION_PROBE=1 npx vitest run packages/daemon/test/isolation-probe.test.ts
```
