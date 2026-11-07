// Source contracts plus a reference effect model. NO Rust/native execution or geometry proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const own = read("apps/desktop/src-tauri/src/computer/win32/own_windows.rs");
const native = read("apps/desktop/src-tauri/src/computer/win32/capture.rs");
const config = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
const tao = "Tao Thread Event Target",
	sic = `${config.identifier}-sic`;

test("capture-local exception is wired only for unregistered windows, with two fresh samples", () => {
	assert.match(
		own,
		/if !windows\.contains\(&window\) && capture_infrastructure\(window, thread\) \{ continue; \}/,
	);
	const helper = own.match(/fn capture_infrastructure\([\s\S]*?\n\}/)?.[0];
	assert.ok(helper, "required new capture-local helper");
	assert.equal((helper.match(/infrastructure_sample\(window, thread\)/g) ?? []).length, 2);
	assert.match(helper, /infrastructure_pair\(&first, &second\)/);
	assert.doesNotMatch(helper, /GetCurrentThreadId|ShowWindow|register|restore|static|loop/);
});
test("exact pinned helper classes and identifier alignment; no generic zero-area exemption", () => {
	assert.ok(own.includes(`const TAO_EVENT_CLASS: &str = "${tao}";`));
	assert.ok(own.includes(`const SINGLE_INSTANCE_CLASS: &str = "${sic}";`));
	assert.match(own, /name == TAO_EVENT_CLASS \|\| name == SINGLE_INSTANCE_CLASS/);
	assert.doesNotMatch(own, /starts_with|ends_with/);
	assert.match(own, /first == second && known_infrastructure_class\(&first\.class\)/);
	assert.match(own, /zero_extent\(first\.client\) && valid_outer\(first\.outer\)/);
	assert.match(own, /infrastructure_styles\(first\.style, first\.extended\)/);
	assert.match(own, /style & !WS_CLIPSIBLINGS\.0 == \(WS_POPUP \| WS_VISIBLE\)\.0/);
	assert.match(
		own,
		/extended == \(WS_EX_NOACTIVATE \| WS_EX_LAYERED \| WS_EX_TOOLWINDOW \| WS_EX_TRANSPARENT\)\.0/,
	);
	assert.match(own, /rect\[0\] == rect\[2\] && rect\[1\] == rect\[3\]/);
});
test("native samples require complete valid class, both rectangles and revalidated identity", () => {
	const sample = own.match(/fn infrastructure_sample\([\s\S]*?\n\}/)?.[0];
	assert.ok(sample);
	assert.equal((sample.match(/ui_window\(window, thread\)\.ok\(\)\?/g) ?? []).length, 2);
	assert.match(sample, /GetClassNameW\(hwnd\(window\), &mut class\)/);
	assert.match(sample, /if !known_infrastructure_class\(&class\) \{ return None; \}/);
	assert.match(sample, /GetWindowRect\(hwnd\(window\), &mut outer\) \}\.ok\(\)\?/);
	assert.match(sample, /GetClientRect\(hwnd\(window\), &mut client\) \}\.ok\(\)\?/);
	assert.match(sample, /GetWindowLongW\(hwnd\(window\), GWL_STYLE\)/);
	assert.match(sample, /GetWindowLongW\(hwnd\(window\), GWL_EXSTYLE\)/);
	assert.match(own, /length == 0 \|\| length >= buffer\.len\(\) - 1/);
	assert.match(own, /buffer\[length\] != 0 \|\| buffer\[\.\.length\]\.contains\(&0\)/);
	assert.match(own, /String::from_utf16\(&buffer\[\.\.length\]\)\.ok\(\)/);
});
test("registered visibility, normal refusal and all existing compositor/readback barriers remain", () => {
	assert.match(
		own,
		/for &window in &windows \{\s*ui_window\(window, thread\)\?;\s*if identity::visible\(window\) \{ return Err\("registered own window became visible during capture"/,
	);
	assert.match(
		own,
		/identity::visible\(window\) && identity::window_pid\(hwnd\(window\)\)\? == std::process::id\(\)/,
	);
	assert.match(
		own,
		/visible own window prevents capture exclusion: hwnd=0x\{window:x\}, thread=\{owner_thread\}, registered=\{\}/,
	);
	assert.equal((native.match(/own\.verify_capture_hidden\(\)\?/g) ?? []).length, 4);
	assert.match(
		native,
		/DwmFlush\(\)[\s\S]*?own\.verify_capture_hidden\(\)\?[\s\S]*?BitBlt[\s\S]*?GetDIBits[\s\S]*?own\.verify_capture_hidden\(\)\?/,
	);
	assert.doesNotMatch(own, /GetWindowText|GetWindowTitle|eprintln!|println!/);
});

// Reference MODEL ONLY: accepted means continue capture verification, never hide or grant input.
const sample = (className = tao) => ({
	className,
	live: true,
	ownPid: true,
	registeringThread: true,
	rootSelf: true,
	classComplete: true,
	outerOk: true,
	clientOk: true,
	style: 0x94000000,
	extended: 0x080800a0,
	outer: [0, 0, 0, 0],
	client: [0, 0, 0, 0],
});
const clone = (value) => structuredClone(value);
const zero = (rect) => rect.length === 4 && rect[0] === rect[2] && rect[1] === rect[3];
const validOuter = (rect) =>
	rect[0] <= rect[2] && rect[1] <= rect[3] && (rect[0] === rect[2]) === (rect[1] === rect[3]);
const helperStyles = (style, extended) =>
	(style & ~0x04000000) >>> 0 === 0x90000000 && extended === 0x080800a0;
const complete = (s) =>
	s &&
	s.live &&
	s.ownPid &&
	s.registeringThread &&
	s.rootSelf &&
	s.classComplete &&
	s.outerOk &&
	s.clientOk &&
	[tao, sic].includes(s.className) &&
	validOuter(s.outer) &&
	zero(s.client) &&
	helperStyles(s.style, s.extended);
const accepts = (registered, first, second) =>
	!registered && !!complete(first) && !!complete(second) && JSON.stringify(first) === JSON.stringify(second);
for (const className of [tao, sic])
	test(`reference model allows stable validated 0x0 ${className}`, () => {
		const first = sample(className);
		assert.equal(accepts(false, first, clone(first)), true);
	});
// Exercise the source predicate's boolean expression with explicit metadata stubs.
// This is not Rust compilation, native-query execution or a no-painted-pixels proof.
const pairExpression = own.match(/fn infrastructure_pair\([^\n]*\) -> bool \{\n([\s\S]*?)\n\}/)?.[1];
assert.ok(pairExpression);
const sourcePair = new Function(
	"first",
	"second",
	"known_infrastructure_class",
	"zero_extent",
	"valid_outer",
	"infrastructure_styles",
	`return (${pairExpression
		.trim()
		.replace("first == second", "JSON.stringify(first) === JSON.stringify(second)")
		.replaceAll("&first.class", "first.class")});`,
);
for (const className of [tao, sic])
	test(`source predicate accepts the observed empty-client framework profile: ${className}`, () => {
		const first = {
			class: className,
			outer: [0, 0, 16, 16],
			client: [0, 0, 0, 0],
			style: 0x94000000,
			extended: 0x080800a0,
		};
		assert.equal(
			sourcePair(first, clone(first), (name) => [tao, sic].includes(name), zero, validOuter, helperStyles),
			true,
		);
	});

const rejected = [
	[
		"unknown zero-area",
		(s) => {
			s.className = "Unknown";
		},
	],
	[
		"Tauri Window zero-area",
		(s) => {
			s.className = "Tauri Window";
		},
	],
	[
		"helper suffix spoof",
		(s) => {
			s.className += "-extra";
		},
	],
	[
		"zero/failed style query",
		(s) => {
			s.style = 0;
		},
	],
	[
		"zero/failed extended-style query",
		(s) => {
			s.extended = 0;
		},
	],
	[
		"caption-bearing helper",
		(s) => {
			s.style = (s.style | 0x00c00000) >>> 0;
		},
	],
	[
		"child-window helper",
		(s) => {
			s.style = (s.style | 0x40000000) >>> 0;
		},
	],
	[
		"topmost helper",
		(s) => {
			s.extended |= 0x00000008;
		},
	],
	[
		"non-layered helper",
		(s) => {
			s.extended &= ~0x00080000;
		},
	],
	[
		"activating helper",
		(s) => {
			s.extended &= ~0x08000000;
		},
	],
	[
		"helper missing the transparent-style flag",
		(s) => {
			s.extended &= ~0x00000020;
		},
	],
	[
		"non-tool helper",
		(s) => {
			s.extended &= ~0x00000080;
		},
	],
	[
		"outer positive width only",
		(s) => {
			s.outer[2] = 1;
		},
	],
	[
		"outer positive height only",
		(s) => {
			s.outer[3] = 1;
		},
	],
	[
		"client positive width only",
		(s) => {
			s.client[2] = 1;
		},
	],
	[
		"client positive height only",
		(s) => {
			s.client[3] = 1;
		},
	],
	[
		"outer inverted width",
		(s) => {
			s.outer[2] = -1;
		},
	],
	[
		"client inverted height",
		(s) => {
			s.client[3] = -1;
		},
	],
	[
		"dead HWND",
		(s) => {
			s.live = false;
		},
	],
	[
		"PID mismatch",
		(s) => {
			s.ownPid = false;
		},
	],
	[
		"registering-thread mismatch",
		(s) => {
			s.registeringThread = false;
		},
	],
	[
		"root mismatch",
		(s) => {
			s.rootSelf = false;
		},
	],
	[
		"truncated/invalid class",
		(s) => {
			s.classComplete = false;
		},
	],
	[
		"outer query failure",
		(s) => {
			s.outerOk = false;
		},
	],
	[
		"client query failure",
		(s) => {
			s.clientOk = false;
		},
	],
];
for (const [name, mutate] of rejected)
	test(`reference model refuses ${name}`, () => {
		const first = sample();
		mutate(first);
		assert.equal(accepts(false, first, clone(first)), false);
	});
test("helper profile preserves zero geometry and accepts optional system CLIPSIBLINGS only", () => {
	const legacy = sample();
	legacy.style = 0x90000000;
	assert.equal(accepts(false, legacy, clone(legacy)), true);
	const observed = sample(sic);
	observed.outer = [0, 0, 16, 16];
	assert.equal(accepts(false, observed, clone(observed)), true);
	const changedStyle = clone(observed);
	changedStyle.extended |= 8;
	assert.equal(accepts(false, observed, changedStyle), false);
});

test("reference model refuses registered helpers, missing reads and changing metadata", () => {
	const first = sample();
	assert.equal(accepts(true, first, clone(first)), false);
	assert.equal(accepts(false, first, undefined), false);
	const changedClass = sample(sic);
	assert.equal(accepts(false, first, changedClass), false);
	const moved = sample();
	moved.outer = [1, 1, 1, 1];
	assert.equal(accepts(false, first, moved), false);
	const foreign = sample();
	foreign.ownPid = false;
	assert.equal(accepts(false, first, foreign), false);
});
