import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Actual public protocol and bridge; inert collaborators cannot boot an SDK or transport.
const errors = [
	"McpError",
	"McpHttpError",
	"McpAuthRequiredError",
	"McpOAuthAuthorizationRequiredError",
	"McpTimeoutError",
	"McpAbortError",
	"McpConnectionClosedError",
];
const stub = (names) => names.map((name) => `export class ${name} extends Error {}`).join("\n");
const modules = new Map([
	["@earendil-works/pi-mcp", stub(errors)],
	["@earendil-works/pi-mcp/oauth", stub(errors)],
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
const { parseClientMessage } = await import(protocolURL);
const { DotBridge } = await import("../src/bridge.ts");
const action = (requestId) => ({ type: "runtime_diagnostics_get", requestId });
const canary = "PRIVATE_CALLBACK_CANARY";
const rows = [{ component: "node", state: "running", version: "24.1.0", path: canary }];
function harness(metadata = () => rows, history = () => undefined) {
	const sent = [],
		other = [],
		requests = [],
		logs = [];
	const calls = { metadata: 0, history: 0, resolve: 0, consume: 0 };
	const supervisor = {
		state: "ready",
		busy: false,
		onEvent: () => () => {},
		request: async (payload) => {
			requests.push(payload);
			return { data: { commands: [{ name: "mcp-inventory", source: "extension" }] } };
		},
	};
	const bridge = new DotBridge(supervisor, {
		dataDir: "unused-in-memory",
		log: (line) => logs.push(line),
		runtimeAvailability: () => {
			calls.metadata++;
			return metadata();
		},
		connectorDiagnostics: () => {
			calls.history++;
			return history();
		},
		uploads: {
			resolve() {
				calls.resolve++;
				return { ok: true, files: [] };
			},
			consume() {
				calls.consume++;
				assert.fail("No attachment consumption");
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
		client,
		sent,
		other,
		requests,
		logs,
		calls,
		handle: (message) => bridge.handle(client, message),
	};
}
const invalid = [
	{},
	{ type: "runtime_diagnostics_get" },
	...["a", "A0_-", "a".repeat(64), "", "a".repeat(65), "with space", canary].map(action),
	...[null, 1, {}, [], true].map(action),
	{ ...action("reusable"), extra: canary },
];
test("retired report requests are rejected by the public parser", () => {
	for (const input of invalid) {
		const before = JSON.stringify(input);
		assert.equal(parseClientMessage(before), undefined);
		assert.equal(JSON.stringify(input), before);
	}
	assert.equal(parseClientMessage("{"), undefined);
	assert.deepEqual(parseClientMessage('{"type":"send","text":"hello","requestId":"normal"}'), {
		type: "send",
		text: "hello",
		requestId: "normal",
	});
});
test("typed legacy requests have no reply, collection, model or dedup side effects", async () => {
	const h = harness(
		() => {
			throw Error(canary);
		},
		() => {
			throw Error(canary);
		},
	);
	for (const input of invalid.filter((input) => input.type === "runtime_diagnostics_get")) {
		const before = JSON.stringify(input);
		assert.equal(await h.handle(input), undefined);
		assert.equal(JSON.stringify(input), before);
	}
	const getter = Object.defineProperty(action("reusable"), "requestId", {
		get() {
			assert.fail("No request getter evaluation");
		},
	});
	await h.handle(getter);
	assert.deepEqual(h.calls, { metadata: 0, history: 0, resolve: 0, consume: 0 });
	assert.deepEqual([h.sent, h.other, h.logs, h.requests], [[], [], [], []]);
	await h.handle({ type: "send", text: "hello", requestId: "reusable" });
	await h.handle({ type: "send", text: "hello", requestId: "reusable" });
	assert.deepEqual(h.requests, [{ type: "prompt", message: "hello" }]);
});
test("retired slash token refuses arguments and attachments without mutating inputs or dedup", async () => {
	const h = harness();
	const inputs = ["/diagnostics", "/diagnostics extra", "/diagnostics\nextra", "/diagnostics\targ"].map(
		(text) => ({ type: "send", text, requestId: "reusable" }),
	);
	inputs.push({ type: "send", text: "/diagnostics", requestId: "reusable", attachments: ["upload"] });
	for (const input of inputs) {
		const before = JSON.stringify(input);
		assert.equal(await h.handle(input), undefined);
		assert.equal(JSON.stringify(input), before);
	}
	assert.deepEqual(
		h.sent,
		inputs.map(() => ({ type: "error", code: "unsupported", message: "I can't run that command here." })),
	);
	assert.deepEqual(h.calls, { metadata: 0, history: 0, resolve: 0, consume: 0 });
	assert.deepEqual([h.requests, h.logs, h.other], [[], [], []]);
	await h.handle({ type: "send", text: "hello", requestId: "reusable" });
	assert.deepEqual(h.requests, [{ type: "prompt", message: "hello" }]);
});
test("retired sibling inventory refuses while ordinary unknown slash routing retains behavior", async () => {
	const h = harness();
	for (const text of ["/mcp-inventory extra", "/mcp-inventory"]) await h.handle({ type: "send", text });
	assert.deepEqual(
		h.sent,
		[0, 1].map(() => ({ type: "error", code: "unsupported", message: "I can't run that command here." })),
	);
	assert.deepEqual(h.requests, []);
	h.sent.length = 0;
	for (const text of ["/diagnostics-other", "/unknown", "hello"]) await h.handle({ type: "send", text });
	assert.deepEqual(
		h.requests,
		["/diagnostics-other", "/unknown", "hello"].map((message) => ({ type: "prompt", message })),
	);
	assert.deepEqual(h.calls, { metadata: 0, history: 0, resolve: 0, consume: 0 });
	assert.deepEqual([h.sent, h.other, h.logs], [[], [], []]);
});
