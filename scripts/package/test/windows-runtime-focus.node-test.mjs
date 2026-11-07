// Source contracts only; native runtime identity and desktop behavior require Windows proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const native = readFileSync(new URL("apps/desktop/src-tauri/src/computer/win32/mod.rs", root), "utf8");
const uia = readFileSync(new URL("apps/desktop/src-tauri/src/computer/win32/uia.rs", root), "utf8");
test("field typing binds to a validated opaque identity rather than exact geometry", () => {
	const match = native.match(/fn admit_keyboard\([\s\S]*?\n\}/)[0];
	assert.match(match, /runtime_id/);
	assert.match(match, /valid_runtime_id/);
	assert.match(match, /expected\.window != fresh\.window/);
	assert.match(match, /expected\.app != fresh\.app/);
	assert.match(match, /expected\.focus\.element\.role != fresh\.focus\.element\.role/);
	assert.match(match, /return Err\("element_identity"\)/);
	assert.doesNotMatch(match, /\.frame/);
});
test("runtime IDs are bounded typed owned arrays; capture does not acquire them", () => {
	assert.match(uia, /runtime_id: Option<Vec<i32>>/);
	for (const api of [
		"GetRuntimeId",
		"SafeArrayGetDim",
		"SafeArrayGetVartype",
		"SafeArrayGetElemsize",
		"SafeArrayGetLBound",
		"SafeArrayGetUBound",
		"SafeArrayGetElement",
		"SafeArrayDestroy",
	])
		assert.ok(uia.includes(api), api);
	assert.match(uia, /VT_I4/);
	assert.match(uia, /MAX_RUNTIME_ID.*64/);
	assert.match(uia, /let runtime_id = if read_identity/);
	assert.match(uia, /pub fn focused_target[\s\S]*?focused_query\(false, None, false\)/);
	assert.match(uia, /impl Drop for RuntimeIdArray/);
});
