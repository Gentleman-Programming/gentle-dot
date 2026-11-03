# Dot-only InputControl dispatch (T7a)

`inputControlServerForClient(source, { client: 'gentle-dot' })` generates a
separate server variant. Default and unknown clients return source byte-identically;
non-string input throws `TypeError`. Dot rejects unsupported/already-adapted shapes:
one pinned `FastMCP("inputcontrol-mcp")` binding and all 21 ordered ordinary tool
registrations are required. This structural guard is not provenance verification;
the builder must separately verify the pinned 0.2.1 source commit/checksums.

The inserted decorator sits below `@mcp.tool()`. FastMCP sees an async callable;
`functools.wraps` retains names, docs and inspectable arguments/defaults. Original
tool bodies, native session/indicator/emergency guards and upstream sources remain
unchanged. All tools except `stop_control` and `control_status` share one action
lock, including session starts, recorder tools and reads. Sync bodies use stdlib
`asyncio.to_thread`; no FastMCP upgrade or global thread configuration is needed.

Stop fences the epoch and sets a stopping counter before offload. Its independent
serialized revoke lane runs concurrently with actions; after revoke returns (or
raises), it waits for the action lane to drain. Cancellation repeatedly shields
and drains owned tasks before unlocking or completing the cancelled RPC. A hung
worker therefore leaves Stop pending, not falsely successful. Status may run
concurrently and is **not** proof of Stop completion. ControlManager's existing
thread-safe start/stop lock remains responsible for native session transitions.

Fenced queued/while-stopping requests return exactly
`{"status":"error","message":"Control request fenced by Stop; start a new session."}`.
If `bool(getattr(CONTROL_MANAGER, '_dot_release_failed', False))`, Stop returns
`{"status":"error","message":"Input release failed; control remains blocked."}`
after drain; ordinary tools/start are denied with that same result. Nothing clears
the latch. T7b must reliably set it on native cleanup failure; message parsing is
not release evidence. Original result errors and raised exceptions are not hidden.

## Source-only verification

Run `node --test scripts/providers/test/inputcontrol-dispatch.test.mjs`, then
`node --test scripts/providers/test/inputcontrol-dispatch.test.mjs scripts/providers/test/inputcontrol-theme.test.mjs`.
Requires only the committed module/tests/fixture and Python 3.12 (`PYTHON`
executable override, otherwise Windows `py -3.12`/`python3`). Default tests use an
independently declared compact 21-tool synthetic source: no research tree is needed.
The Python stdlib fixture compares its AST bodies/signatures and executes only
synthetic fake tool bodies/manager. It verifies drain barriers, epoch fencing,
repeated cancellation, error/latch behavior, serialization and signature retention.

For additional actual-provider AST compatibility proof, set test-only
`INPUTCONTROL_SOURCE` to the authorized pinned `server.py` path and run the same
commands. The test label identifies explicit provider-source mode; that source is
parsed as AST data only, never imported/executed. All 21 actual tool bodies,
docstrings and argument/default ASTs are compared before/after adaptation, while
concurrency execution still uses the synthetic source. Missing/invalid explicit
source or Python is a failure, not a skip. Default synthetic proof alone is not
actual pinned-source compatibility proof.
Use authorized child-only temp/home/cache isolation; tests create/delete no files.
This unit does not build, import/start an actual provider/MCP, patch keyboard/mouse,
or prove physical release. Activation requires T7b, a new versioned artifact,
native host session/allowlist integration and separately authorized runtime proof.
