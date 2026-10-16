# Niri runtime protocol (`assert-niri.py`)

Stdlib Python only. Never claims overall PASS; uncovered areas stay `BLOCKED`,
missing prerequisites exit nonzero. Host-here-Niri only: GitHub CI and other
devices are not necessarily Niri sessions, so nothing here is integrated into
any workflow or default test target. Ordinary web/headless CI does not verify
this native desktop behavior. A future dedicated self-hosted/compositor job is a separate
decision, not current implementation.

## Split: portable fixtures vs native runtime (explicit)

- Portable: `python3 scripts/linux/niri/test_assert_niri.py` — 8 fixture
  unittest cases covering runner logic only (parsing, pid+title filtering, PID
  guard, report rules, follow math). Runs anywhere without Niri; is NOT native
  acceptance and never substitutes for a GUI run.
- Native (opt-in, manual, dedicated command only): `assert-niri.py` requires a
  live Niri session plus a coherent running candidate plus explicit
  `--pid/--exe/--artifact-dir` and backend `--port`. Missing prerequisites for
  a requested native check report `BLOCKED` nonzero — that is not an app FAIL
  and never a GUI pass. No part of the native runner belongs in default
  tests or CI workflows.

## Native prerequisites and examples

- Real Niri Wayland session on this host (`NIRI_SOCKET` set, socket exists).
- Externally running candidate launched by the verifier (runner never
  launches/kills): its PID, exact `--exe` path, explicit backend `--port`.
- Private artifact dir already existing under `/tmp` or `/var/tmp`.
- No second candidate instance (single-instance would forward `--toggle`).

```sh
# Read-only preflight (default, mutates nothing):
python3 scripts/linux/niri/assert-niri.py \
  --pid <PID> --exe <ABSOLUTE_EXE> --artifact-dir /var/tmp/<DIR> --port <PORT>
# Opt-in motion (verifier only, after preflight is green):
python3 scripts/linux/niri/assert-niri.py \
  --pid <PID> --exe <ABSOLUTE_EXE> --artifact-dir /var/tmp/<DIR> --port <PORT> \
  --exercise-windows
```

## Runtime limits

- Preflight verifies `/proc/<pid>/exe` + starttime (PID-reuse guard), exe
  hash, `NIRI_SOCKET`, exact pid+title rose/panel via `niri msg --json
  windows`, and `/health` at the explicit port (backend-ready only, never UI).
- `--exercise-windows` first validates the move against live output geometry
  (`niri msg --json outputs` logical rects + the rose's own size): the same
  opposite pair runs feasible-order-first, and the leg is `BLOCKED` with no
  move issued when bounds are unvalidated or neither target fits — never a
  guessed edge offset. Each leg then commands one `move-floating-window`
  and polls fresh `niri msg` geometry; PASS needs the rose at the commanded
  absolute target AND the panel offset kept, same IDs/PID, inside 2000 ms
  (300 ms debounce + settle + latency, so the observed 305 ms passes; not
  `<=300` ms). Unchanged geometry timeouts FAIL (offset equality alone is
  never motion evidence); a move that was never issued is BLOCKED, never
  PASS. Same PID/IDs throughout, no reopen. Owned `--toggle` hide/show
  asserts the rose survives; a `+40,0` jog while hidden must not remap the
  panel, then restores and re-shows.
- The pre-move baseline is captured; any partial failure triggers a guarded
  restore (current-delta move back) only while PID/starttime + rose id still
  match — never for a reused PID or foreign id. Restore reports its own
  PASS/FAIL/BLOCKED evidence and is never silenced.
- Saved rose-hidden preference case stays `BLOCKED`: never override
  preferences, never reset `desktop.json`, no config mutations, no focus
  fallback, no killing/launching, no global compositor changes.
- Outputs/timing: no verified output geometry (same-output guard only) and no
  every-frame proof — sampled geometry with bounded settle, not pixel video.
- Screen recording is separate: requires its own privacy consent and human
  screen preparation; this runner captures no screenshots/recordings.
- Always `BLOCKED` (not covered): authenticated UI, first-frame pixels, modes,
  tray, login, rose-hide preference, recording.

## Privacy and exits

Artifacts (`evidence.json`, invocation only, never checked in) hold rose/panel
IDs+coordinates, counts, and `PASS/FAIL/BLOCKED` lines only. No other window
titles/PIDs, no credentials, no config contents. Exits: `0` executed-green
(coverage gaps still listed), `1` FAIL, `2` BLOCKED prerequisite.
