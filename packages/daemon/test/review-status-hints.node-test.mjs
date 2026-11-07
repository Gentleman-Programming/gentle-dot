import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { registerReviewStatus } from "../src/extensions/review-status.ts";

// Public factory fixture only: no SDK import, process, profile or native execution.
const fixture = { calls: [], runs: [], pending: [], logs: [] };
globalThis[Symbol.for("dot.review.fixture")] = fixture;
const source = `
const f = globalThis[Symbol.for('dot.review.fixture')];
export function createNodeExecFileAdapter() {
  f.calls.push('adapter');
  const run = f.pending.shift();
  return async request => {
    run.requests.push(request);
    if (run.error) throw run.error;
    return run.result;
  };
}
export function createNativeReviewCli(...args) {
  f.calls.push(['client', args.length]);
  const adapter = args[0] ?? createNodeExecFileAdapter();
  const run = f.runs.shift();
  return { async reviewMode(input) {
    run.input = input;
    for (const request of run.sequence) {
      try { assertSame(await adapter(request), run.result); }
      catch (error) { if (error !== run.error) throw Error('error identity changed'); }
    }
    if (run.wait) await run.wait;
    if (run.code) throw { code: run.code, message: 'RAW_ERROR_CANARY' };
    return run.status;
  } };
}
function assertSame(a, b) { if (a !== b) throw Error('result identity changed'); }
`;
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "gentle-pi/runtime/native-review-cli.mjs")
			return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		return next(specifier, context);
	},
});
const canary = "PRIVATE_CANARY";
const cwd = "/synthetic-canonical-workspace";
const signal = new AbortController().signal;
const request = (args = ["review", "mode", "status", "--cwd", cwd, "--json"]) =>
	Object.freeze({
		file: "normal-resolver-fixture",
		arguments: Object.freeze(args),
		cwd,
		timeoutMs: 1234,
		maxBufferBytes: 5678,
		signal,
	});
const commands = (verb, scope = "global") =>
	`\`gentle-ai review mode ${verb} --scope=${scope}${scope === "clone" ? ` --cwd ${canary}` : ""}\``;
const tail = (scope) =>
	`${commands("enable", scope)} to turn reviews on, or ${commands("disable", scope)} to turn them off`;
const unreadable = `Error: the global value in ${canary} is not a mode this product can read; an unreadable switch is not a disabled switch, so receipt-driven development stays managed until the value is overwritten: run ${tail("global")}`;
const unsafe = `the clone-local review mode path "${canary}" is unsafe; run \`synthetic-command\` in a NON-ELEVATED Windows PowerShell 5.1 shell because an elevated TokenOwner can differ from the current user, then rerun the original command`;
const posix = unsafe.replace(/ in a NON-ELEVATED.*user,/, ",");
function prepare(stderr, overrides = {}) {
	const run = {
		requests: [],
		sequence: [request()],
		code: "non-zero",
		result: Object.freeze({
			stdout: canary,
			stderr,
			exitCode: 1,
			signal: null,
			timedOut: false,
			outputLimitExceeded: false,
		}),
		...overrides,
	};
	fixture.pending.push(run);
	fixture.runs.push(run);
	return run;
}
function tool() {
	let definition;
	registerReviewStatus({
		registerTool: (value) => {
			definition = value;
		},
		on() {},
	});
	return definition;
}
async function invoke(definition = tool()) {
	const result = await definition.execute("fixture", {}, signal, () => assert.fail("no streaming"), { cwd });
	assert.deepEqual(JSON.parse(result.content[0].text), result.details);
	assert.ok(!JSON.stringify(result).includes(canary));
	assert.ok(!JSON.stringify(result).includes("RAW_ERROR_CANARY"));
	return result.details;
}
const failure = (hint) => ({
	ok: false,
	readOnly: true,
	category: "non-zero",
	...(hint ? { indicativeHint: hint } : {}),
});

test("matched synthetic failures emit only finite indicative enums without logging", async () => {
	const channels = ["error", "warn", "log", "info", "debug"];
	const originals = channels.map((channel) => console[channel]);
	for (const channel of channels) console[channel] = (...args) => fixture.logs.push(args);
	try {
		for (const [text, hint] of [
			[unreadable, "unreadable_mode_value"],
			[
				unreadable.replace("global value", "clone-local value").replace(tail("global"), tail("clone")),
				"unreadable_mode_value",
			],
			[
				`both review mode sources hold a value this product cannot read as a mode: ${canary}; ${unreadable.split("; ")[1]}`.replace(
					tail("global"),
					`${commands("enable")} and ${commands("enable", "clone")} to turn reviews on, or ${commands("disable")} and ${commands("disable", "clone")} to turn them off`,
				),
				"unreadable_mode_value",
			],
			[unsafe, "unsafe_clone_mode_path"],
			[posix, "unsafe_clone_mode_path"],
		]) {
			prepare(text);
			assert.deepEqual(await invoke(), failure(hint));
		}
		assert.deepEqual(fixture.logs, []);
	} finally {
		channels.forEach((channel, index) => {
			console[channel] = originals[index];
		});
	}
});

test("full remediation templates reject truncated, altered, extra and ambiguous tails", async () => {
	for (const text of [
		unsafe.replace(/run .*/, "run unrelated nonsense"),
		unsafe.replaceAll("`", ""),
		unsafe.replace("`synthetic-command`", "``"),
		unsafe.replace("NON-ELEVATED", "ELEVATED"),
		unsafe.replace("5.1", "5x1"),
		posix.replace(", then rerun the original command", ""),
		`${posix} extra`,
		unreadable.replace(/run .*/, "run unrelated nonsense"),
		unreadable.replace(" to turn them off", ""),
		unreadable.replace("reviews on", "reviews off"),
		unreadable.replaceAll("`", ""),
		unreadable.replace(commands("enable"), "`unrelated nonsense`"),
		`${unreadable} extra`,
		`${unreadable} and ${posix}`,
		unreadable.replaceAll("--scope=global", "--scope=clone"),
		`${posix}${"x".repeat(8193)}`,
	]) {
		prepare(text);
		assert.deepEqual(await invoke(), failure());
	}
});

test("default composition preserves request/result/error identity and factory options", async () => {
	fixture.calls.length = 0;
	const run = prepare(unreadable);
	assert.deepEqual(await invoke(), failure("unreadable_mode_value"));
	assert.deepEqual(fixture.calls, ["adapter", ["client", 1]]);
	assert.deepEqual(run.requests, run.sequence);
	assert.equal(run.requests[0], run.sequence[0]);
	assert.deepEqual(run.input, { cwd, operation: "status", signal });
	prepare("", { error: new Error(canary), code: "unavailable" });
	assert.deepEqual(await invoke(), { ok: false, readOnly: true, category: "unavailable" });
});

test("unmatched, ambiguous, oversized and ineligible observations retain fallback", async () => {
	for (const text of [
		"",
		canary,
		`${unreadable}\n${unsafe}`,
		"x".repeat(8193),
		`prefix ${unreadable}`,
		`${unreadable}\ninjected`,
		`${unsafe}; ${unreadable}`,
		`${unreadable}; ${unreadable}`,
		`${unsafe}\u001b[31m`,
		"the global value in x is not a mode this product can read; run something",
	]) {
		prepare(text);
		assert.deepEqual(await invoke(), failure());
	}
	for (const patch of [
		{ exitCode: 0 },
		{ timedOut: true },
		{ outputLimitExceeded: true },
		{ signal: "SIGTERM" },
	]) {
		const run = prepare(unreadable);
		run.result = Object.freeze({ ...run.result, ...patch });
		assert.deepEqual(await invoke(), failure());
	}
	for (const args of [
		["--version"],
		["review", "mode", "off", "--cwd", cwd, "--json"],
		["review", "mode", "status", "--cwd", "/other", "--json"],
	]) {
		prepare(unreadable, { sequence: [request(args)] });
		assert.deepEqual(await invoke(), failure());
	}
});

test("observations do not attach to success or another final failure category", async () => {
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
	prepare(unreadable, { code: undefined, status });
	assert.deepEqual(await invoke(), { ok: true, readOnly: true, status: status.status });
	prepare(unreadable, { code: "malformed-json" });
	assert.deepEqual(await invoke(), { ok: false, readOnly: true, category: "malformed-json" });
});

test("overlapping invocations of one tool cannot share hints", async () => {
	let release;
	const wait = new Promise((resolve) => {
		release = resolve;
	});
	const definition = tool();
	prepare(unreadable, { wait });
	const first = invoke(definition);
	prepare(unsafe);
	assert.deepEqual(await invoke(definition), failure("unsafe_clone_mode_path"));
	release();
	assert.deepEqual(await first, failure("unreadable_mode_value"));
});

// Public producer templates only, not an owner trace or installed-process sample:
// gentle-ai/v4.0.0/internal/reviewtransaction/rdd_mode.go and
// golang/go/go1.25.10/src/os/exec/lp_windows.go. The middle is invented.
const gitLookup =
	'resolve review mode repository identity: synthetic repository lookup: exec: "git": executable file not found in %PATH%';
test("public Git producer indication explains the affected function without changing the request", async () => {
	const run = prepare(gitLookup);
	const result = await tool().execute("fixture", {}, signal, () => assert.fail("no streaming"), { cwd });
	assert.deepEqual(result.details, failure("git_unavailable"));
	assert.deepEqual(JSON.parse(result.content[0].text), result.details);
	assert.equal(result.content.length, 2);
	const guide = JSON.parse(result.content[1].text);
	assert.match(guide.summary, /could not locate Git/);
	assert.ok(guide.steps.some((step) => step.includes("If Git is not installed")));
	assert.ok(guide.steps.some((step) => step.includes("existing installation")));
	assert.equal(run.requests.length, 1);
	assert.equal(run.requests[0], run.sequence[0]);
	assert.deepEqual(run.input, { cwd, operation: "status", signal });
	assert.ok(!JSON.stringify(result).includes("synthetic repository lookup"));
	assert.ok(!JSON.stringify(result).includes(canary));
});
test("Git indication stays unknown for ambiguous, altered, excessive or ineligible producer observations", async () => {
	for (const text of [
		gitLookup.split(": synthetic")[1],
		gitLookup.replace("repository identity", "other context"),
		gitLookup.replace('"git"', '"other"'),
		gitLookup + " extra",
		gitLookup + "\nprivate",
		gitLookup + "\u001b[31m",
		"x".repeat(8193) + gitLookup,
		gitLookup + ": " + gitLookup,
		gitLookup.replace("synthetic repository lookup", "the clone-local review mode path secret"),
	]) {
		prepare(text);
		assert.deepEqual(await invoke(), failure());
	}
	for (const patch of [
		{ exitCode: 0 },
		{ timedOut: true },
		{ outputLimitExceeded: true },
		{ signal: "SIGTERM" },
	]) {
		const run = prepare(gitLookup);
		run.result = Object.freeze({ ...run.result, ...patch });
		assert.deepEqual(await invoke(), failure());
	}
	prepare(gitLookup, { sequence: [request(["--version"])] });
	assert.deepEqual(await invoke(), failure());
	prepare(gitLookup, { code: "malformed-json" });
	assert.deepEqual(await invoke(), { ok: false, readOnly: true, category: "malformed-json" });
});
