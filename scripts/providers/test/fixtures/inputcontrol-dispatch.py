"""Execute only generated synthetic functions; pinned provider is AST data only."""
import ast
import asyncio
import inspect
import json
import sys
import threading
from types import SimpleNamespace

payload = json.load(sys.stdin)
old, new = (ast.parse(payload[key]) for key in ("original", "adapted"))
old_tools = [n for n in old.body if isinstance(n, ast.FunctionDef) and n.decorator_list]
new_tools = [n for n in new.body if isinstance(n, ast.FunctionDef) and n.decorator_list]
assert len(old_tools) == len(new_tools) == 21
for before, after in zip(old_tools, new_tools):
    assert ast.dump(before.args) == ast.dump(after.args)
    assert before.name == after.name
    assert ast.get_docstring(before) == ast.get_docstring(after)
    assert ast.dump(before.body[0]) == ast.dump(after.body[0])
    assert len(after.decorator_list) == 2
    assert ast.unparse(after.decorator_list[0]) == "mcp.tool()"
    assert ast.unparse(after.decorator_list[1]) == "_dot_dispatch"
    after.decorator_list.pop()
    assert ast.dump(before) == ast.dump(after)  # Entire original tool body unchanged.

DENIED = {"status": "error", "message": "Control request fenced by Stop; start a new session."}
LATCHED = {"status": "error", "message": "Input release failed; control remains blocked."}


class FastMCP:
    def __init__(self, name):
        assert name == "inputcontrol-mcp"
        self.tools = {}

    def tool(self):
        def register(fn):
            assert inspect.iscoroutinefunction(fn)
            assert str(inspect.signature(fn)) == "(value: str = 'default')"
            assert fn.__doc__ == f"Synthetic {fn.__name__}."
            self.tools[fn.__name__] = fn
            return fn
        return register


class Harness:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.revoked = threading.Event()
        self.finished = threading.Event()
        self.effects = []
        self.active = 0
        self.maximum = 0
        self.manager = SimpleNamespace(_dot_release_failed=False)
        namespace = {"FastMCP": FastMCP, "CONTROL_MANAGER": self.manager, "body": self.body}
        exec(compile(payload["synthetic"], "<synthetic-only>", "exec"), namespace)
        self.tools = namespace["mcp"].tools

    def body(self, name, value):
        self.effects.append((name, value))
        if name == "stop_control":
            self.revoked.set()
        if value == "raise":
            raise ValueError("synthetic failure")
        if value == "error":
            return {"status": "error", "message": "synthetic rejection"}
        if name not in ("stop_control", "control_status"):
            self.active += 1
            self.maximum = max(self.maximum, self.active)
            try:
                if value == "block":
                    self.entered.set()
                    assert self.release.wait(3), "worker barrier timed out"
            finally:
                self.active -= 1
                self.finished.set()
        return {"status": "ok", "value": value}

    async def event(self, event):
        assert await asyncio.wait_for(asyncio.to_thread(event.wait, 2), 3)

    def call(self, name, value="default"):
        return asyncio.create_task(self.tools[name](value))


async def cancelled(task):
    try:
        await asyncio.wait_for(task, 3)
    except asyncio.CancelledError:
        return
    raise AssertionError("cancellation was swallowed")


async def concurrency(cancel_stop=False, latch=False, stop_value="default"):
    h = Harness()
    action = h.call("mouse_click", "block")
    await h.event(h.entered)
    queued = h.call("keyboard_press", "queued")
    await asyncio.sleep(0)  # Schedule queued RPC before Stop, without wall-clock delay.
    stop = h.call("stop_control", stop_value)
    await h.event(h.revoked)
    assert not stop.done() and not h.finished.is_set()
    assert await asyncio.wait_for(h.tools["control_status"](), 1) == {"status": "ok", "value": "default"}
    baseline = list(h.effects)
    assert await h.tools["start_control"]() == DENIED
    assert await h.tools["mouse_move"]() == DENIED
    assert h.effects == baseline  # Rejections have no synchronous side effects.
    action.cancel()
    await asyncio.sleep(0)
    action.cancel()
    if cancel_stop:
        stop.cancel()
        await asyncio.sleep(0)
        stop.cancel()
    await asyncio.sleep(0)
    assert not action.done() and not stop.done()
    assert h.active == h.maximum == 1
    h.manager._dot_release_failed = latch
    h.release.set()
    await cancelled(action)
    assert await asyncio.wait_for(queued, 3) == DENIED
    if cancel_stop:
        await cancelled(stop)
    elif stop_value == "raise":
        try:
            await stop
        except ValueError as exc:
            assert str(exc) == "synthetic failure"
        else:
            raise AssertionError("stop exception hidden")
    else:
        expected = LATCHED if latch else ({"status": "error", "message": "synthetic rejection"}
                                         if stop_value == "error" else {"status": "ok", "value": "default"})
        assert await stop == expected
    assert h.finished.is_set() and h.active == 0 and h.maximum == 1
    assert ("keyboard_press", "queued") not in h.effects
    baseline = list(h.effects)
    assert await h.tools["start_control"]() == (LATCHED if latch else {"status": "ok", "value": "default"})
    if latch:
        assert await h.tools["keyboard_press"]() == LATCHED
        assert await h.tools["stop_control"]() == LATCHED
        assert h.manager._dot_release_failed is True
        assert h.effects[:-1] == baseline  # Only Stop body runs, never start/action.


async def main():
    for options in ({}, {"cancel_stop": True}, {"latch": True},
                    {"stop_value": "raise"}, {"stop_value": "error"}):
        await concurrency(**options)
    h = Harness()
    action = h.call("mouse_click", "block")
    await h.event(h.entered)
    action.cancel()
    await asyncio.sleep(0)
    action.cancel()
    next_action = h.call("keyboard_press")
    await asyncio.sleep(0)
    assert not action.done() and not next_action.done()
    assert h.effects == [("mouse_click", "block")] and h.active == 1
    h.release.set()
    await cancelled(action)
    assert await next_action == {"status": "ok", "value": "default"}
    assert h.maximum == 1 and h.active == 0
    h = Harness()
    for name, fn in h.tools.items():
        assert await fn() == {"status": "ok", "value": "default"}
    assert len(h.effects) == 21 and h.maximum == 1
    assert await h.tools["mouse_click"]("error") == {"status": "error", "message": "synthetic rejection"}
    try:
        await h.tools["mouse_click"]("raise")
    except ValueError as exc:
        assert str(exc) == "synthetic failure"
    else:
        raise AssertionError("action exception hidden")
    assert await h.tools["mouse_click"]() == {"status": "ok", "value": "default"}


assert sys.version_info[:2] == (3, 12), "Python 3.12 required"
asyncio.run(main())
sys.stdout.buffer.write(b"AST and synthetic concurrency: PASS\n")
