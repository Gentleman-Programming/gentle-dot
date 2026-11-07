import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const uia = readFileSync(
	new URL("../../../apps/desktop/src-tauri/src/computer/win32/uia.rs", import.meta.url),
	"utf8",
);

// Source contracts only: these checks do not execute Rust or prove native input.
const source = readFileSync(
	new URL("../../../apps/desktop/src-tauri/src/computer/win32/mod.rs", import.meta.url),
	"utf8",
);
const admission = source.slice(
	source.indexOf("fn admit_keyboard("),
	source.indexOf("const OBSERVATION_LIFETIME"),
);
const post = source.slice(source.indexOf("    fn post("), source.indexOf("    fn list_apps("));

test("one keyboard admission decision supplies the rejection reason directly", () => {
	assert.match(admission, /-> Result<\(\), &'static str>/);
	assert.match(post, /admit_keyboard\(&expected.value, &fresh, event\)\.map_err/);
	assert.doesNotMatch(source, /fn focus_facts_match|fn focus_change_kind/);
	assert.doesNotMatch(admission, /\.frame/);
});

test("all keyboard admission requires validated opaque identity and reuses action risk", () => {
	assert.match(admission, /expected\.window != fresh\.window/);
	assert.match(admission, /expected\.app != fresh\.app/);
	assert.match(admission, /uia::valid_runtime_id\(a\) && uia::valid_runtime_id\(b\) && a == b/);
	assert.match(admission, /expected\.focus\.element\.role != fresh\.focus\.element\.role/);
	assert.match(admission, /risk::assess/);
	assert.match(admission, /needs_full_focus_metadata\(event, &fresh.focus\)/);
	assert.match(admission, /needs_default_facts\(event, &fresh.focus\)/);
});

test("pointer paths keep focus preflight without a duplicate keyboard ancestry query", () => {
	const keyboard = post.slice(post.indexOf("            InputEvent::Key(_) | InputEvent::Text(_) =>"));
	assert.doesNotMatch(keyboard, /focused_target\(/);
	assert.match(keyboard, /automation.focused_for_input\(event\)\?/);
	assert.equal((post.match(/automation.focused_target\(\)\?/g) ?? []).length, 2);
	const beforeMatch = post.slice(0, post.indexOf("        match event {"));
	assert.doesNotMatch(beforeMatch, /focused_target\(/);
});

test("query scope and admission share the conservative metadata policy", () => {
	assert.match(source, /fn needs_full_focus_metadata\([\s\S]*?!field_text\(event, focus\)/);
	assert.match(admission, /if needs_full_focus_metadata\(event, &fresh.focus\)/);
	assert.match(uia, /super::needs_full_focus_metadata\(event, &focus\)/);
});

test("newline text requests default facts consistently with the existing risk classifier", () => {
	const defaults = source.slice(source.indexOf("fn needs_default_facts"), source.indexOf("fn field_text"));
	assert.match(defaults, /text.contains\('\\n'\) \|\| \(text.contains\(' '\) && pressable\)/);
});
