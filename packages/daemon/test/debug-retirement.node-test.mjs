import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const daemon = source("../src/daemon.ts");
function appRequest(text) {
	const start = text.indexOf("async function appRequest(");
	const end = text.indexOf("\nfunction allowedOrigins(", start);
	return Function(
		"parseClientMessage",
		stripTypeScriptTypes(text.slice(start, end)) + ";return appRequest;",
	)((value) => JSON.parse(value));
}

test("retired debug IPC uses exact unknown-request refusal without collaborators or mutation", async () => {
	// Structural guard covers the dispatch wrapper; the extracted shared dispatcher is executable.
	assert.doesNotMatch(daemon, /debugRequest|applyDebug|createRddDebug|rddDebugArgs/);
	const dispatch = appRequest(daemon);
	const inert = new Proxy(
		{},
		{
			get() {
				assert.fail("retired IPC must not touch collaborators");
			},
		},
	);
	for (const params of [undefined, {}, { debug: true }, { debug: false }, { debug: "original" }, []]) {
		await assert.rejects(dispatch("debug_set", params, inert, inert, inert), {
			message: "Unknown request: debug_set",
		});
	}
});

test("daemon no longer propagates preference or collects private trace", () => {
	assert.doesNotMatch(source("../src/config.ts"), /debugFlag|debug\??:|file\.debug/);
	assert.doesNotMatch(source("../src/cli.ts"), /debug: config\.debug/);
	assert.doesNotMatch(daemon, /rddDebug|debug\?: boolean/);
});

test("public config ignores every legacy debug value without rewriting stored keys", () => {
	const original = source("../src/config.ts");
	const executable = stripTypeScriptTypes(
		original.replace(/^import .*;\n/gm, "").replaceAll("import.meta.url", JSON.stringify(import.meta.url)),
	).replace(/^export /gm, "");
	let reads = 0,
		persisted;
	const loadConfig = Function(
		"existsSync",
		"readFileSync",
		"join",
		"resolve",
		"fileURLToPath",
		"homedir",
		"runtimeDir",
		executable + ";return loadConfig;",
	)(
		() => true,
		() => {
			reads++;
			return persisted;
		},
		join,
		resolve,
		fileURLToPath,
		() => assert.fail("no user home lookup"),
		() => undefined,
	);
	for (const debug of [true, false, null, "old-value", { legacy: true }]) {
		persisted = JSON.stringify({ debug, port: 4321, memory: "private", workspace: "/chosen" });
		const before = persisted;
		const config = loadConfig({
			GENTLE_DOT_DATA_DIR: "/synthetic-config",
			GENTLE_DOT_AGENT_ARGS: '["inert"]',
		});
		assert.equal(Object.hasOwn(config, "debug"), false);
		assert.equal(config.port, 4321);
		assert.equal(config.memory, "private");
		assert.equal(config.preferredFolder, resolve("/chosen"));
		assert.equal(persisted, before);
	}
	assert.equal(reads, 5);
});

test("review status registers no private flag, opens no collector, and keeps ordinary status", async () => {
	const { registerReviewStatus } = await import("../src/extensions/review-status.ts");
	let tool,
		calls = 0;
	const pi = {
		registerTool(value) {
			tool = value;
		},
		on() {},
		registerFlag() {
			assert.fail("no retired flag");
		},
		getFlag() {
			assert.fail("no retired flag read");
		},
		getSettings() {
			assert.fail("execution must not probe capture eligibility");
		},
		getActiveTools() {
			assert.fail("execution must not probe capture eligibility");
		},
	};
	registerReviewStatus(pi, {}, async () => ({
		reviewMode: async (request) => {
			calls++;
			assert.equal(request.operation, "status");
			assert.equal(request.cwd, "/synthetic");
			return {
				operation: "status",
				scope: "both",
				status: { global: "", cloneLocal: "on", effective: "on", source: "clone_local" },
			};
		},
	}));
	const result = await tool.execute("test", {}, undefined, undefined, { cwd: "/synthetic" });
	assert.deepEqual(result.details, {
		ok: true,
		readOnly: true,
		status: { global: "", cloneLocal: "on", effective: "on", source: "clone_local" },
	});
	assert.equal(calls, 1);
	assert.doesNotMatch(
		source("../src/extensions/review-status.ts"),
		/beginRddCapture|RddCapture|RDD_TRACE_FLAG|capture\?\./,
	);
});

test("packaged extensions exclude optional private capture but retain core guards and guidance", () => {
	const build = source("../src/runtime-build.ts");
	assert.doesNotMatch(build, /"rdd-private-(?:transport|capture)\.ts"/);
	for (const file of [
		"approval-guard.ts",
		"windows-powershell.ts",
		"powershell-operations.ts",
		"review-status.ts",
		"diagnostic-guidance.ts",
	])
		assert.ok(build.includes('"' + file + '"'));
});

const native = (file) => source("../../../apps/desktop/src-tauri/" + file);
test("STRUCTURAL: native feature IPC, handlers and module registrations are retired", () => {
	for (const file of ["src/shell.rs", "src/app_channel.rs", "src/lib.rs"])
		assert.doesNotMatch(
			native(file),
			/debug_get|debug_set|debug_settings|rdd_diagnostic|connector_diagnostic|DiagnosticRequest/,
		);
	assert.match(native("src/app_channel.rs"), /Unknown method|unknown method|Unknown request|unknown request/);
});
test("STRUCTURAL: build permissions and panel capabilities no longer grant retired commands", () => {
	assert.doesNotMatch(native("build.rs"), /"debug_(?:get|set)"/);
	assert.doesNotMatch(native("capabilities/default.json"), /allow-debug-(?:get|set)/);
});
test("STRUCTURAL: debug reader/writer gone; unrelated settings retain all old keys and private writer", () => {
	const config = native("src/config.rs");
	assert.doesNotMatch(config, /pub fn (?:save_debug|read_debug|debug_value)/);
	assert.match(config, /fn with_key\(/);
	assert.match(config, /json\[key\] = value/);
	// Retain a pre-existing serialized writer without introducing it in other source variants.
	if (config.includes("static SETTINGS_WRITE")) assert.match(config, /SETTINGS_WRITE\.lock\(\)/);
	assert.match(config, /fn write_private\(/);
	assert.match(config, /fn unrelated_settings_preserve_retired_debug_key/);
});
