import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Public bridge/protocol with inert collaborators: no SDK, filesystem uploads or native IPC.
const stub = (names) => names.map((name) => `export class ${name} extends Error {}`).join("\n");
const modules = new Map([
	[
		"@earendil-works/pi-mcp",
		stub([
			"McpError",
			"McpHttpError",
			"McpAuthRequiredError",
			"McpTimeoutError",
			"McpAbortError",
			"McpConnectionClosedError",
		]),
	],
	["@earendil-works/pi-mcp/oauth", stub(["McpOAuthAuthorizationRequiredError"])],
	["./app-channel.ts", "export const APPROVAL_WAIT_MS=1;"],
	[
		"./extensions/approval-guard.ts",
		'export const DRAFT_STATUS_KEY="draft", powerShellApprovalTitle=()=>"";',
	],
	[
		"./conversations.ts",
		stub(["conversationIdOf", "listConversations", "pageHistory", "resolveConversation"]),
	],
	["./engine-access.ts", "export const directAccess={};"],
	["./presentation.ts", 'export const describeTool=()=>({}), textOf=()=>"";'],
	[
		"./profiles.ts",
		stub(["LiveModelSwitch", "ProfileError", "splitModel", "toModelChoices", "toModelOptions"]),
	],
	["./rotation.ts", "export const DEFAULT_ROTATION={}; export class SessionRotator {}"],
	["./uploads.ts", "export const composePrompt=message=>({message}), splitAttachments=()=>({});"],
]);
const protocolURL = new URL("../../protocol/src/index.ts", import.meta.url).href;
registerHooks({
	resolve(specifier, context, next) {
		if (
			context.parentURL?.endsWith("/extensions/approval-guard.ts") &&
			specifier === "./windows-powershell.ts"
		)
			return {
				url:
					"data:text/javascript," +
					encodeURIComponent(
						"export async function registerWindowsPowerShell(pi,options){globalThis.retirementPowerShell.push(options);}",
					),
				shortCircuit: true,
			};
		if (context.parentURL?.includes("/daemon/src/")) {
			if (specifier === "@gentle-dot/protocol") return { url: protocolURL, shortCircuit: true };
			if (modules.has(specifier))
				return {
					url: "data:text/javascript," + encodeURIComponent(modules.get(specifier)),
					shortCircuit: true,
				};
		}
		if (!/^(node:|\.|file:|data:)/.test(specifier)) throw Error("Unapproved SDK import");
		return next(specifier, context);
	},
});
const { DotBridge } = await import("../src/bridge.ts");
function harness(Bridge = DotBridge) {
	const sent = [],
		other = [],
		requests = [],
		logs = [],
		stored = { upload: "untouched", debug: true, privateRdd: "untouched" };
	const counters = { collector: 0, upload: 0, native: 0, trace: 0 };
	const collect = () => {
		counters.collector++;
		return {};
	};
	const supervisor = {
		state: "ready",
		busy: false,
		onEvent: () => () => {},
		request: async (payload) => {
			requests.push(payload);
			return {
				data: {
					commands: [
						{ name: "mcp-inventory", source: "extension" },
						{ name: "mcp", source: "extension" },
					],
				},
			};
		},
	};
	const bridge = new Bridge(supervisor, {
		dataDir: "unused-in-memory",
		log: (line) => logs.push(line),
		connectorDiagnostics: collect,
		connectorInventory: collect,
		connectorFailure: collect,
		discordLocalDiagnostic: async () => {
			counters.native++;
			return "requested";
		},
		trace: {
			info: () => {
				counters.trace++;
				return { status: "off" };
			},
			record: () => {
				counters.trace++;
			},
		},
		uploads: {
			resolve: () => {
				counters.upload++;
				return { ok: true, files: [] };
			},
			consume: () => {
				counters.upload++;
			},
		},
	});
	const client = { send: (payload) => sent.push(payload) };
	bridge.attach(client);
	bridge.attach({ send: (payload) => other.push(payload) });
	sent.length = 0;
	other.length = 0;
	return {
		bridge,
		sent,
		other,
		requests,
		logs,
		stored,
		counters,
		handle: (message) => bridge.handle(client, message),
	};
}
const refused = { type: "error", code: "unsupported", message: "I can't run that command here." };
for (const command of ["/discord-debug", "/discord-trace", "/discord-status", "/mcp-inventory"]) {
	test(`${command} rejects exact token, arguments and attachments before any side effect or dedup`, async () => {
		const h = harness(),
			state = JSON.stringify(h.stored);
		const inputs = [command, command + " extra", command + "\nextra", command + "\targ"].flatMap((text) => [
			{ type: "send", text, requestId: "reusable" },
			{ type: "send", text, requestId: "reusable", attachments: ["private-upload"] },
		]);
		for (const input of inputs) {
			const before = JSON.stringify(input);
			await h.handle(input);
			assert.equal(JSON.stringify(input), before);
		}
		assert.deepEqual(
			h.sent,
			inputs.map(() => refused),
		);
		assert.deepEqual([h.requests, h.other, h.logs], [[], [], []]);
		assert.deepEqual(h.counters, { collector: 0, upload: 0, native: 0, trace: 0 });
		assert.equal(JSON.stringify(h.stored), state);
		await h.handle({ type: "send", text: "hello", requestId: "reusable" });
		await h.handle({ type: "send", text: "hello", requestId: "reusable" });
		assert.deepEqual(h.requests, [{ type: "prompt", message: "hello" }]);
	});
}
test("ordinary MCP forwards once without owned toast/collector; unknown slash and lookalikes still route", async () => {
	const h = harness();
	for (const text of [
		"/mcp",
		"/mcp login discord",
		"/unknown",
		"/diagnostics-other",
		"/discord-debug-other",
		"/discord-traceback",
		"/discord-status-other",
		"/mcp-inventory-other",
		"hello",
	])
		await h.handle({ type: "send", text });
	assert.deepEqual(
		h.requests.map((p) => p.message),
		[
			"/mcp",
			"/mcp login discord",
			"/unknown",
			"/diagnostics-other",
			"/discord-debug-other",
			"/discord-traceback",
			"/discord-status-other",
			"/mcp-inventory-other",
			"hello",
		],
	);
	assert.ok(h.requests.every((p) => p.type === "prompt"));
	assert.deepEqual([h.sent, h.other, h.logs], [[], [], []]);
	assert.deepEqual(h.counters, { collector: 0, upload: 0, native: 0, trace: 0 });
});
test("primary guard no longer registers diagnostic commands, preserving review status and PowerShell registration", async () => {
	const { default: guard } = await import("../src/extensions/approval-guard.ts");
	for (const subagent of [false, true]) {
		const commands = [],
			tools = [],
			handlers = [],
			flags = [];
		globalThis.retirementPowerShell = [];
		const options = { subagent };
		await guard(
			{
				registerCommand: (name) => commands.push(name),
				registerTool: (tool) => tools.push(tool.name),
				registerFlag: (name) => flags.push(name),
				on: (name) => handlers.push(name),
			},
			options,
		);
		assert.deepEqual(commands, []);
		assert.deepEqual(tools, subagent ? [] : ["propose_connector", "dot_review_status"]);
		assert.ok(handlers.includes("tool_call"));
		assert.ok(handlers.includes("context"));
		assert.deepEqual(globalThis.retirementPowerShell, [options]);
		assert.deepEqual(flags, [], "Retired private capture never registers a flag");
	}
});
