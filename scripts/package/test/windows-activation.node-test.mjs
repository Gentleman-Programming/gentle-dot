// Source contracts only; not Rust, Win32, focus or desktop-input execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
	new URL("../../../apps/desktop/src-tauri/src/computer/win32/mod.rs", import.meta.url),
	"utf8",
);
const activation = source.match(/fn activate_window\([\s\S]*?\n    \}\n/)[0];
test("foreground confirmation waits for asynchronous activation, including transient NULL", () => {
	assert.match(activation, /Self::wait_activation/);
	assert.match(activation, /GetForegroundWindow\(\)/);
	assert.match(activation, /foreground\.0\.is_null\(\)[\s\S]*?return Ok\(false\)/);
	assert.match(activation, /identity::root\(foreground\)\?/);
	assert.doesNotMatch(activation, /identity::foreground\(\)\?/);
	assert.match(source, /Duration::from_millis\(1000\)/);
	assert.match(source, /saturating_duration_since/);
	assert.match(source, /thread::sleep\(left\.min\(Duration::from_millis\(20\)\)\)/);
});
test("a minimized verified app gets one restore action instead of a second activation", () => {
	const restore = activation.indexOf("ShowWindowAsync");
	assert.ok(restore > 0 && restore < activation.indexOf("SetForegroundWindow("));
	assert.match(activation, /\} else if !unsafe \{ SetForegroundWindow/);
	assert.match(source, /Self::activate_window\(\*window, app, true\)/);
	assert.match(source, /Self::activate_window\(\*window, id, false\)/);
	assert.match(activation, /IsIconic/);
	assert.match(activation, /SW_RESTORE/);
	assert.match(activation, /application did not restore from minimized state/);
	assert.equal((activation.match(/SetForegroundWindow\(/g) || []).length, 1);
});
test("existing foreground denial, identity checks and running-app-only restrictions remain", () => {
	assert.match(activation, /identity::normal_desktop\(\)\?/);
	assert.match(activation, /identity::identity\(hwnd\(window\)\)\? != \*expected/);
	assert.match(activation, /Windows declined foreground activation; no focus-lock workaround was attempted/);
	assert.match(source, /cold launch is unsupported/);
	assert.match(source, /ambiguous application name; use its listed win32 executable identifier/);
	assert.doesNotMatch(
		activation,
		/AttachThreadInput|AllowSetForegroundWindow|SendInput|keybd_event|mouse_event/,
	);
});
