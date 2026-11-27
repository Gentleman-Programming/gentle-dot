import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inputControlServerForClient } from '../inputcontrol-dispatch.mjs';

// Independent compact fixture: standard tests need no retained research artifacts.
const names = [
  'notify_before_control', 'start_control', 'stop_control', 'control_status',
  'mouse_click', 'mouse_move', 'mouse_scroll', 'mouse_drag', 'keyboard_type',
  'keyboard_press', 'keyboard_hotkey', 'launch_app', 'launch_url',
  'get_mouse_position', 'get_screen_size', 'start_recorder_session',
  'stop_recorder_session', 'recorder_status', 'mouse_move_towards',
  'mouse_guided_click', 'click_element',
];
const synthetic = 'mcp = FastMCP("inputcontrol-mcp")\n' + names.map(name =>
  `\n@mcp.tool()\ndef ${name}(value: str = "default"):\n    """Synthetic ${name}."""\n    return body("${name}", value)\n`).join('');
const original = synthetic;
const dot = source => inputControlServerForClient(source, { client: 'gentle-dot' });

test('only explicit Dot adapts; invalid and unsupported sources fail closed', () => {
  for (const client of [undefined, 'upstream', 'dot', 'unknown']) {
    assert.equal(inputControlServerForClient(original, { client }), original);
  }
  for (const source of [null, 1, {}, Buffer.from('x')]) {
    assert.throws(() => inputControlServerForClient(source), TypeError);
  }
  for (const source of ['', original.replace('FastMCP("inputcontrol-mcp")', 'FastMCP("other")'),
    original.replace('@mcp.tool()', '@mcp.tool(name="other")'),
    original.replace('def mouse_click(', 'async def mouse_click('),
    original.replace('def mouse_click(', 'def renamed('), original + '\n@mcp.tool()\ndef extra(): pass\n']) {
    assert.throws(() => dot(source), /Unsupported InputControl server source/);
  }
  assert.throws(() => dot(dot(original)), /Unsupported InputControl server source/);
});

const astMode = process.env.INPUTCONTROL_SOURCE ? 'explicit provider-source' : 'synthetic';
test(`stdlib synthetic concurrency and ${astMode} AST preservation (never imports provider)`, () => {
  assert.equal(names.length, 21);
  const astSource = process.env.INPUTCONTROL_SOURCE
    ? readFileSync(process.env.INPUTCONTROL_SOURCE, 'utf8') : synthetic;
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const args = [...(!process.env.PYTHON && process.platform === 'win32' ? ['-3.12'] : []),
    '-I', '-S', '-B', fileURLToPath(new URL('./fixtures/inputcontrol-dispatch.py', import.meta.url))];
  const result = spawnSync(executable, args, {
    input: JSON.stringify({ original: astSource, adapted: dot(astSource), synthetic: dot(synthetic) }),
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'AST and synthetic concurrency: PASS\n');
});
