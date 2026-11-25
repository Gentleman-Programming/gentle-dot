"""Only selected AST functions execute, with every actuator/helper replaced."""
COMPACT = '''
# KEYBOARD SOURCE
def _release_pressed_keys(pressed_keys: list[str]) -> None:
    release_error: Exception | None = None
    for key in reversed(pressed_keys):
        try:
            pyautogui.keyUp(key)
        except Exception as error:
            if release_error is None:
                release_error = error
    if release_error is not None:
        raise release_error


def hotkey(keys_str: str, *, manager: ControlManager | None = None, session_id: str | None = None) -> dict:
    if not keys_str or not keys_str.strip():
        raise ValueError("Empty hotkey")
    raw_keys = [part.strip() for part in keys_str.split("+")]
    if any(not key for key in raw_keys):
        raise ValueError("Empty hotkey")
    if len(raw_keys) > MAX_HOTKEY_KEYS:
        raise ValueError(f"hotkey key count must be <= {MAX_HOTKEY_KEYS}")
    manager = _manager(manager)
    session_id = session_id or manager.require_active().session_id
    _reject_reserved_gesture(manager, session_id, raw_keys, "key_hotkey")
    validated_keys = [_validate_key(key) for key in raw_keys]
    pressed_keys: list[str] = []
    try:
        for key in validated_keys:
            manager.check_cancelled(session_id)
            pyautogui.keyDown(key)
            pressed_keys.append(key)
        manager.check_cancelled(session_id)
    except Exception:
        try:
            _release_pressed_keys(pressed_keys)
        except Exception:
            pass
        _record(manager, session_id, "key_hotkey", {"count": len(validated_keys), "success": False})
        raise
    try:
        _release_pressed_keys(pressed_keys)
    except Exception:
        _record(manager, session_id, "key_hotkey", {"count": len(validated_keys), "success": False})
        raise
    _record(manager, session_id, "key_hotkey", {"count": len(validated_keys), "success": True})
    return {"status": "ok", "action": "hotkey", "details": {"count": len(validated_keys)}}
# END SOURCE
# MOUSE SOURCE
def drag(start_x: int, start_y: int, end_x: int, end_y: int, duration: float = 0.5, *, manager: ControlManager | None = None, session_id: str | None = None) -> dict:
    validate_coordinates(start_x, start_y)
    validate_coordinates(end_x, end_y)
    duration = _bounded_duration(duration)
    manager = _manager(manager)
    session_id = session_id or manager.require_active().session_id
    button_down = False
    try:
        start_steps = _move_to(start_x, start_y, duration=0.15, manager=manager, session_id=session_id)
        manager.check_cancelled(session_id)
        pyautogui.mouseDown()
        button_down = True
        end_steps = _move_to(end_x, end_y, duration=duration, manager=manager, session_id=session_id)
        manager.check_cancelled(session_id)
        pyautogui.mouseUp()
        button_down = False
    except Exception:
        _record(manager, session_id, "drag", {"x": end_x, "y": end_y, "success": False})
        raise
    finally:
        if button_down:
            try:
                pyautogui.mouseUp()
            except Exception:
                _record(manager, session_id, "mouse_up", {"success": False})
            else:
                _record(manager, session_id, "mouse_up", {"success": True})
    _record(manager, session_id, "drag", {"x": end_x, "y": end_y, "duration_ms": round(duration * 1000), "steps": start_steps + end_steps, "success": True})
    return {"status": "ok", "action": "drag", "details": {"start": [start_x, start_y], "end": [end_x, end_y], "duration": duration}}
# END SOURCE
'''

import ast
import asyncio
import __future__
import json
import sys
import threading
from types import SimpleNamespace

assert sys.version_info[:2] == (3, 12), 'Python 3.12 required'
payload = json.load(sys.stdin)

# Undo only authorized edits; equality covers every other function/guard/import.
for module in ('keyboard', 'mouse'):
    before = ast.parse(payload['original'][module])
    after = ast.parse(payload['adapted'][module])
    latches = [n for n in ast.walk(after) if isinstance(n, ast.Assign) and
               any(isinstance(t, ast.Attribute) and t.attr == '_dot_release_failed' for t in n.targets)]
    assert len(latches) == 1
    assert ast.dump(latches[0]) == ast.dump(ast.parse('manager._dot_release_failed = True').body[0])
    assert isinstance(latches[0].value, ast.Constant) and latches[0].value.value is True
    for node in ast.walk(after):
        for field, value in ast.iter_fields(node):
            if isinstance(value, list):
                value[:] = [item for item in value if not (
                    isinstance(item, ast.Assign) and any(isinstance(t, ast.Attribute)
                    and t.attr == '_dot_release_failed' for t in item.targets))]
        if module == 'keyboard' and isinstance(node, ast.FunctionDef) and node.name == '_release_pressed_keys':
            assert node.args.args[-1].arg == 'manager'
            node.args.args.pop()
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == '_release_pressed_keys':
            assert node.args[-1].id == 'manager'
            node.args.pop()
    assert ast.dump(before) == ast.dump(after), module

class Cancelled(RuntimeError):
    pass

class Manager:
    def __init__(self, cancel_at=0):
        self.checks, self.cancel_at, self.records = 0, cancel_at, []
        self.sentinel = 'unchanged'

    def check_cancelled(self, session):
        assert session == 'session'
        self.checks += 1
        if self.checks == self.cancel_at:
            raise Cancelled('cancelled')

class Actuator:
    def __init__(self, failures=()):
        self.events, self.failures = [], set(failures)
        self.errors = {event: OSError('release failed') for event in self.failures}
        self.error = self.errors.get(('up', 'a'))

    def emit(self, event):
        self.events.append(event)
        if event in self.failures:
            raise self.errors[event]

    def keyDown(self, key): self.emit(('down', key))
    def keyUp(self, key): self.emit(('up', key))
    def mouseDown(self): self.emit('down')
    def mouseUp(self): self.emit('up')


def selected(module, manager, actuator, move_error=False):
    def record(m, session, action, details):
        # Failure must be latched BEFORE mouse audit, even if audit itself fails.
        if action == 'mouse_up' and not details['success']:
            assert m._dot_release_failed is True
        m.records.append((action, details))

    moves = []
    def move(*args, **kwargs):
        moves.append(args)
        if move_error and len(moves) == 2:
            raise Cancelled('cancelled')
        return 1

    env = dict(pyautogui=actuator, _manager=lambda m: m, _record=record,
               _validate_key=lambda k: k, _reject_reserved_gesture=lambda *a: None,
               MAX_HOTKEY_KEYS=4, validate_coordinates=lambda *a: None,
               _bounded_duration=lambda d: d, _move_to=move)
    names = {'_release_pressed_keys', 'hotkey'} if module == 'keyboard' else {'drag'}
    tree = ast.parse(payload['adapted'][module])
    tree.body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in tree.body} == names
    assert not any(isinstance(n, (ast.Import, ast.ImportFrom)) for n in ast.walk(tree))
    exec(compile(tree, '<selected fake cleanup>', 'exec', flags=__future__.annotations.compiler_flag), env)
    return env


def invoke(env, module, manager):
    if module == 'keyboard':
        return env['hotkey']('ctrl+shift+a', manager=manager, session_id='session')
    return env['drag'](0, 0, 1, 1, manager=manager, session_id='session')


for module in ('keyboard', 'mouse'):
    m, a = Manager(), Actuator()
    env = selected(module, m, a)
    assert invoke(env, module, m)['status'] == 'ok'
    assert not hasattr(m, '_dot_release_failed') and m.sentinel == 'unchanged'
    assert a.events == ([('down', k) for k in ('ctrl', 'shift', 'a')] +
                        [('up', k) for k in ('a', 'shift', 'ctrl')] if module == 'keyboard' else ['down', 'up'])
    # Ordinary cancellation retains its original exception, without a latch.
    m, a = Manager(2), Actuator()
    try:
        invoke(selected(module, m, a), module, m)
        assert False
    except Cancelled as error:
        assert str(error) == 'cancelled'
    assert not hasattr(m, '_dot_release_failed')
    if module == 'mouse':
        assert a.events == ['down', 'up']
        assert m.records[-1] == ('mouse_up', {'success': True})

# Normal release failure attempts ALL remaining keys, retaining first exception.
m, a = Manager(), Actuator([('up', 'a'), ('up', 'shift')])
env = selected('keyboard', m, a)
try:
    invoke(env, 'keyboard', m)
    assert False
except OSError as error:
    assert error is a.error
assert a.events[-3:] == [('up', 'a'), ('up', 'shift'), ('up', 'ctrl')]
assert m._dot_release_failed is True
invoke(selected('keyboard', m, Actuator()), 'keyboard', m)
assert m._dot_release_failed is True  # No automatic reset after successful cleanup.

# Cancellation cleanup used to swallow this failure; it must still signal Stop.
m, a = Manager(3), Actuator([('up', 'shift')])
try:
    invoke(selected('keyboard', m, a), 'keyboard', m)
    assert False
except Cancelled:
    pass
assert a.events[-2:] == [('up', 'shift'), ('up', 'ctrl')]
assert m._dot_release_failed is True

# Known-down cleanup failure keeps the original cancellation and audit outcome.
mouse_manager, a = Manager(), Actuator(['up'])
try:
    invoke(selected('mouse', mouse_manager, a, True), 'mouse', mouse_manager)
    assert False
except Cancelled:
    pass
assert a.events == ['down', 'up'] and mouse_manager._dot_release_failed is True
assert mouse_manager.records[-1] == ('mouse_up', {'success': False})
invoke(selected('mouse', mouse_manager, Actuator()), 'mouse', mouse_manager)
assert mouse_manager._dot_release_failed is True
# A failed mouseDown never establishes known ownership: no release/latch.
m, a = Manager(), Actuator(['down'])
try:
    invoke(selected('mouse', m, a), 'mouse', m)
    assert False
except OSError:
    pass
assert a.events == ['down'] and not hasattr(m, '_dot_release_failed')


async def chain():
    entered, release, revoked = threading.Event(), threading.Event(), threading.Event()
    manager, actuator = Manager(), Actuator([('up', 'a')])
    env = selected('keyboard', manager, actuator)
    calls = []
    def body(name):
        calls.append(name)
        if name == 'keyboard_hotkey':
            entered.set()
            assert release.wait(5)
            try:
                invoke(env, 'keyboard', manager)
            except OSError:
                return {'status': 'error', 'message': 'original action error'}
        if name == 'stop_control': revoked.set()
        return {'status': 'ok'}
    server = dict(CONTROL_MANAGER=manager, body=body,
                  FastMCP=lambda name: SimpleNamespace(tool=lambda: lambda fn: fn))
    exec(payload['server'], server)
    action = asyncio.create_task(server['keyboard_hotkey']())
    assert await asyncio.to_thread(entered.wait, 5)
    stop = asyncio.create_task(server['stop_control']())
    assert await asyncio.to_thread(revoked.wait, 5)
    assert not stop.done()
    release.set()
    assert await action == {'status': 'error', 'message': 'original action error'}
    error = {'status': 'error', 'message': 'Input release failed; control remains blocked.'}
    assert await stop == error
    for name in ('start_control', 'mouse_click', 'keyboard_hotkey'):
        assert await server[name]() == error
    assert await server['stop_control']() == error
    assert calls == ['keyboard_hotkey', 'stop_control', 'stop_control']
    assert manager._dot_release_failed is True

asyncio.run(chain())
sys.stdout.buffer.write(b'Selected cleanup AST and fake-actuator latch/drain: PASS\n')
