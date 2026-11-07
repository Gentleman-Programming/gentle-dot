// Source-contract checks and explicitly labelled effect models, NOT Rust/native execution.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) =>
	readFileSync(new URL(`../../../apps/desktop/src-tauri/src/${path}`, import.meta.url), "utf8");
const runtime = source("computer/windows_app.rs");
const capture = source("computer/windows_app/capture.rs");
const own = source("computer/win32/own_windows.rs");
const shell = source("shell.rs");

test("missing Computer and ordinary noncapture preserve show/focus/event effects", () => {
	// Source-selected gate model: inspect the actual missing-state return, not a compiler.
	const missing = runtime.match(/pub fn user_visibility[\s\S]*?else \{ return (true|false) \}/);
	assert.ok(missing);
	const effects = (allowed) => (allowed ? ["show", "focus", "panel-shown"] : []);
	assert.deepEqual(effects(missing[1] === "true"), ["show", "focus", "panel-shown"]);
	assert.match(runtime, /updated && !suspended/);
	assert.deepEqual(effects(true && !false), ["show", "focus", "panel-shown"]);
});
test("explicit deferred panel effects have a post-guard replay, not only SW_SHOWNA", () => {
	const end = runtime.slice(runtime.indexOf("fn end_capture("), runtime.indexOf("fn working_operation("));
	// Source-selected capability model: old end_capture loses both observable effects.
	const replay = /set_focus\(\)/.test(end) && /emit\("dot:\/\/panel-shown"/.test(end);
	const effects = ["restore-visible", ...(replay ? ["focus", "panel-shown"] : [])];
	assert.deepEqual(effects, ["restore-visible", "focus", "panel-shown"]);
	assert.match(end, /panel_effects\.take\(\)/);
});

test("explicit replay is current-intent fenced, failure-cancelled and distinct from Working", () => {
	assert.match(runtime, /if index == 1 && explicit/);
	assert.match(runtime, /state\.panel_revision = state\.panel_revision\.wrapping_add\(1\)/);
	assert.match(runtime, /state\.panel && state\.panel_revision == revision/);
	assert.match(runtime, /self\.require_operation\(\)\.is_ok\(\) && self\.grants\.current/);
	assert.match(runtime, /pending\.filter\(\|_\| restored\)/);
	assert.match(
		runtime,
		/panel\.set_focus\(\)[\s\S]*?panel_effects_current\(revision, stamp\)[\s\S]*?emit\("dot:\/\/panel-shown"/,
	);
	assert.match(
		capture,
		/let restored = guard\.finish\(\);\s*let effects = runtime\.end_capture\(restored\.is_ok\(\)\)/,
	);
});
test("reference effect model: explicit replay once, hides/Stop/failure/reentry cancel; Working never focuses", () => {
	// Reference MODEL, not Rust execution; source contracts above bind the integration points.
	function model() {
		let revision = 0,
			pending,
			intent = false,
			deferred = false,
			stopped = false;
		const effects = [];
		const request = (visible, explicit = true) => {
			intent = visible;
			deferred = visible;
			if (explicit) {
				revision++;
				pending = visible ? revision : undefined;
			}
		};
		const finish = (restored = true, reenter = () => {}) => {
			if (restored && intent && deferred) effects.push("restore-visible");
			deferred = false;
			const ticket = pending;
			pending = undefined;
			const current = () => intent && !stopped && revision === ticket;
			if (!restored || ticket === undefined || !current()) return;
			effects.push("focus");
			reenter();
			if (current()) effects.push("panel-shown");
		};
		return {
			request,
			finish,
			effects,
			stop: () => {
				stopped = true;
			},
		};
	}
	const explicit = model();
	explicit.request(true);
	assert.deepEqual(explicit.effects, []);
	explicit.finish();
	explicit.finish();
	assert.deepEqual(explicit.effects, ["restore-visible", "focus", "panel-shown"]);
	const hidden = model();
	hidden.request(true);
	hidden.request(false);
	hidden.finish();
	assert.deepEqual(hidden.effects, []);
	const working = model();
	working.request(true, false);
	working.finish();
	assert.deepEqual(working.effects, ["restore-visible"]);
	const mixed = model();
	mixed.request(true);
	mixed.request(true, false);
	mixed.finish();
	assert.deepEqual(mixed.effects, ["restore-visible", "focus", "panel-shown"]);
	for (const cancelled of ["stop", "failure"]) {
		const state = model();
		state.request(true);
		if (cancelled === "stop") state.stop();
		state.finish(cancelled !== "failure");
		assert.equal(state.effects.includes("focus"), false);
	}
	const reentrant = model();
	reentrant.request(true);
	reentrant.finish(true, () => reentrant.request(false));
	assert.deepEqual(reentrant.effects, ["restore-visible", "focus"]);
});

test("ordinary Dot and panel shows are gated, including focus", () => {
	assert.match(shell, /let show_now = computer::windows_user_visibility\(&app, DOT, !hidden, true\)/);
	assert.match(shell, /else if show_now\s*\{\s*dot\.show/);
	assert.match(
		shell,
		/if !computer::windows_user_visibility\(app, PANEL, true, true\) \{ return Ok\(\(\)\); \}/,
	);
});
test("capture intent is checked before minimized-panel restoration can show a window", () => {
	const show = shell.match(/fn show_panel\([\s\S]*?\n\}/)?.[0];
	assert.ok(show);
	const gate = show.indexOf("if !computer::windows_user_visibility(app, PANEL, true, true)");
	assert.ok(gate >= 0);
	assert.ok(gate < show.indexOf("restore_panel("));
	assert.ok(gate < show.indexOf("place_panel("));
	assert.ok(gate < show.indexOf("panel.show()"));
	assert.ok(gate < show.indexOf("panel.set_focus()"));
});

test("deferred explicit intent covers initially hidden registered windows only", () => {
	assert.match(runtime, /deferred: \[bool; 2\]/);
	assert.match(runtime, /was_visible \|\| deferred/);
	assert.match(runtime, /state\.deferred\[index\] = visible && suspended/);
	assert.match(own, /if was_visible \|\| guard\.desired\.is_some\(\)/);
	assert.match(capture, /desired\.capture_desired\(handle, was_visible\)/);
});
test("ticket and guard remain UI-owned through finish; deferred state clears afterward", () => {
	assert.ok(
		capture.indexOf("let restored = guard.finish();") <
			capture.indexOf("runtime.end_capture(restored.is_ok())"),
	);
	assert.match(capture, /matching_ticket\(slot\.as_ref\(\)\.map/);
	assert.match(own, /PhantomData<Rc<\(\)>>/);
	assert.match(own, /window intent changed during restoration/);
});
test("Working restoration cannot show across capture and retains eligible end intent", () => {
	const restore = runtime.slice(runtime.indexOf("pub fn restore_shell_window"));
	assert.match(restore, /desired\(hwnd, true\)/);
	assert.match(restore, /capturing\.load/);
	assert.match(restore, /user_visibility\(app, window\.label\(\), true, false\)/);
	assert.match(runtime, /self\.windows\.rose_hidden\(\)/);
	assert.match(runtime, /Kind::Glow => self\.available\(\) && self\.control\.is_active/);
	assert.match(own, /desired\(\*window, \*was_visible\)\.ok\(\) != Some\(\*visible\)/);
});
test("pure intent model: only current explicit deferred shows extend snapshot eligibility", () => {
	// A truth-table model, NOT execution of the Rust coordinator.
	const restore = (snapshot, deferred, userVisible, roseHidden = false) =>
		(snapshot || deferred) && userVisible && !roseHidden;
	assert.equal(restore(false, false, true), false); // Working-hidden default
	assert.equal(restore(false, true, true), true); // initially hidden, explicitly requested
	assert.equal(restore(false, false, false), false); // show then hide clears pending
	assert.equal(restore(true, false, false), false); // hide beats snapshot
	assert.equal(restore(true, true, true, true), false); // current Hide Rose
});
test("pixel acquisition and input/session fences remain in place", () => {
	assert.match(
		capture,
		/let result = self\.runtime\.require_epoch\(epoch\)\.and_then\(\|\(\)\| self\.native\.capture\(\)\);\s*ticket\.finish\(\)\?;/,
	);
	assert.match(capture, /working_operation\(\) \|\| self\.runtime\.capturing\.load/);
	assert.match(capture, /rt\.require_operation\(\)\?/);
	assert.match(capture, /drop\(guard\);\s*let _ = rt\.end_capture\(false\)/);
});
test("strict visibility refusal gains only bounded ordinary error metadata", () => {
	assert.match(own, /visible own window prevents capture exclusion: hwnd=0x/);
	assert.match(own, /registered=\{\}/);
	assert.match(own, /identity::visible\(window\) && identity::window_pid/);
	assert.match(own, /affinity != WDA_EXCLUDEFROMCAPTURE/);
	// S12 allows private class metadata for capture classification, never diagnostic content.
	assert.doesNotMatch(own, /GetWindowText|GetWindowTitle/);
	const refusal = own.match(
		/return Err\(format!\("visible own window prevents capture exclusion: ([^"]*)", windows\.contains\(&window\)\)\);/,
	);
	assert.ok(refusal);
	assert.equal(refusal[1], "hwnd=0x{window:x}, thread={owner_thread}, registered={}");
	assert.doesNotMatch(refusal[0], /GetClassNameW|class|title|text|content/);
});
