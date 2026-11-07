import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import guard from "../src/extensions/approval-guard.ts";
import { registerWindowsPowerShell } from "../src/extensions/windows-powershell.ts";

function sdkHarness({
	active = ["read", "bash", "edit", "write", "other"],
	allowed = true,
	settings = {},
	fail = false,
} = {}) {
	const handlers = new Map();
	const definitions = new Map();
	const options = [];
	const sets = [];
	let names = [...active];
	const pi = {
		registerTool: (tool) => definitions.set(tool.name, tool),
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getSettings: () => settings,
		getActiveTools: () => [...names],
		getAllTools: () => (allowed ? [...definitions.values()] : []),
		setActiveTools: (next) => {
			sets.push(next);
			names = [...next];
		},
	};
	const load = async () => ({
		createPowerShellToolDefinition: (cwd, opts) => {
			options.push({ cwd, opts });
			if (fail) throw new Error("factory unavailable");
			return { name: "powershell", execute: async () => ({ content: [], details: {} }) };
		},
	});
	const start = async () => {
		for (const fn of handlers.get("session_start") ?? []) await fn({ type: "session_start" }, {});
	};
	return { pi, definitions, handlers, load, options, sets, start };
}

test("Windows primary uses the public SDK definition with explicit owned operations; activation preserves all other tools", async () => {
	const h = sdkHarness();
	await registerWindowsPowerShell(h.pi, { platform: "win32" }, h.load);
	assert.equal(typeof h.options[0].opts.operations.exec, "function");
	assert.equal(h.options[0].opts.exposeSessionEnvironment, false);
	assert.equal(h.definitions.get("powershell").exposure, "direct");
	assert.equal(h.definitions.get("powershell").defaultActive, false);
	assert.deepEqual(h.pi.getActiveTools(), ["read", "bash", "edit", "write", "other"]);
	await h.start();
	assert.deepEqual(h.pi.getActiveTools(), ["read", "powershell", "edit", "write", "other"]);
	await h.start();
	assert.equal(h.sets.length, 1);
});

for (const [name, config] of [
	["restricted allowlist", { allowed: false }],
	["explicit defaultTools", { settings: { defaultTools: ["read", "bash"] } }],
	["no tools", { active: [] }],
	["reviewer without Bash", { active: ["read"] }],
	["explicit both shells", { active: ["bash", "powershell"] }],
]) {
	test(`activation respects ${name}`, async () => {
		const h = sdkHarness(config);
		await registerWindowsPowerShell(h.pi, { platform: "win32" }, h.load);
		const previous = h.pi.getActiveTools();
		await h.start();
		assert.deepEqual(h.pi.getActiveTools(), previous);
		assert.equal(h.sets.length, 0);
	});
}

for (const opts of [{ platform: "linux" }, { platform: "darwin" }, { platform: "win32", subagent: true }]) {
	test(`no registration/loading/activation for ${JSON.stringify(opts)}`, async () => {
		const h = sdkHarness();
		await registerWindowsPowerShell(h.pi, opts, () => {
			throw Error("must not load SDK");
		});
		assert.equal(h.definitions.size, 0);
		assert.equal(h.handlers.size, 0);
	});
}

test("initialization failure shadows the default backend, leaves Bash and session startup intact", async () => {
	for (const factoryFailure of [false, true]) {
		const h = sdkHarness({ fail: factoryFailure });
		await registerWindowsPowerShell(
			h.pi,
			{ platform: "win32" },
			factoryFailure
				? h.load
				: async () => {
						throw Error("load failed");
					},
		);
		await h.start();
		const tool = h.definitions.get("powershell");
		assert.equal(tool.exposure, "hidden");
		await assert.rejects(tool.execute(), /unavailable/);
		assert.equal(h.sets.length, 0);
		assert.ok(h.pi.getActiveTools().includes("bash"));
	}
});

test("filtered activation cannot leave Bash removed without PowerShell", async () => {
	const h = sdkHarness();
	const set = h.pi.setActiveTools;
	h.pi.setActiveTools = (next) => set(next.filter((n) => n !== "powershell"));
	await registerWindowsPowerShell(h.pi, { platform: "win32" }, h.load);
	await h.start();
	assert.deepEqual(h.pi.getActiveTools(), ["read", "bash", "edit", "write", "other"]);
});

// The actual SDK source path is documented separately. This adapter exercises the real guard
// at both event shapes without instantiating AgentSession, codemode or any process executor.
for (const nested of [false, true]) {
	test(`${nested ? "codemode-dispatched" : "direct"} primary call reaches the definition without confirmation`, async () => {
		const h = sdkHarness();
		await guard(h.pi);
		let executions = 0;
		h.load = async () => ({
			createPowerShellToolDefinition: () => ({
				name: "powershell",
				execute: async () => {
					executions++;
				},
			}),
		});
		await registerWindowsPowerShell(h.pi, { platform: "win32" }, h.load);
		for (const hasUI of [false, true, false]) {
			const event = {
				toolName: "powershell",
				toolCallId: "call",
				input: { command: 'Write-Output "benign data"' },
				...(nested ? { parentToolCallId: "codemode-call" } : {}),
			};
			for (const fn of h.handlers.get("tool_call")) {
				const result = await fn(event, {
					cwd: "/public-workspace",
					hasUI,
					ui: {
						confirm: async () => {
							assert.fail("primary PowerShell must not ask");
						},
					},
				});
				if (!result?.block) await h.definitions.get("powershell").execute();
			}
		}
		assert.equal(executions, 3);
	});
}

test("installed resource copy closure includes exactly the guard and all imported owned siblings", () => {
	const build = readFileSync(new URL("../src/runtime-build.ts", import.meta.url), "utf8");
	const match = build.match(
		/for \(const name of (\[[^\]]+\])\) \{\s*copyFileSync\(join\(PACKAGE, "src", "extensions", name\), join\(daemon, "extensions", name\)\)/,
	);
	assert.ok(match, "copy the owned closure into the installed extension directory");
	// Accept a JavaScript array's optional trailing comma without evaluating source.
	const copied = JSON.parse(match[1].replace(/,\s*\]$/, "]"));
	const closure = new Set();
	function visit(name) {
		if (closure.has(name)) return;
		closure.add(name);
		const source = readFileSync(new URL(`../src/extensions/${name}`, import.meta.url), "utf8");
		for (const sibling of source.matchAll(/from "\.\/([^"/]+\.ts)"/g)) visit(sibling[1]);
	}
	visit("approval-guard.ts");
	assert.deepEqual([...closure].sort(), copied.sort());
	assert.deepEqual(copied.sort(), [
		"approval-guard.ts",
		"diagnostic-guidance.ts",
		"powershell-operations.ts",
		"review-status.ts",
		"screenshot-context.ts",
		"windows-powershell.ts",
	]);
	assert.equal(copied.length, 6);
	const guardSource = readFileSync(new URL("../src/extensions/approval-guard.ts", import.meta.url), "utf8");
	assert.ok(
		guardSource.indexOf('pi.on("tool_call"') <
			guardSource.indexOf("await registerWindowsPowerShell(pi, options)"),
	);
});
