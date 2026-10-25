# Push-to-talk voice shortcut
Branch: `feat/voice-push-to-talk`; baseline: `8cb20ee`; delivery: work-unit commits on the feature branch, local only; no PR or push without an explicit decision.

## Specs
- S1 — "un shortcut para enviarle una nota de voz". A global shortcut records while it is held and sends when it is released (push-to-talk, one gesture).
- S2 — "Push-to-talk: mantener y soltar". The shortcut is configurable in Settings, persisted in `config.json` as `voiceShortcut`, default `Alt+Shift+Space`, and can be turned off (empty value) without losing the panel shortcut.
- S3 — Holding it shows the panel when it was hidden and starts the same recording as the mic button: level meter, live partial text, Esc cancels, the existing 60 s limit still applies.
- S4 — Releasing it transcribes and sends the text as the user's message, even when the "send on stop" preference is off; the stored preference is not changed.
- S5 — A recording started by the mic button is not stopped by releasing the shortcut, and the shortcut does nothing while another recording or a transcription is in progress.
- S6 — The voice shortcut uses the panel shortcut's validation (a modifier or F1–F24, never the panic shortcut, never a combination already taken) and is refused when it equals the panel shortcut's keys.

## Tasks
- T1 | S1, S3, S5 | Rust: bind the second shortcut, show the panel, emit `voice://hold-start` and `voice://hold-stop` | done | Risk: items 3 (new global shortcut surface) and 6 | GREEN: `cargo test` 417 passed, 0 failed | Runtime press/release still unverified
- T2 | S2, S6 | Rust: `voiceShortcut` in config, `voice_shortcut_get`/`voice_shortcut_set`, normalize/apply with rollback | done | Risk: item 3 | GREEN: `cargo test` 417 passed, 0 failed (config parse/off/save, apply_voice bind-save-unbind, refusal and save-rollback) | Also `build.rs` COMMANDS and `capabilities/default.json` gained both commands
- T3 | S1, S4, S5 | React: `holdStart`/`holdStop` in `useVoice`, forced send on release | pending | Risk: none (logic pinned by tests) | RED/GREEN: pending
- T4 | S2 | Settings row: show, change, remove, reset to default | pending | Risk: none | RED/GREEN: pending
- T5 | S1–S6 | Checks: `cargo test`, `pnpm typecheck`, vitest for settings and the hook | pending | Risk: none | pending

## Log
- L1 — Original request verbatim: "genial! ya probé gentle-dot y me gusta como funciona, lo que necesito es un shortcut para enviarle una nota de voz, sabes si lo tiene? o es necesario crearlo?"
- L2 — Chosen gesture verbatim: "Push-to-talk: mantener y soltar" — "Mantener el atajo graba, soltar envía. Un solo gesto, como un walkie-talkie. Requiere atajo global + evento al panel."
- L3 — Existing state (read at baseline): the panel has one configurable global shortcut plus the reserved panic `⌥⇧Esc`; voice is a tap-to-start/tap-to-send mic button (`docs/design.md:197`); `useVoice` already exposes `start`/`stop`/`cancel` and the `sendOnStop` preference (default off, which leaves a draft in the input). No voice shortcut exists, locally or globally.
