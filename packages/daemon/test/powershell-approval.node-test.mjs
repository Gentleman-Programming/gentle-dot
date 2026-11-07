import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { childGuardText } from "../src/child-guard.ts";
import guard, { decide, powerShellApprovalTitle } from "../src/extensions/approval-guard.ts";
import { presentText } from "../src/white-label.ts";

// Load the actual Bridge without importing SDK/auth/filesystem-backed services.
// These adapters only support construction; unexpected service calls fail immediately.
const bridgeURL = new URL("../src/bridge.ts", import.meta.url).href;
const services = {
	"@gentle-dot/protocol":
		"APP_REQUIRED PIN_REQUIRED isAppCommand isPinCommand isThinkingLevel parseClientMessage parseQueue",
	"./app-channel.ts": "APPROVAL_WAIT_MS",
	"./conversations.ts": "conversationIdOf listConversations pageHistory resolveConversation",
	"./engine-access.ts": "directAccess",
	"./presentation.ts": "describeTool textOf",
	"./profiles.ts": "LiveModelSwitch ProfileError splitModel toModelChoices toModelOptions",
	"./rotation.ts": "DEFAULT_ROTATION SessionRotator",
	"./uploads.ts": "composePrompt splitAttachments",
};
const hooks = registerHooks({
	resolve(specifier, context, next) {
		const names = context.parentURL === bridgeURL && services[specifier];
		if (!names) return next(specifier, context);
		const source = names
			.split(" ")
			.map((name) =>
				["LiveModelSwitch", "SessionRotator"].includes(name)
					? `export class ${name} {}`
					: `export function ${name}() { throw Error('Unexpected service call: ${name}'); }`,
			)
			.join("\n");
		return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
	},
});
let DotBridge;
try {
	({ DotBridge } = await import(bridgeURL));
} finally {
	hooks.deregister();
}

function bridgeHarness() {
	let emit;
	const messages = [];
	const bridge = new DotBridge(
		{
			state: "ready",
			busy: false,
			onEvent: (handler) => {
				emit = handler;
			},
		},
		{ dataDir: "/public-unused-path" },
	);
	const detach = bridge.attach({ send: (payload) => messages.push(payload) });
	messages.length = 0;
	return { emit, messages, detach, bridge };
}

test("Bridge adapters preserve ordinary dialog presentation and informational suppression", () => {
	const h = bridgeHarness();
	const message = "RDD  /gentle:status  engram π";
	for (const method of ["confirm", "select", "input", "editor"]) {
		h.emit({ type: "extension_ui_request", id: method, method, title: "RDD approval", message });
		const ask = h.messages.filter((payload) => payload.type === "ask").at(-1).ask;
		assert.equal(ask.message, presentText(message));
		assert.equal(ask.title, presentText("RDD approval"));
		assert.equal(ask.method, method);
	}
	const before = structuredClone(h.messages);
	h.emit({ type: "extension_ui_request", id: "info", method: "notify", level: "info", message });
	assert.deepEqual(h.messages, before);
	h.detach();
});

const cwd = new URL("..", import.meta.url).pathname;
const policy = {
	protectedPaths: [`${cwd}/private-signins.json`],
	connectors: {
		demo: { name: "Demo", mode: "read_write", readOnlyTools: ["list"] },
	},
};
const commandCall = (command) => ({ toolName: "powershell", input: { command } });
const card = (command) => ({
	title: `Allow this PowerShell command? [Dot PowerShell ${createHash("sha256").update(command, "utf8").digest("hex")}]`,
	message: command,
});

// Only register the real public extension; never construct an SDK session or execute a command.
function harness(options = {}) {
	const handlers = new Map();
	const tools = [];
	guard(
		{
			on: (name, handler) => handlers.set(name, handler),
			registerTool: (tool) => tools.push(tool.name),
			getAllTools: () => [],
		},
		options,
	);
	const confirmations = [];
	let executions = 0;
	const run = async (event, overrides = {}) => {
		const ctx = {
			cwd,
			hasUI: true,
			signal: undefined,
			ui: {
				confirm: async (...args) => {
					confirmations.push(args);
					return true;
				},
			},
			...overrides,
		};
		const before = structuredClone(event);
		const result = await handlers.get("tool_call")(event, ctx);
		assert.deepEqual(event, before, "guard must not mutate command arguments");
		if (!result?.block) executions++;
		return result;
	};
	return {
		run,
		tools,
		confirmations,
		get executions() {
			return executions;
		},
	};
}

test("primary PowerShell passes without UI approval and preserves literal inputs", async () => {
	const h = harness();
	for (const command of ["$PSVersionTable.PSVersion", 'Write-Output "π 🚀   ODD"\n\tWrite-Output "RDD"']) {
		assert.deepEqual(decide({ ...commandCall(command), cwd }, policy), { action: "pass" });
		for (const overrides of [
			{},
			{ hasUI: false },
			{ ui: undefined },
			{ ui: {} },
			{
				ui: {
					confirm: () => {
						throw Error("must not ask");
					},
				},
			},
		]) {
			assert.equal(await h.run(commandCall(command), overrides), undefined);
		}
	}
	assert.deepEqual(h.confirmations, []);
	assert.equal(h.executions, 10);
});

test("legacy owned PowerShell preview remains compatible with Bridge transport", () => {
	const command = 'Write-Output "RDD  engram /gentle:status"\n\tWrite-Output "π 🚀   ODD"';
	const b = bridgeHarness();
	const title = powerShellApprovalTitle(command);
	assert.equal(title, card(command).title);
	b.emit({ type: "extension_ui_request", id: "owned", method: "confirm", title, message: command });
	const ask = b.messages.filter((payload) => payload.type === "ask").at(-1).ask;
	assert.equal(ask.message, command);
	assert.equal(ask.method, "confirm");
	// A title alone, a mismatched command, or another dialog method is not an owned preview.
	const ownedTitle = title;
	for (const [id, method, title, message] of [
		["old-title", "confirm", "Allow this PowerShell command?", command],
		["mismatch", "confirm", ownedTitle, `${command} RDD`],
		["other-method", "input", ownedTitle, command],
		["connector", "confirm", "Allow Demo to send?", command],
		["bash", "confirm", "Allow dangerous command?", command],
	]) {
		b.emit({ type: "extension_ui_request", id, method, title, message });
		const projected = b.messages.filter((payload) => payload.type === "ask").at(-1).ask;
		assert.equal(projected.message, presentText(message));
		assert.equal(projected.title, presentText(title));
	}
	b.detach();
});

for (const command of [
	"Get-Date",
	"Remove-Item -Recurse -Force example",
	"rm example",
	"del example",
	"rd example",
	"rmdir example",
	"ri example",
	"git reset --hard",
	"git push --force",
	"git push -f",
	`Write-Output "start"\n${"x".repeat(8100)}\nWrite-Output "end"`,
]) {
	test(`primary passes without confirmation: ${command.slice(0, 45)}`, async () => {
		assert.deepEqual(decide({ ...commandCall(command), cwd }, policy), { action: "pass" });
		const h = harness();
		for (let i = 0; i < 2; i++) assert.equal(await h.run(commandCall(command)), undefined);
		assert.deepEqual(h.confirmations, []);
		assert.equal(h.executions, 2);
	});
}

for (const [name, overrides] of [
	["pre-aborted operation", {}],
	["pre-aborted without UI", { hasUI: false, ui: undefined }],
]) {
	test(`fail closed: ${name}`, async () => {
		const h = harness();
		const result = await h.run(commandCall("Get-Date"), { ...overrides, signal: AbortSignal.abort() });
		assert.equal(result?.block, true);
		assert.equal(typeof result.reason, "string");
		assert.equal(h.executions, 0);
		assert.deepEqual(h.confirmations, []);
	});
}

for (const command of [
	"Get-Date",
	"Remove-Item example",
	"rm example",
	"del example",
	"rd example",
	"rmdir example",
	"ri example",
	"git reset --hard",
	"git push --force",
]) {
	test(`child denies without confirmation: ${command}`, async () => {
		assert.match(childGuardText("/public/approval-guard.ts"), /guard\(pi, \{ subagent: true \}\)/);
		const h = harness({ subagent: true });
		assert.deepEqual(h.tools, []);
		for (const overrides of [{}, { hasUI: false, ui: undefined }])
			assert.equal((await h.run(commandCall(command), overrides))?.block, true);
		assert.deepEqual(h.confirmations, []);
		assert.equal(h.executions, 0);
	});
}

// Supplied protected paths are tested through the public pure policy, not ambient environment.
for (const command of [
	"Get-Content private-signins.json",
	"Get-Content PRIVATE-SIGNINS.JSON",
	'Get-Content ("private-" + "signins.json")',
]) {
	test(`protected basename remains denied: ${command}`, () => {
		assert.equal(decide({ ...commandCall(command), cwd }, policy).action, "block");
	});
}

for (const command of ["mcp add demo", "Get-Content .gentle-dot", "Write-Output PI_CODING_AGENT_DIR"]) {
	test(`hard block precedes confirmation: ${command}`, async () => {
		const h = harness();
		assert.equal(decide({ ...commandCall(command), cwd }, policy).action, "block");
		assert.equal((await h.run(commandCall(command), { hasUI: false, ui: undefined }))?.block, true);
		assert.deepEqual(h.confirmations, []);
		assert.equal(h.executions, 0);
	});
}

test("existing Bash, file and connector decisions retain ordering", async () => {
	const cases = [
		["bash", { command: "git reset --hard" }, "pass"],
		["bash", { command: "mcp remove demo" }, "block"],
		["bash", { command: "echo private-signins.json" }, "block"],
		...["read", "write", "edit", "grep", "find", "ls"].map((name) => [
			name,
			{ path: policy.protectedPaths[0] },
			"block",
		]),
		["read", { path: "approval-guard.ts" }, "pass"],
		["mcp__demo__send", { text: "hello" }, "ask"],
		["mcp__unknown__send", {}, "block"],
	];
	for (const [toolName, input, action] of cases)
		assert.equal(decide({ toolName, input, cwd }, policy).action, action);
	assert.equal(
		decide({ toolName: "mcp__demo__list", input: {}, cwd, readOnlyHint: true }, policy).action,
		"pass",
	);
	const h = harness();
	assert.equal(await h.run({ toolName: "bash", input: { command: "echo public" } }), undefined);
	assert.equal((await h.run({ toolName: "bash", input: { command: "mcp add demo" } }))?.block, true);
	assert.equal(await h.run({ toolName: "mcp__demo__send", input: { text: "hello" } }), undefined);
	assert.equal(h.confirmations.length, 1);
	assert.equal(h.executions, 2);
});
