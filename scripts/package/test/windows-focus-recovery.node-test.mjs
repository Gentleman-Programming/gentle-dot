// Structural checks only, not UIA, Rust execution or installed behavior.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const native = readFileSync(new URL("apps/desktop/src-tauri/src/computer/win32/mod.rs", root), "utf8");
const mcp = readFileSync(new URL("apps/desktop/src-tauri/src/computer/mcp.rs", root), "utf8");
test("focus refusal reports a fixed category, never old or new field values", () => {
	const body = native.match(/fn admit_keyboard\([\s\S]*?\n\}/)?.[0];
	assert.ok(body, "one fixed-reason admission decision");
	assert.doesNotMatch(body, /format!|to_string|clone\(|\.label\(|\.frame/);
	assert.match(native, /focused input admission refused \(reason=\{reason\}\)/);
	assert.match(native, /admit_keyboard\(&expected\.value, &fresh, event\)\.map_err/);
	assert.doesNotMatch(native, /fn focus_change_kind|fn focus_facts_match/);
	for (const tag of [
		"window",
		"application",
		"element_identity",
		"element_role",
		"element_title",
		"element_description",
		"element_value",
		"focused_default",
		"default_unknown",
		"default_known",
		"default_button",
		"action_risk",
	])
		assert.ok(body.includes('"' + tag + '"'), tag);
});
test("Windows instructions explain recovery before capture without changing macOS copy", () => {
	const windows = mcp.slice(mcp.indexOf("const INSTRUCTIONS:"), mcp.indexOf('"Controls this Mac.'));
	assert.match(windows, /list_apps/);
	assert.match(windows, /open_app/);
	assert.match(windows, /before taking a screenshot/);
	assert.match(windows, /Do not substitute Chromium for Chrome/);
	assert.match(mcp, /"Controls this Mac\. Take a screenshot first;/);
	assert.match(mcp, /if cfg!\(target_os = "windows"\)/);
});
