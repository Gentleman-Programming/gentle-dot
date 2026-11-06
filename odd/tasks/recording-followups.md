# Recording follow-ups (Gentle Dot x HostGator)

Objective: close the optional fixes found while preparing the recording. Branch: `chore/update-pi-1.4.0`. Delivery: work-unit commits on the branch; PR is the user's decision. Test runner: vitest (`pnpm test`), plus `pnpm typecheck && pnpm lint`.

## Specs

- S1 (startup restart race): when the desktop app registers computer control while the engine is still starting, the daemon must not kill that starting engine. Today `restart()` ends its stdin and the log says "agent failed to start: Agent is not ready; retrying" (`supervisor.ts:161-166`, `:242`). Expected: the restart is deferred until the engine is ready (or folded into the start), and no "agent failed to start" line is logged for this case.
- S2 (false "error" at startup): before `supervisor.start()` is called, while the daemon awaits the connectors integrity key (`daemon.ts:427`), `/health` and the WebSocket `ready` message report `agentState: "error"` because `stopped` maps to `error` (`bridge.ts:1364`). Expected: that phase reports `"starting"`; a real failure still reports `"error"`.
- S3 (access key message): the web page without an access key says "This page needs your access key. Open it from the Gentle Dot menu (Open in browser)." That menu does not exist on a server. Expected: the message also tells a server user to open the link with `#token=<access key>`.
- S4 (review follow-ups, runtime packaging): advisory findings from review `review-d0cbb52e4b2163e4`:
  - R2-lockfile-regex-shape (`runtime-build.ts:48-49`): make the lockfile package-line parsing easier to read.
  - R3-engine-pins-error-path-untested (`runtime-build.ts:48-53`): test the "two versions of one package" error.
  - R3-overrides-effect-not-exercised (`runtime-build.test.ts:81-88`): prove the overrides actually pin a transitive version in an install, or document why the manifest assertion is the boundary.
  - R3-session-version-unproved (`rotation.ts:20`): a test that fails if the engine's `CURRENT_SESSION_VERSION` stops matching the session version Gentle Dot writes.
- S5 (recording guide): one Markdown file with everything needed to record (the user asked: "haz los cambios y ponme todo en un md"). Personal, not committed; never contains secrets or the VPS IP.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1, S2 | delegated (context backstop; risk item 4, concurrency) + independent verifier | done; independent verifier: S1 pass, S2 pass | 6a5a0e4 |
| T2 | S3, S4 | delegated (context backstop) | done | fda4434 |
| T3 | S5 | inline | done (`GRABACION-gentle-dot-hostgator.md`, excluded in `.git/info/exclude`) | n/a |

## Log

- L1 (2026-10-27, user): "haz los cambios y ponme todo en un md" — in reply to the list of remaining items: PR + VPS back to main; restart race at app start; false "error" during the first minutes; the browser message that says "Open it from the Gentle Dot menu" on the server; the 4 non-blocking review findings.
- L3 (2026-10-27, user): "y si abre el pr y mergea ;)" — authorizes opening and merging the PR.
- L4: T2 RED observed for S3 (old copy asserted); S4 tests cover existing behavior (no genuine RED). T1 RED: S1 rejected "Agent exited (code 0)", S2 "expected 'error' to be 'starting'". Seam check on both: typecheck 0, lint 0, 810 tests passed, e2e 17 passed.
- L5: independent verifier on 6a5a0e4 (fresh scratch copies of 6a5a0e4 and fda4434): 20 focused tests and 810 full-suite tests pass; the new S1/S2 tests fail at fda4434 (RED confirmed); 9 throwaway interleaving probes (three restarts during start, stop with a queued restart, restart during crash-respawn, start timeout and exit with a queued restart, stop during the restart's initialize, bridge states, unhandled rejections) pass at 6a5a0e4, 6 of them fail at the base. No blockers. Advisories (follow-up, not fixed): stop() before start() leaves the bridge's cached agentState at "starting" because setState emits nothing when the state is unchanged; a stop() during start still logs "agent failed to start" (pre-existing); the bridge's restartAgain can add one redundant restart.
- L6: CI (Rust shell) passed on PR #115.
- L2: parent context past the ~150k backstop, so T1 and T2 go to bounded writers with disjoint surfaces in the same tree; the parent owns git and runs the seam check.
