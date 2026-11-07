// SOURCE contracts only: not Rust execution, UIA or native input proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
	new URL("../../../apps/desktop/src-tauri/src/computer/win32/mod.rs", import.meta.url),
	"utf8",
);
test("keyboard admission separates identity and action metadata from presentation", () => {
	const body = source.match(/fn admit_keyboard\([\s\S]*?\n\}/)?.[0];
	assert.ok(body, "one event-aware admission decision must exist");
	for (const field of ["window", "app", "focus.element.role"])
		assert.ok(body.includes("expected." + field + " != fresh." + field), field);
	assert.doesNotMatch(body, /\.frame/);
	assert.match(body, /uia::valid_runtime_id/);
	assert.match(body, /needs_full_focus_metadata\(event, &fresh.focus\)/);
	assert.match(body, /expected\.focus\.default_button != fresh\.focus\.default_button/);
	assert.match(body, /risk::assess/);
	const field = source.match(/fn field_text\([\s\S]*?\n\}/)?.[0];
	assert.match(field, /text\.chars\(\)\.any\(char::is_control\)/);
	assert.match(field, /"AXTextField" \| "AXTextArea" \| "AXComboBox"/);
});
test("post retains freshness, pointer preflight, readiness and final ownership guards", () => {
	assert.match(source, /admit_keyboard\(&expected\.value, &fresh, event\)\.map_err/);
	assert.match(source, /observed\.focus\.as_ref\(\)\.filter\(\|f\| f\.recent\(\)\)/);
	assert.match(source, /let _focus_target = automation\.focused_target\(\)\?/);
	assert.match(source, /identity::foreground\(\)\? != front/);
	assert.match(source, /self\.own\.input_ready\(\)\?/);
	assert.match(source, /let fresh = automation\.focused_for_input\(event\)\?/);
});
