# Gentle Dot

An always-available personal assistant: a floating Dot on the macOS desktop, a menu bar item, a global shortcut (`⌥ Space`), and the same interface in the browser.

Design: [docs/design.md](docs/design.md) · Plan: [odd/tasks/gentle-dot.md](odd/tasks/gentle-dot.md)

## Requirements

- Node.js 24 and pnpm 10
- `gentle-shell` on `PATH` with a configured model provider
- Rust stable (only for the desktop app)

## Run locally

```bash
pnpm install
pnpm dev          # builds the UI and starts the daemon on http://127.0.0.1:4317
```

The daemon prints a URL that already carries the access token. Open it in a browser.

## Desktop app (macOS)

```bash
PATH=/opt/homebrew/opt/rustup/bin:$PATH pnpm --filter @gentle-dot/desktop dev
```

The app puts the Dot on the desktop and an item in the menu bar, and `⌥ Space` opens the panel. If the daemon is not running, the app starts it. See [apps/desktop/README.md](apps/desktop/README.md).

## Server

`Dockerfile` and `compose.yaml` run the same daemon on a VPS behind HTTPS. See [docs/deploy-vps.md](docs/deploy-vps.md).

## How it works

The daemon starts the agent (`gentle-shell --mode rpc`) as a child process and gives it the Gentle Dot identity. It restarts the agent if it crashes, reopening the same conversation, and translates its events into a small WebSocket protocol for the desktop and web interfaces. Conversations live in `~/.gentle-dot/sessions`; the access key is in `~/.gentle-dot/token`.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test         # unit and integration tests (fake agent)
pnpm e2e          # Playwright against the daemon with the fake agent
```

Tests tagged `@real-agent` start the real `gentle-shell`; they are skipped when it is not installed.
