import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import guard from "../src/extensions/approval-guard.ts";
import * as statusModule from "../src/extensions/review-status.ts";
import { registerReviewStatus } from "../src/extensions/review-status.ts";

// Any accidental live-client load fails before native resolution or profile access.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith("gentle-pi/")) throw Error("Live native client forbidden in agent tests");
		return next(specifier, context);
	},
});

function harness() {
	const definitions = new Map();
	const handlers = new Map();
	const pi = {
		registerTool: (tool) => definitions.set(tool.name, tool),
		on: (event, handler) => handlers.set(event, handler),
		getAllTools: () => [...definitions.values()],
	};
	return { pi, definitions, handlers };
}

test("owned guard registers a primary status-only tool without loading a native client", async () => {
	const h = harness();
	await guard(h.pi);
	const tool = h.definitions.get("dot_review_status");
	assert.ok(tool, "primary engine must expose dot_review_status through registerTool");
	assert.equal(typeof tool.execute, "function");
	assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false });
	assert.equal(tool.exposure, "direct");
	assert.match(tool.description, /NOT review approval or delivery authority/);
});

const secret = "DO_NOT_DISCLOSE_PRIVATE_VALUE";
const nativeResult = (effective = "on") => ({
	operation: "status",
	scope: "both",
	status: {
		global: "",
		cloneLocal: effective,
		effective,
		source: "clone_local",
		reach: "this_build",
		revision: secret,
		path: secret,
	},
	audit: secret,
	stdout: secret,
});
const ctx = {
	cwd: "/actual-managed-workspace",
	hasUI: false,
	signal: new AbortController().signal,
	ui: new Proxy(
		{},
		{
			get() {
				assert.fail("status must not use any UI channel");
			},
		},
	),
};
const signal = new AbortController().signal;
const noClient = async () => assert.fail("rejected calls must not load the native client");

function registered(factory, options = {}) {
	const h = harness();
	registerReviewStatus(h.pi, options, factory);
	return h.definitions.get("dot_review_status");
}

async function invoke(factory, params = {}, operationSignal = signal) {
	const tool = registered(factory);
	const result = await tool.execute(
		"owner-call",
		params,
		operationSignal,
		() => assert.fail("no streaming side channel"),
		ctx,
	);
	// Failure guidance is additive; the first JSON block and details stay unchanged.
	assert.equal(result.content.length, result.details.ok ? 1 : 2);
	assert.ok(result.content.every((block) => block.type === "text"));
	if (!result.details.ok)
		assert.deepEqual(Object.keys(JSON.parse(result.content[1].text)), ["code", "summary", "steps"]);
	assert.equal(result.content[0].type, "text");
	assert.deepEqual(JSON.parse(result.content[0].text), result.details);
	assert.ok(!JSON.stringify(result).includes(secret));
	return result.details;
}

for (const mode of ["on", "off"]) {
	test(`status ${mode} uses only fixed operation, actual cwd and callback signal`, async () => {
		let requests = 0;
		const details = await invoke(async () => ({
			reviewMode: async (request) => {
				requests++;
				assert.deepEqual(Object.keys(request).sort(), ["cwd", "operation", "signal"]);
				assert.equal(request.cwd, ctx.cwd);
				assert.equal(request.operation, "status");
				assert.equal(request.signal, signal);
				assert.notEqual(request.signal, ctx.signal);
				return nativeResult(mode);
			},
			start: () => assert.fail("no start"),
			assess: () => assert.fail("no assess"),
			reviewStatus: () => assert.fail("no receipt query or fallback"),
		}));
		assert.equal(requests, 1);
		assert.deepEqual(details, {
			ok: true,
			readOnly: true,
			status: {
				global: "",
				cloneLocal: mode,
				effective: mode,
				source: "clone_local",
				reach: "this_build",
			},
		});
	});
}

test("missing capability is unsupported, not mode off or a mutating fallback", async () => {
	assert.deepEqual(await invoke(async () => ({ start: () => assert.fail("no fallback") })), {
		ok: false,
		readOnly: true,
		category: "unsupported",
	});
});

const codes = [
	"unavailable",
	"timeout",
	"non-zero",
	"signal",
	"unexpected-stderr",
	"output-limit",
	"empty-output",
	"malformed-json",
	"schema-incompatible",
	"identity-mismatch",
	"version-incompatible",
	"cancelled",
	"package-local-binary-missing",
	"unsupported-transition-operation",
];
for (const code of codes) {
	test(`native failure ${code} retains only its allowlisted category`, async () => {
		const error = Object.assign(new Error(secret), {
			code,
			launchAttempted: secret,
			mutating: secret,
			diagnostics: { stderr: secret },
			auditRecord: { secret },
			stdout: secret,
		});
		assert.deepEqual(
			await invoke(async () => ({
				reviewMode: async () => {
					throw error;
				},
			})),
			{ ok: false, readOnly: true, category: code },
		);
	});
}

test("unknown errors and factory errors never reflect attacker-controlled strings", async () => {
	for (const error of [secret, new Error(secret), { code: secret, message: secret, stderr: secret }]) {
		assert.deepEqual(
			await invoke(async () => {
				throw error;
			}),
			{ ok: false, readOnly: true, category: "unknown" },
		);
	}
});

test("malformed native modes never become success or authority", async () => {
	for (const result of [
		undefined,
		{ ...nativeResult(), operation: "enable" },
		{ ...nativeResult(), scope: secret },
		...["global", "cloneLocal", "effective", "source", "reach"].map((key) => ({
			...nativeResult(),
			status: { ...nativeResult().status, [key]: secret },
		})),
	]) {
		assert.deepEqual(await invoke(async () => ({ reviewMode: async () => result })), {
			ok: false,
			readOnly: true,
			category: "schema-incompatible",
		});
	}
});

test("pre-abort and injected arguments reject before factory or native activity", async () => {
	assert.deepEqual(await invoke(noClient, {}, AbortSignal.abort()), {
		ok: false,
		readOnly: true,
		category: "cancelled",
	});
	for (const key of ["operation", "cwd", "executable", "env", "argv", "scope"]) {
		assert.deepEqual(await invoke(noClient, { [key]: secret }), {
			ok: false,
			readOnly: true,
			category: "invalid-arguments",
		});
	}
	const abort = new AbortController();
	assert.deepEqual(
		await invoke(
			async () => {
				abort.abort();
				return { reviewMode: () => assert.fail("abort during client loading must not query") };
			},
			{},
			abort.signal,
		),
		{ ok: false, readOnly: true, category: "cancelled" },
	);
});

test("child/reviewer guard neither registers nor permits guessed status calls", async () => {
	assert.equal(registered(noClient, { subagent: true }), undefined);
	const h = harness();
	await guard(h.pi, { subagent: true });
	assert.equal(h.definitions.has("dot_review_status"), false);
	const result = await h.handlers.get("tool_call")({ toolName: "dot_review_status", input: {} }, ctx);
	assert.equal(result.block, true);
});

// Model SDK 1.0.4 includeAllExtensionTools before session_start, not a live session.
function activationHarness({
	defaults,
	active = ["read", "bash", "edit", "write", "other"],
	allowed = true,
} = {}) {
	const h = harness();
	let names = [...(defaults ?? active)];
	const sets = [];
	h.pi.getSettings = () => ({ defaultTools: defaults });
	h.pi.getActiveTools = () => [...names];
	h.pi.getAllTools = () => (allowed ? [...h.definitions.values()] : []);
	h.pi.setActiveTools = (next) => {
		sets.push([...next]);
		names = [...next];
	};
	const start = async () => {
		// _refreshToolRegistry's includeAllExtensionTools / _isActivatedOnRegistration.
		for (const tool of h.pi.getAllTools()) {
			if (["direct", "model-only"].includes(tool.exposure ?? "direct") && tool.defaultActive !== false)
				names = [...new Set([...names, tool.name])];
		}
		const beforeStart = [...names];
		await h.handlers.get("session_start")?.({}, {});
		return beforeStart;
	};
	return { ...h, start, sets };
}

test("B1: SDK registration phase must not expand explicit read-only defaultTools", async () => {
	const h = activationHarness({ defaults: ["read"] });
	registerReviewStatus(h.pi, {}, noClient);
	assert.deepEqual(await h.start(), ["read"]);
	assert.deepEqual(h.pi.getActiveTools(), ["read"]);
	assert.deepEqual(h.sets, []);
});

for (const config of [
	{ defaults: [] },
	{ defaults: ["read", "bash", "edit", "write"] },
	{ allowed: false },
	{ active: ["read"] },
	{ active: ["read", "bash"] },
	{ active: ["read", "edit", "write"] },
	{ active: [] },
]) {
	test(`B1: restricted startup stays unchanged ${JSON.stringify(config)}`, async () => {
		const h = activationHarness(config);
		registerReviewStatus(h.pi, {}, noClient);
		const previous = h.pi.getActiveTools();
		assert.deepEqual(await h.start(), previous);
		assert.deepEqual(h.pi.getActiveTools(), previous);
		assert.deepEqual(h.sets, []);
	});
}

for (const shell of ["bash", "powershell"]) {
	test(`ordinary primary ${shell} loadout activates status only after SDK registration`, async () => {
		const previous = ["read", shell, "edit", "write", "other"];
		const h = activationHarness({ active: previous });
		registerReviewStatus(h.pi, {}, noClient);
		assert.deepEqual(h.pi.getActiveTools(), previous);
		assert.deepEqual(await h.start(), previous);
		assert.deepEqual(h.pi.getActiveTools(), [...previous, "dot_review_status"]);
		await h.start();
		assert.deepEqual(h.sets, [[...previous, "dot_review_status"]], "startup is idempotent");
	});
}

test("unknown or throwing activation APIs fail closed without breaking startup", async () => {
	for (const api of ["getSettings", "getActiveTools", "getAllTools", "setActiveTools"]) {
		const h = activationHarness();
		registerReviewStatus(h.pi, {}, noClient);
		h.pi[api] = () => {
			throw Error("unavailable API");
		};
		assert.doesNotThrow(() => h.handlers.get("session_start")({}, {}));
		assert.deepEqual(h.sets, []);
	}
	const child = activationHarness();
	registerReviewStatus(child.pi, { subagent: true }, noClient);
	assert.equal(child.handlers.has("session_start"), false);
});

test("normal registration leaves restricted registries, defaultTools and loadouts to the SDK", async () => {
	const h = harness();
	h.pi.getAllTools = () => [];
	h.pi.getSettings = () => ({ defaultTools: ["read"] });
	h.pi.getActiveTools = () => ["read"];
	h.pi.setActiveTools = () => assert.fail("must not broaden a restricted SDK loadout");
	await guard(h.pi);
	const tool = h.definitions.get("dot_review_status");
	assert.equal(tool.defaultActive, false, "SDK registration must not expand explicit loadouts");
	await h.handlers.get("session_start")({}, {});
	assert.equal(
		await h.handlers.get("tool_call")({ toolName: "dot_review_status", input: {} }, ctx),
		undefined,
	);
	assert.equal(
		(
			await h.handlers.get("tool_call")(
				{ toolName: "dot_review_status", input: {} },
				{ ...ctx, signal: AbortSignal.abort() },
			)
		).block,
		true,
	);
});

test("generated runtime boundary validates factories and forwards adapter/request/result identities once", async () => {
	assert.equal(typeof statusModule.reviewClientFromModule, "function");
	const request = {
		arguments: ["review", "mode", "status", "--cwd", ctx.cwd, "--json"],
		cwd: ctx.cwd,
		timeoutMs: 123,
		env: Object.freeze({ SENTINEL: "unchanged" }),
		signal,
	};
	const output = { exitCode: 0, stderr: "", stdout: "{}", timedOut: false, outputLimitExceeded: false };
	let executions = 0;
	let invocations = 0;
	const sdk = {
		createNodeExecFileAdapter: () => async (actual) => {
			executions++;
			assert.equal(actual, request);
			return output;
		},
		createNativeReviewCli: (observed) => ({
			sentinel: secret,
			async reviewMode(actual) {
				invocations++;
				assert.equal(this.sentinel, secret);
				assert.deepEqual(actual, { cwd: ctx.cwd, operation: "status", signal });
				assert.equal(await observed(request), output);
				return nativeResult();
			},
			start: () => assert.fail("no mutation"),
		}),
	};
	const result = await invoke(async () => statusModule.reviewClientFromModule(sdk));
	assert.equal(result.ok, true);
	assert.equal(executions, 1);
	assert.equal(invocations, 1);
});

test("generated runtime boundary rejects invalid module/factory shapes without a binary fallback", async () => {
	assert.equal(typeof statusModule.reviewClientFromModule, "function");
	for (const sdk of [
		null,
		[],
		{},
		{ createNodeExecFileAdapter: 1, createNativeReviewCli() {} },
		{ createNodeExecFileAdapter: () => null, createNativeReviewCli: () => assert.fail("invalid adapter") },
		{
			createNodeExecFileAdapter: () => async () => assert.fail("no execution"),
			createNativeReviewCli: () => null,
		},
	]) {
		assert.deepEqual(await invoke(async () => statusModule.reviewClientFromModule(sdk)), {
			ok: false,
			readOnly: true,
			category: "schema-incompatible",
		});
	}
});

test("generated runtime facade refuses non-status and extra authority inputs before SDK calls", async () => {
	let calls = 0;
	const client = statusModule.reviewClientFromModule({
		createNodeExecFileAdapter: () => async () => assert.fail("no execution"),
		createNativeReviewCli: () => ({
			reviewMode: async () => {
				calls++;
				return nativeResult();
			},
		}),
	});
	for (const request of [
		null,
		{ cwd: ctx.cwd, operation: "enable" },
		{ cwd: ctx.cwd, operation: "status", scope: "global" },
		{ cwd: 123, operation: "status" },
	]) {
		await assert.rejects(() => client.reviewMode(request), { code: "schema-incompatible" });
	}
	assert.equal(calls, 0);
});
