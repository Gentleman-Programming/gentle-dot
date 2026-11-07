import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

test("accepted Hide fix no longer installs tracing, writes trace logs or exposes trace IPC", () => {
	for (const path of [
		"apps/desktop/src-tauri/src/hide_trace.rs",
		"apps/desktop/src-tauri/src/hide_trace/windows.rs",
		"packages/ui/src/hide-trace.ts",
	])
		assert.equal(existsSync(new URL(path, root)), false, path);
	for (const path of [
		"apps/desktop/src-tauri/src/lib.rs",
		"apps/desktop/src-tauri/build.rs",
		"apps/desktop/src-tauri/capabilities/default.json",
		"apps/desktop/src-tauri/src/shell.rs",
		"apps/desktop/src-tauri/src/computer/windows_app.rs",
		"packages/ui/src/desktop.ts",
		"packages/ui/src/App.tsx",
		"packages/ui/src/components/ChatSurface.tsx",
	])
		assert.doesNotMatch(
			source(path),
			/hide_trace|hide-trace|HideTrace|beginHideTrace|markHideTrace|trace_id|traceId|escapeIds|hidePointer/,
			path,
		);
	const capabilities = JSON.parse(source("apps/desktop/src-tauri/capabilities/default.json")).capabilities;
	const general = capabilities.find((capability) => capability.identifier === "default");
	for (const permission of ["allow-hide-panel", "allow-computer-stop", "allow-computer-request-permission"]) {
		assert.ok(general.permissions.includes(permission), permission);
	}
});

// Execute the verbatim handler with mocks; not a browser or native visibility test.
test("Escape still respects prevention and fullscreen before hiding and ignores ordinary keys", () => {
	const app = source("packages/ui/src/App.tsx");
	const body = app.match(/const onKey = \(event: KeyboardEvent\) => \{([\s\S]*?)\n\t\t\};/)[1];
	const fullscreen = { current: false },
		hidden = [],
		changes = [];
	const onKey = Function(
		"fullscreenNow",
		"setFullscreen",
		"hide",
		"isFullscreenShortcut",
		"return event => {" + body + "}",
	)(
		fullscreen,
		(value) => changes.push(value),
		() => hidden.push(true),
		() => false,
	);
	onKey({ key: "Escape", defaultPrevented: true });
	assert.deepEqual(hidden, []);
	assert.deepEqual(changes, []);
	onKey({ key: "Escape", defaultPrevented: false });
	assert.deepEqual(hidden, [true]);
	fullscreen.current = true;
	onKey({ key: "Escape", defaultPrevented: false });
	assert.deepEqual(hidden, [true]);
	assert.deepEqual(changes, [false]);
	onKey({ key: "a", defaultPrevented: false });
	assert.deepEqual(hidden, [true]);
	assert.deepEqual(changes, [false]);
	assert.match(app, /removeEventListener\("keydown", onKey\)/);
	const surface = source("packages/ui/src/components/ChatSurface.tsx");
	assert.match(surface, /onClick=\{onHide\}/);
});
