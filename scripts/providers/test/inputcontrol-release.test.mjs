import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inputControlReleaseForClient } from '../inputcontrol-release.mjs';
import { inputControlServerForClient } from '../inputcontrol-dispatch.mjs';

const fixture = readFileSync(new URL('./fixtures/inputcontrol-release.py', import.meta.url), 'utf8');
const compact = Object.fromEntries(['keyboard', 'mouse'].map(module =>
  [module, fixture.split(`# ${module.toUpperCase()} SOURCE\n`)[1].split('# END SOURCE')[0]]));
const dot = (source, module) => inputControlReleaseForClient(source, { client: 'gentle-dot', module });

test('release generation is explicit, byte-preserving by default and fails closed', () => {
  for (const module of ['keyboard', 'mouse']) {
    const source = compact[module];
    for (const client of [undefined, 'upstream', 'dot', 'unknown']) {
      assert.equal(inputControlReleaseForClient(source, { client, module }), source);
    }
    assert.throws(() => dot(dot(source, module), module), /Unsupported InputControl release source/);
    for (const bad of ['', source + source, source.replace('except Exception', 'except OSError'),
      source.replace(module === 'keyboard' ? 'raise release_error' : 'if button_down:', 'pass')]) {
      assert.throws(() => dot(bad, module), /Unsupported InputControl release source/);
    }
    assert.throws(() => dot(source, undefined), /Unsupported InputControl release module/);
    assert.throws(() => dot(source, 'control'), /Unsupported InputControl release module/);
  }
  for (const source of [null, 1, {}, Buffer.from('x')]) {
    assert.throws(() => inputControlReleaseForClient(source), TypeError);
  }
});

const names = ['notify_before_control', 'start_control', 'stop_control', 'control_status',
  'mouse_click', 'mouse_move', 'mouse_scroll', 'mouse_drag', 'keyboard_type',
  'keyboard_press', 'keyboard_hotkey', 'launch_app', 'launch_url', 'get_mouse_position',
  'get_screen_size', 'start_recorder_session', 'stop_recorder_session', 'recorder_status',
  'mouse_move_towards', 'mouse_guided_click', 'click_element'];
const server = 'mcp = FastMCP("inputcontrol-mcp")\n' + names.map(name =>
  `@mcp.tool()\ndef ${name}():\n    return body("${name}")\n`).join('\n');

test(`selected cleanup functions and dispatch: ${process.env.INPUTCONTROL_SOURCE_DIR ? 'pinned' : 'compact'} fake actuators`, () => {
  const original = process.env.INPUTCONTROL_SOURCE_DIR
    ? Object.fromEntries(['keyboard', 'mouse'].map(module => [module,
      readFileSync(`${process.env.INPUTCONTROL_SOURCE_DIR}/${module}.py`, 'utf8')])) : compact;
  const adapted = Object.fromEntries(Object.entries(original).map(([module, source]) => [module, dot(source, module)]));
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const result = spawnSync(executable, [
    ...(!process.env.PYTHON && process.platform === 'win32' ? ['-3.12'] : []), '-I', '-S', '-B',
    fileURLToPath(new URL('./fixtures/inputcontrol-release.py', import.meta.url)),
  ], { input: JSON.stringify({ original, adapted,
    server: inputControlServerForClient(server, { client: 'gentle-dot' }) }),
  encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'Selected cleanup AST and fake-actuator latch/drain: PASS\n');
});
