// Source contracts only: these cannot execute Rust, HWNDs or the installed Tauri cache.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const shell = read("apps/desktop/src-tauri/src/shell.rs");
const native = read("apps/desktop/src-tauri/src/computer/windows_app.rs");
const app = read("apps/desktop/src-tauri/src/computer/app.rs");
const hide = shell.match(
	/impl working::Windows for ShellWindows \{[\s\S]*?fn hide\(&self, part: Part\) -> Result<\(\), String> \{([\s\S]*?)\n    \}/,
)[1];

test("Windows temporary panel hide uses the native counterpart of nonactivating restoration", () => {
	assert.match(
		hide,
		/#\[cfg\(target_os = "windows"\)\]\s*if matches!\(part, Part::Panel\) \{\s*return computer::hide_windows_panel_temporarily\(&window\);\s*\}/,
	);
	assert.match(app, /hide_panel_temporarily as hide_windows_panel_temporarily/);
	const body = native.match(/pub fn hide_panel_temporarily\([\s\S]*?\n\}/)?.[0];
	assert.ok(body, "native temporary panel hide must exist");
	assert.match(
		body,
		/temporary_panel_target\(window\.label\(\), pid, std::process::id\(\), owner, current\)/,
	);
	assert.match(
		body,
		/return Err\("temporary panel target unavailable"\.into\(\)\);[\s\S]*?ShowWindow\(hwnd, SW_HIDE\)/,
	);
	assert.match(body, /if unsafe \{ IsWindowVisible\(hwnd\) \}\.as_bool\(\) \{\s*return Err/);
	assert.doesNotMatch(
		body,
		/\.hide\(|\.show\(|set_focus|SetForegroundWindow|SW_SHOW|sleep|\.lock\(|\.control|user_visibility/,
	);
});

test("Dot and non-Windows temporary hiding retain the single legacy Tauri call and errors", () => {
	assert.match(
		hide,
		/let window = self\.get\(part\)\.ok_or_else\(\|\| format!\("window \{part:\?\} is missing"\)\)\?;/,
	);
	assert.match(hide, /if matches!\(part, Part::Panel\) \{[\s\S]*?\}\s*window\.hide\(\)\.map_err\(err\)\s*$/);
	assert.equal((hide.match(/window\.hide\(\)/g) || []).length, 1);
	assert.equal((hide.match(/hide_windows_panel_temporarily/g) || []).length, 1);
});

test("new native validation is own-panel/owner-thread only and restoration remains intent-gated", () => {
	const guard = native.match(/fn temporary_panel_target\([\s\S]*?\n\}/)?.[0];
	assert.ok(guard);
	assert.match(guard, /label == "panel" && pid != 0 && pid == current_pid && owner != 0 && owner == current/);
	const restore = native.match(/pub fn restore_shell_window\([\s\S]*?\n\}/)[0];
	assert.match(restore, /desired\(hwnd, true\)\?/);
	assert.match(restore, /capturing\.load\(Ordering::Acquire\)/);
	assert.match(restore, /else \{ show_without_focus\(window\)\?; \}/);
	const show = native.match(/pub fn show_without_focus\([\s\S]*?\n\}/)[0];
	assert.match(show, /ShowWindow\(hwnd, SW_SHOWNA\)/);
});
