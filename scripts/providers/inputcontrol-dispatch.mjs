// Pinned InputControl 0.2.1 shape; provenance verification remains the builder's job.
const tools = [
  'notify_before_control', 'start_control', 'stop_control', 'control_status',
  'mouse_click', 'mouse_move', 'mouse_scroll', 'mouse_drag', 'keyboard_type',
  'keyboard_press', 'keyboard_hotkey', 'launch_app', 'launch_url',
  'get_mouse_position', 'get_screen_size', 'start_recorder_session',
  'stop_recorder_session', 'recorder_status', 'mouse_move_towards',
  'mouse_guided_click', 'click_element',
];

const dispatch = `# Dot-only dispatch: never acknowledge cancellation before worker drain.
import asyncio as _dot_asyncio
import functools as _dot_functools

_dot_action_lock = _dot_asyncio.Lock()
_dot_stop_lock = _dot_asyncio.Lock()
_dot_epoch = 0
_dot_stopping = 0


def _dot_denied():
    return {"status": "error", "message": "Control request fenced by Stop; start a new session."}


def _dot_release_error():
    return {"status": "error", "message": "Input release failed; control remains blocked."}


async def _dot_complete(awaitable):
    # Shield alone is insufficient: the caller must retain its lock until drain.
    task = _dot_asyncio.create_task(awaitable)
    cancelled = False
    while not task.done():
        try:
            await _dot_asyncio.shield(task)
        except _dot_asyncio.CancelledError:
            cancelled = True
    result = task.result()  # Retrieve/propagate worker exceptions, never orphan them.
    if cancelled:
        raise _dot_asyncio.CancelledError
    return result


async def _dot_stop(fn, args, kwargs):
    global _dot_stopping
    try:
        async with _dot_stop_lock:
            try:
                result = await _dot_asyncio.to_thread(fn, *args, **kwargs)
            finally:
                # Even a failed revoke must wait for in-flight action cleanup.
                async with _dot_action_lock:
                    pass
            if bool(getattr(CONTROL_MANAGER, "_dot_release_failed", False)):
                return _dot_release_error()
            return result
    finally:
        _dot_stopping -= 1


def _dot_dispatch(fn):
    @_dot_functools.wraps(fn)
    async def invoke(*args, **kwargs):
        global _dot_epoch, _dot_stopping
        if fn.__name__ == "stop_control":
            # No await before fencing: queued starts/actions cannot cross Stop.
            _dot_epoch += 1
            _dot_stopping += 1
            return await _dot_complete(_dot_stop(fn, args, kwargs))
        if fn.__name__ == "control_status":
            return await _dot_complete(_dot_asyncio.to_thread(fn, *args, **kwargs))
        epoch = _dot_epoch
        if _dot_stopping:
            return _dot_denied()
        async with _dot_action_lock:
            if _dot_stopping or epoch != _dot_epoch:
                return _dot_denied()
            if bool(getattr(CONTROL_MANAGER, "_dot_release_failed", False)):
                return _dot_release_error()
            return await _dot_complete(_dot_asyncio.to_thread(fn, *args, **kwargs))
    return invoke


`;

/** Opt-in only: does not modify original files, installed providers or tool bodies. */
export function inputControlServerForClient(source, { client = 'upstream' } = {}) {
  if (typeof source !== 'string') throw new TypeError('Expected InputControl server source');
  if (client !== 'gentle-dot') return source;
  const registrations = [...source.matchAll(/^@mcp\.tool\(\)\r?\ndef (\w+)\(/gm)];
  if (source.includes('_dot_') ||
      (source.match(/^mcp\s*=/gm) || []).length !== 1 ||
      (source.match(/^mcp = FastMCP\("inputcontrol-mcp"\)\r?$/gm) || []).length !== 1 ||
      (source.match(/mcp\.tool/g) || []).length !== tools.length ||
      registrations.map(m => m[1]).join(',') !== tools.join(',')) {
    throw new Error('Unsupported InputControl server source: expected pinned 21 ordinary tools');
  }
  const adapted = source.replace(/^@mcp\.tool\(\)\r?\ndef /gm,
    match => match.replace('def ', '@_dot_dispatch\ndef '));
  return adapted.replace(/^@mcp\.tool\(\)\r?$/m, match => dispatch + match);
}
