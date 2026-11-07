// SOURCE contracts only: these assertions do not execute Rust or Windows UIA.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const base = new URL("../../../apps/desktop/src-tauri/src/computer/win32/", import.meta.url);
const uia = readFileSync(new URL("uia.rs", base), "utf8");
const helper = new URL("ancestry.rs", base);
const walk = existsSync(helper) ? readFileSync(helper, "utf8") : "";

test("SOURCE: exact raw root uses a checked resource walk, not a depth cutoff", () => {
	assert.doesNotMatch(uia, /MAX_ANCESTORS|within 16 elements/);
	assert.match(uia, /#\[path = "ancestry.rs"\]\s*mod ancestry;/);
	assert.match(uia, /ElementFromHandle\(window\)/);
	assert.match(uia, /RawViewWalker\(\)/);
	assert.match(uia, /CompareElements\(a, b\)/);
	assert.match(walk, /64 \* 1024/);
	assert.match(walk, /try_reserve_exact/);
	assert.match(walk, /checked_mul/);
	assert.match(walk, /ancestry cycle/);
	assert.doesNotMatch(walk, /RuntimeId|\.iter\(\)\.any/);
	const chain = uia.slice(uia.indexOf("    fn chain("), uia.indexOf("    pub fn point("));
	assert.ok(chain.indexOf("ancestry::walk(") < chain.indexOf("self.describe(node, pid)"));
	assert.match(chain, /\|node\| \{[\s\S]*self\.validate_element\(node, pid\)\?/);
	assert.match(walk, /validate\(node\)\?;[\s\S]*let reached = same\(node, root\)\?;/);
	assert.match(walk, /if reached \{ return Ok\(nodes\); \}/);
});

test("SOURCE: input identity acquisition is independent of action-specific defaults", () => {
	assert.match(uia, /fn focused_for_input\(/);
	assert.match(uia, /super::needs_full_focus_metadata\(event, &focus\)/);
	assert.match(
		uia,
		/fn focused_query\(&self, read_identity: bool, event: Option<&super::super::InputEvent>, read_all_defaults: bool\)/,
	);
	assert.match(uia, /self\.focused_query\(true, None, true\)/);
	assert.match(uia, /self\.focused_query\(false, None, false\)/);
	assert.match(uia, /self\.focused_query\(true, Some\(event\), false\)/);
	assert.match(uia, /let runtime_id = if read_identity/);
	assert.match(uia, /if event\.is_some\(\) \{ Some\(self\.runtime_id\(&focused\)\?\) \}/);
	assert.match(uia, /let default_known = default\.is_ok\(\)/);
	assert.match(uia, /if !unsafe \{ focused.CurrentHasKeyboardFocus\(\) \}/);
	assert.doesNotMatch(
		uia,
		/\.SetFocus\(|ControlViewWalker\(|GetCurrentPatternAs::<IUIAutomation(?:Value|Text)Pattern>/,
	);
	assert.match(uia, /self\.budget\(\)\?;\s*Ok\(FocusFacts/);
});

test("SOURCE: native behavioral regressions are authored, not claimed executed", () => {
	for (const name of [
		"long_path_validates_before_labels",
		"cycles_refuse_linearly",
		"foreign_or_protected_ancestor_refuses_before_labels",
		"missing_root_and_provider_failures_refuse",
		"budget_and_storage_exhaustion_refuse",
	]) {
		assert.ok(walk.includes(`fn ${name}(`), name);
	}
	assert.match(uia, /role\(unsafe \{ node.CurrentControlType\(\)/);
	const validation = uia.slice(uia.indexOf("    fn validate_element("), uia.indexOf("    fn describe("));
	assert.doesNotMatch(validation, /CurrentControlType/); // no new role gate on default-search containers
	assert.match(uia, /UIA final keyboard focus/);
	assert.match(uia, /const PROVIDER_TIMEOUT_MS: u32 = 100/);
	assert.match(uia, /Duration::from_millis\(500\)/);
});
