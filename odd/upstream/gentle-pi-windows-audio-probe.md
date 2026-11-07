# Upstream report — Windows audio probe gives up before PowerShell starts

Ready to file against `Gentleman-Programming/gentle-shell` (gentle-pi). Not published.

**Title:** Windows WAV backend reports unavailable on a machine that can play: the 1200 ms probe budget is shorter than the PowerShell host's startup

## Environment

- Windows 11 x86_64, gentl-pi 4.3.0 (`C:\Users\Admin\AppData\Local\gentle-shell\versions\4.3.0-1.2.0`).
- Audio notifications enabled in `<gentlePiConfigHome()>/notifications.json` with `agent.attention: builtin:attention`,
  `agent.completed: builtin:success`, `agent.failed: builtin:error` (a file the package's own
  `writeNotificationSettings` produced and `resolveNotificationSettings` reads back as valid).

## Symptom

Nothing ever plays, and nothing says why. `createDefaultNotificationBackend().probe()` answers
`{"available":false,"formats":[]}`.

## Root cause

`lib/notification-audio-windows.ts`:

- `const DEFAULT_PROBE_TIMEOUT_MS = 1200;`
- `probe()` → `run("probe", …)` with that budget; a timeout is folded into `{available:false}`.

Measured on this machine, the fixed host takes longer than the budget to start and answer:

```
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand …
  scrubbed child env (the module's own allowlist + SystemRoot/windir): 2087 ms, exit 0, available:true
  full environment:                                                    1902 ms, exit 0, available:true
```

Both runs answer `{"schema":"gentle.audio.windows/v1","ok":true,"available":true,"formats":["wav"]}` — they just
finish ~700–900 ms after the 1200 ms budget has already declared the backend unavailable.

**And there is no fallback on Windows**: `NotificationPlayer.detectExecutable("win32")` returns
`undefined` (its candidate list is Linux/macOS only), so `discover()` ends with
`native = []`, no `system` executable, and `play()` returns silently at
`if (discovered.native.length === 0 && !discovered.system) return;`.

Calling the backend's `play()` directly — which is not gated by the probe — succeeds on the same
machine: `3153 ms`, host reports `played:true`, tone audible. So the host, the fixed path and the
`MemoryStream`/`SoundPlayer` script are all fine; only the probe's budget is wrong.

## Why this is a user-visible defect rather than a slow-machine corner

Any Windows user with a cold first call — the normal case after a session starts — is told audio is
unavailable, and the feature silently stays silent. The availability answer is cached per player
instance (`discovery ??=`), so it does not retry once the machine is warm.

## Suggested fix

Raise the probe budget to comfortably exceed a cold PowerShell start (4000 ms measured comfortable
here; 1200 ms is under every cold start we could measure), or start the host once and treat the
first successful `play()` as the availability signal. A stopped/denied host still fails closed on its
own exit code, so a longer budget does not weaken the "no false availability" property.

## Verification after a local patch

With `DEFAULT_PROBE_TIMEOUT_MS = 4000`:

```
probe: {"available":true,"formats":["wav"]}
played assets/sounds/attention.wav through the native backend
```

and the config still validates and maps every event exactly as before.
