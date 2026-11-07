import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Execute the verbatim production functions with mocked IPC/notice dependencies.
// This does not reproduce Tauri, React dispatch, window visibility or native hangs.
const desktop = readFileSync(new URL("../src/desktop.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
// Structural Rust contract only: this cannot execute mutexes or prove native hiding.
const shell = readFileSync(new URL("../../../apps/desktop/src-tauri/src/shell.rs", import.meta.url), "utf8");
test("hide releases fullscreen bookkeeping before querying window geometry", () => {
	const body = shell.match(/fn hide_panel\(app: AppHandle\) -> CommandResult \{([\s\S]*?)\n\}/)?.[1];
	assert.ok(body, "native hide command must remain identifiable");
	assert.match(
		body,
		/let remember_spot = shell\.full_screen\.lock\(\)\.unwrap\(\)\.is_none\(\);\s*if remember_spot \{/,
	);
	assert.doesNotMatch(body, /if shell\.full_screen\.lock\(/);
	assert.match(
		body,
		/if let Ok\(rect\) = rect_of\(&panel\) \{\s*\*shell\.panel_spot\.lock\(\)\.unwrap\(\) = Some\(\(rect\.x, rect\.y\)\);/,
	);
	assert.match(
		body,
		/#\[cfg\(target_os = "windows"\)\]\s*computer::windows_user_visibility\(&app, PANEL, false, true\);\s*panel\.hide\(\)\.map_err\(err\)/,
	);
});
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function bridge(native, invoke) {
	const match = desktop.match(
		/export (async )?function hidePanel\(\): (?:Promise<void>|void) \{\n([\s\S]*?)^\}/m,
	);
	assert.ok(match, "production hidePanel must remain identifiable");
	return new (match[1] ? AsyncFunction : Function)("inDesktop", "invoke", match[2]).bind(
		null,
		() => native,
		invoke,
	);
}
function action(hidePanel, dispatch, t) {
	const match = app.match(/const hide = useCallback\((async \(\) => \{[\s\S]*?\n\t\}), \[dispatch, t\]\);/);
	assert.ok(match, "Hide and Escape need a shared error-handling action");
	assert.match(app, /onHide: hide/);
	assert.match(app, /else void hide\(\);/);
	assert.match(app, /\[surface, send, fullscreenNow, setFullscreen, hide\]/);
	return Function("hidePanel", "dispatch", "t", "return " + match[1])(hidePanel, dispatch, t);
}

test("hide preserves the browser no-op", async () => {
	let calls = 0;
	await bridge(false, () => {
		calls++;
	})();
	assert.equal(calls, 0);
});
test("hide invokes the unchanged native command exactly once", async () => {
	const calls = [];
	await bridge(true, (...args) => {
		calls.push(args);
		return Promise.resolve();
	})();
	assert.deepEqual(calls, [["hide_panel"]]);
});
test("hide exposes the original native rejection without retrying", async () => {
	let reject,
		calls = 0;
	const native = new Promise((_, failure) => {
		reject = failure;
	});
	const result = bridge(true, () => {
		calls++;
		return native;
	})();
	assert.ok(result instanceof Promise, "caller must observe IPC completion");
	const reason = new Error("window hide refused");
	reject(reason);
	await assert.rejects(result, (error) => error === reason);
	assert.equal(calls, 1);
});
test("both Hide routes report one failure through existing notices, not on success", async () => {
	const notices = [];
	let calls = 0;
	const t = (key) => {
		assert.equal(key, "chatHideFailed");
		return "No se pudo ocultar el chat:";
	};
	await action(
		async () => {
			calls++;
		},
		(notice) => notices.push(notice),
		t,
	)();
	assert.equal(calls, 1);
	assert.deepEqual(notices, []);
	await action(
		async () => {
			calls++;
			throw "native hide refused";
		},
		(notice) => notices.push(notice),
		t,
	)();
	assert.equal(calls, 2);
	assert.deepEqual(notices, [
		{
			type: "notice",
			level: "error",
			message: "No se pudo ocultar el chat: native hide refused",
			display: { kind: "hideFailed", reason: "native hide refused" },
		},
	]);
});
