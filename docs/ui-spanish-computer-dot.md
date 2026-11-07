# Computer and Dot display language

Computer permission, prerequisite, session/countdown, risk and limit copy now follows the UI language. The collapsed Dot's accessible state/control/Yolo labels do too. English remains the default.

## Boundaries

- Native `reads`/`sends` text, including empty strings and English-looking collisions, remains raw.
- Helper registration and current prerequisites never authorize a session or Yolo. Native state still decides; request, recheck, Stop and Yolo callbacks are unchanged.
- `computerCopy` remains pure and default-English. Mac/Windows accelerator bytes come from that helper, using the desktop target's `⌥⇧Esc` / `Alt+Shift+Esc` spelling. The UI names a shortcut only after the app explicitly confirms registration; otherwise it promises only Stop.
- Missing or malformed screenshot support fails closed. A native `unknownVersion` refusal remains distinct from a known unsupported Windows version in both languages.
- Registration, prerequisites and session authority stay separate. Timestamp formatting, timers, capture/input and pointer/keyboard behavior are unchanged. The Dot names the PC on Windows, the Mac on macOS and the computer on an unknown platform.

## Target integration validation

The three renderer Computer conflicts have been composed with the target's panic-registration and screenshot-refusal contracts. Additional binding and bilingual fixtures protect those fields and the Stop-only fallback. These fixtures have **not run in this integration**. The earlier check selected a nonexistent Node path, not a genuinely unavailable toolchain. Declared dependencies are now installed with scripts disabled; browser, build, full typing and native validation remain pending.

## Historical source proof

Synthetic DOM fixtures and mocked callbacks only: 16 new bilingual tests plus 33 existing Computer/Dot tests pass. Three unchanged pure node tests pass. New tests first failed on missing Spanish accessible/display text; subsequent checks cover English platform guidance, native raw/empty data, pending/failed/ready prerequisites, exact permission/Yolo callbacks, Stop click delivery, countdown updates and every Dot state.

This is T5-only renderer evidence, not completed F2c, a browser acceptance run, native permission validation or Windows runtime proof. Parent owns joint integration/type/build checks.
