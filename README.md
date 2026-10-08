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

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test         # unit and integration tests (fake agent)
pnpm e2e          # Playwright against the daemon with the fake agent
```

Tests tagged `@real-agent` start the real `gentle-shell`; they are skipped when it is not installed.
