# Voice device and check panels in Spanish

The initial T6 slice localizes renderer-authored controls, accessibility names,
help and status wrappers in `VoiceDevicesSettings` and `VoiceChecks`. English
remains the default through the existing `useLocale` API.

## Review boundary

- Device selection, refresh, reset and explicit microphone admission reuse the
  existing runtime and device services. IDs, saved preferences, supported-route
  restrictions and callbacks are unchanged. Merely opening Settings starts no audio.
- Actual browser/native device labels remain raw, even labels such as
  `System default` or `Voice input`. Only the renderer's empty-value default
  option and its existing unlabelled-device fallback are localized.
- Local device-operation notices store typed message keys, so switching locale
  also updates a visible notice. No English-string matching establishes ownership.
- Check buttons retain `input`/`output` arguments, active guards, stop/cancel and
  unmount cleanup. Diagnostics retain their raw route/stage tokens and numbers;
  only field labels and null-value wrappers change.
- Diagnostic notes and transcription previews remain raw, including empty errors
  and collisions with renderer English. The spoken test phrase remains exactly
  `Hello, this is the Gentle Dot voice output check.`

## Verification and incomplete coverage

Synthetic tests exercise both locales, native/browser catalog labels, exact stored
IDs, inactive-choice clearing, unsupported routes, unreadable storage, explicit
mocked permission requests, check callbacks and raw errors/previews. The existing
English voice tests remain unchanged, including their synthetic catalog fixes.

This is **not complete T6 or F2c**. `VoiceModel`, diagnostic/native/runtime,
`useVoice` and output producers still need sequential provenance-aware work. Their
mixed-origin notes are deliberately not translated here. No real device, daemon,
installed Windows, browser acceptance or whole-interface completion is claimed.
