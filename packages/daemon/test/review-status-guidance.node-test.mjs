import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { guidanceFor } from "../src/extensions/diagnostic-guidance.ts";
import { registerReviewStatus } from "../src/extensions/review-status.ts";

const canary = "PRIVATE_CANARY";
const fixture = { factories: 0, requests: [], input: undefined, run: undefined };
globalThis[Symbol.for("dot.guidance.fixture")] = fixture;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "gentle-pi/runtime/native-review-cli.mjs")
			return {
				url: `data:text/javascript,${encodeURIComponent(`
const f = globalThis[Symbol.for('dot.guidance.fixture')];
export function createNodeExecFileAdapter() {
  f.factories++;
  return async request => {
    f.requests.push(request);
    if (f.run.adapterError) throw f.run.adapterError;
    return f.run.result;
  };
}
export function createNativeReviewCli(adapter) {
  return { async reviewMode(input) {
    f.input = input;
    try {
      const result = await adapter(f.run.request);
      if (result !== f.run.result) throw Error('changed result');
    } catch (error) { if (error !== f.run.adapterError) throw error; }
    if (f.run.code) throw { code: f.run.code, message: 'PRIVATE_CANARY' };
    return f.run.status;
  } };
}`)}`,
				shortCircuit: true,
			};
		return next(specifier, context);
	},
});
const cwd = "/synthetic-workspace";
const signal = new AbortController().signal;
const status = {
	operation: "status",
	scope: "both",
	status: {
		global: "",
		cloneLocal: "on",
		effective: "on",
		source: "clone_local",
	},
};
function prepare(overrides = {}) {
	fixture.factories = 0;
	fixture.requests = [];
	fixture.run = {
		code: "non-zero",
		result: Object.freeze({
			stdout: canary,
			stderr: canary,
			exitCode: 1,
			signal: null,
			timedOut: false,
			outputLimitExceeded: false,
		}),
		request: Object.freeze({
			file: "public-resolver-fixture",
			cwd,
			signal,
			timeoutMs: 123,
			maxBufferBytes: 456,
			arguments: Object.freeze(["review", "mode", "status", "--cwd", cwd, "--json"]),
		}),
		...overrides,
	};
}
function harness(options = {}, factory) {
	let tool;
	const handlers = new Map();
	const sets = [];
	let active = options.active ?? ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (value) => {
			tool = value;
		},
		registerFlag() {},
		on: (event, fn) => handlers.set(event, fn),
		getFlag: () => undefined,
		getSettings: () => ({ defaultTools: options.defaults }),
		getActiveTools: () => active,
		getAllTools: () => (tool ? [tool] : []),
		setActiveTools: (value) => {
			sets.push(value);
			active = value;
		},
	};
	if (options.forbidFlag) pi.getFlag = () => assert.fail("restricted invocation must not read debug flag");
	registerReviewStatus(pi, options, factory);
	return {
		get tool() {
			return tool;
		},
		handlers,
		sets,
	};
}
async function invoke(h, expected, operationSignal = signal, params = {}) {
	const result = await h.tool.execute("fixture", params, operationSignal, () => assert.fail("no streaming"), {
		cwd,
	});
	assert.deepEqual(result.details, expected);
	assert.deepEqual(JSON.parse(result.content[0].text), expected);
	assert.equal(result.content.length, expected.ok ? 1 : 2);
	assert.ok(result.content.every((block) => block.type === "text"));
	if (!expected.ok) {
		const guide = JSON.parse(result.content[1].text);
		assert.deepEqual(Object.keys(guide), ["code", "summary", "steps"]);
		assert.ok(guide.summary.length && guide.steps.length);
		assert.deepEqual(guide, guidanceFor("rdd", expected.indicativeHint ?? expected.category));
	}
	assert.ok(!JSON.stringify(result).includes(canary));
	return result;
}
test("debug-off public factory adds fixed guidance without changing legacy payload or adapter identity", async () => {
	for (const code of ["non-zero", "unavailable", "timeout", "malformed-json"]) {
		prepare({ code });
		await invoke(harness(), { ok: false, readOnly: true, category: code });
		assert.equal(fixture.factories, 1);
		assert.deepEqual(fixture.requests, [fixture.run.request]);
		assert.equal(fixture.requests[0], fixture.run.request);
		assert.deepEqual(fixture.input, { cwd, operation: "status", signal });
	}
	prepare({ code: undefined, status });
	await invoke(harness(), { ok: true, readOnly: true, status: status.status });
	assert.equal(fixture.requests.length, 1);
	prepare({ code: "unavailable", adapterError: new Error(canary) });
	await invoke(harness(), { ok: false, readOnly: true, category: "unavailable" });
	assert.equal(fixture.requests[0], fixture.run.request);
	assert.equal(fixture.requests.length, 1);
	const generic = await invoke(
		harness({}, async () => {
			throw Error(canary);
		}),
		{ ok: false, readOnly: true, category: "unknown" },
	);
	const other = await invoke(
		harness({}, async () => {
			throw { code: canary };
		}),
		{ ok: false, readOnly: true, category: "unknown" },
	);
	assert.deepEqual(generic, other);
});
test("existing source-template hints keep exact legacy shape and select fixed manual guidance", async () => {
	const stderr = `the clone-local review mode path "${canary}" is unsafe; run \`synthetic-command\`, then rerun the original command`;
	prepare({
		result: Object.freeze({
			stdout: canary,
			stderr,
			exitCode: 1,
			signal: null,
			timedOut: false,
			outputLimitExceeded: false,
		}),
	});
	await invoke(harness(), {
		ok: false,
		readOnly: true,
		category: "non-zero",
		indicativeHint: "unsafe_clone_mode_path",
	});
	assert.equal(fixture.requests.length, 1);
	assert.equal(fixture.requests[0], fixture.run.request);
	const restricted = harness({ defaults: ["read"], forbidFlag: true }, async () => {
		throw Error(canary);
	});
	await invoke(restricted, { ok: false, readOnly: true, category: "unknown" });
});
test("pre-abort, restricted startup, child and session retirement preserve existing guards", async () => {
	const forbidden = async () => assert.fail("no factory");
	const h = harness({}, forbidden);
	await invoke(h, { ok: false, readOnly: true, category: "cancelled" }, AbortSignal.abort());
	await invoke(h, { ok: false, readOnly: true, category: "invalid-arguments" }, signal, { cwd: canary });
	for (const options of [{ defaults: ["read"] }, { active: ["read"] }]) {
		const restricted = harness(options, forbidden);
		restricted.handlers.get("session_start")();
		assert.deepEqual(restricted.sets, []);
	}
	assert.equal(harness({ subagent: true }, forbidden).tool, undefined);
	h.handlers.get("session_start")();
	assert.equal(h.handlers.has("session_shutdown"), false, "retired capture has no shutdown collector");
	assert.equal(h.sets.length, 1);
});
