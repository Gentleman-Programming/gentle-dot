// SOURCE contracts, not live UIA or Rust execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const base = new URL("../../../apps/desktop/src-tauri/src/computer/win32/", import.meta.url);
const uia = readFileSync(new URL("uia.rs", base), "utf8");
const native = readFileSync(new URL("mod.rs", base), "utf8");
test("default discovery enumerates button candidates, not structural layout nodes", () => {
	const body = uia.slice(uia.indexOf("    fn default_button("), uia.indexOf("    pub fn focused("));
	assert.match(body, /default_candidates\(root\)/);
	assert.match(uia, /CreatePropertyCondition\(UIA_ControlTypePropertyId/);
	assert.match(uia, /let fields = &mut \*value\.Anonymous\.Anonymous/);
	assert.match(uia, /fields\.vt = VT_I4/);
	assert.match(uia, /fields\.Anonymous\.lVal = kind\.0/);
	assert.match(uia, /CreateOrCondition/);
	assert.match(uia, /TreeScope_Subtree/);
	assert.match(uia, /SetTreeFilter/);
	assert.doesNotMatch(body, /TreeScope_Children|pending\.pop|MAX_DEFAULT_NODES/);
	assert.match(uia, /MAX_DEFAULT_CANDIDATES: usize = 64/);
});
test("complete success with no matches differs from a failed query", () => {
	assert.match(uia, /fn complete_default_query/);
	assert.match(uia, /status\.0 != 0/);
	assert.match(uia, /Interface::vtable\(root\)\.FindAllBuildCache/);
	assert.match(uia, /IUIAutomationElementArray::from_raw/);
	assert.match(uia, /raw\.is_null/);
	assert.match(uia, /fn default_query_failure_is_never_known_empty/);
});
test("non-default controls never read labels and a selected default requires full protection", () => {
	const body = uia.slice(uia.indexOf("    fn default_button("), uia.indexOf("    pub fn focused("));
	assert.match(body, /unique_default/);
	assert.match(body, /STATE_SYSTEM_DEFAULT/);
	assert.match(body, /self\.validate_default_ancestry/);
	assert.ok(body.indexOf("unique_default(") < body.indexOf("self.describe"));
	assert.ok(body.indexOf("self.validate_default_ancestry") < body.indexOf("self.describe"));
	const metadata = uia.slice(
		uia.indexOf("    fn default_state("),
		uia.indexOf("    fn validate_default_ancestry("),
	);
	assert.doesNotMatch(
		metadata,
		/CurrentIsEnabled|CurrentIsOffscreen|CurrentName|CurrentHelpText|CurrentValue/,
	);
	assert.match(metadata, /CurrentIsPassword/);
	assert.match(metadata, /STATE_SYSTEM_PROTECTED/);
	assert.match(uia, /fn sparse_defaults_ignore_layout_and_disabled_nondefaults/);
	assert.match(uia, /fn ambiguous_or_unavailable_defaults_never_read_labels/);
});
test("unknown activation retains its actual fixed metadata failure without bypassing guards", () => {
	assert.match(native, /if needs_default_facts\(event, &fresh.focus\)/);
	assert.match(native, /default_failure/);
	assert.match(uia, /default_unknown_candidates/);
	assert.match(uia, /default_unknown_legacy/);
	assert.match(uia, /default_unknown_query/);
	assert.match(uia, /default_unknown_ancestry/);
	assert.doesNotMatch(uia, /\.SetFocus\(|GetCurrentPatternAs::<IUIAutomation(?:Value|Text)Pattern>/);
});
