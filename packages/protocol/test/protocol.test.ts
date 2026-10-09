import { describe, expect, it } from "vitest";
import {
	isValidProfileName,
	PROTOCOL_VERSION,
	parseClientMessage,
	parseQueue,
	THINKING_LEVELS,
} from "../src/index.ts";

describe("protocol", () => {
	it("exposes version 1", () => {
		expect(PROTOCOL_VERSION).toBe(1);
	});

	it("accepts well-formed client messages", () => {
		expect(parseClientMessage('{"type":"hello","token":"t","protocol":1}')).toEqual({
			type: "hello",
			token: "t",
			protocol: 1,
		});
		expect(parseClientMessage('{"type":"send","text":"hi","requestId":"r"}')).toEqual({
			type: "send",
			text: "hi",
			requestId: "r",
		});
		expect(parseClientMessage('{"type":"ui_response","requestId":"a","confirmed":false}')).toEqual({
			type: "ui_response",
			requestId: "a",
			confirmed: false,
		});
		expect(parseClientMessage('{"type":"abort","extra":1}')).toEqual({ type: "abort" });
		expect(parseClientMessage('{"type":"auth_login","providerId":"anthropic","method":"oauth"}')).toEqual({
			type: "auth_login",
			providerId: "anthropic",
			method: "oauth",
		});
		expect(parseClientMessage('{"type":"auth_reply","flowId":"f","value":"sk-x"}')).toEqual({
			type: "auth_reply",
			flowId: "f",
			value: "sk-x",
		});
		expect(parseClientMessage('{"type":"auth_reply","flowId":"f","cancelled":true}')).toEqual({
			type: "auth_reply",
			flowId: "f",
			cancelled: true,
		});
	});

	it("rejects malformed or unknown messages", () => {
		for (const raw of [
			"{",
			"null",
			'{"type":"send","text":"   "}',
			'{"type":"send","text":1}',
			'{"type":"ui_response","requestId":"a"}',
			'{"type":"open_conversation"}',
			'{"type":"shell","cmd":"rm"}',
			'{"type":"auth_login","providerId":"x","method":"password"}',
			'{"type":"auth_reply","flowId":"f"}',
			'{"type":"get_earlier"}',
			'{"type":"get_earlier","before":7}',
			`{"type":"get_earlier","before":"${"x".repeat(201)}"}`,
		]) {
			expect(parseClientMessage(raw), raw).toBeUndefined();
		}
	});

	it("asks for the messages before one the window already shows", () => {
		expect(parseClientMessage('{"type":"get_earlier","before":"s0-12"}')).toEqual({
			type: "get_earlier",
			before: "s0-12",
		});
	});
});

describe("queue", () => {
	it("reads both complete queues from the engine's queue_update", () => {
		expect(
			parseQueue({
				type: "queue_update",
				steering: ["look at the tests"],
				followUp: ["then deploy", "and tell me"],
			}),
		).toEqual({ steering: ["look at the tests"], followUp: ["then deploy", "and tell me"] });
		expect(parseQueue({ steering: [], followUp: [] })).toEqual({ steering: [], followUp: [] });
	});

	it("treats a missing queue as empty and drops entries that are not text", () => {
		expect(parseQueue({ steering: ["one", 2, null, ""] })).toEqual({ steering: ["one"], followUp: [] });
	});

	it("rejects a record whose queues are not lists", () => {
		for (const value of [null, "queue", { steering: "one" }, { steering: [], followUp: { a: 1 } }]) {
			expect(parseQueue(value), JSON.stringify(value)).toBeUndefined();
		}
	});
});

describe("profile messages", () => {
	const parse = (value: object) => parseClientMessage(JSON.stringify(value));

	it("accepts every profile command", () => {
		expect(parse({ type: "profiles_list" })).toEqual({ type: "profiles_list" });
		expect(parse({ type: "profile_import" })).toEqual({ type: "profile_import" });
		expect(parse({ type: "profile_apply", name: "deep-work" })).toEqual({
			type: "profile_apply",
			name: "deep-work",
		});
		expect(parse({ type: "profile_delete", name: "a.b_c" })).toEqual({
			type: "profile_delete",
			name: "a.b_c",
		});
		expect(parse({ type: "profile_rename", from: "a", to: "b" })).toEqual({
			type: "profile_rename",
			from: "a",
			to: "b",
		});
		expect(parse({ type: "profile_duplicate", from: "a", to: "b" })).toEqual({
			type: "profile_duplicate",
			from: "a",
			to: "b",
		});
		expect(parse({ type: "profile_save_current", name: "mine" })).toEqual({
			type: "profile_save_current",
			name: "mine",
		});
	});

	it("keeps only valid routes when saving a profile and drops empty ones", () => {
		expect(
			parse({
				type: "profile_save",
				name: "fast",
				roles: {
					orchestrator: { model: "anthropic/claude-sonnet-4", thinking: "high" },
					"gentle-ai-worker": { thinking: "low" },
					"gentle-ai-explore": {},
				},
			}),
		).toEqual({
			type: "profile_save",
			name: "fast",
			roles: {
				orchestrator: { model: "anthropic/claude-sonnet-4", thinking: "high" },
				"gentle-ai-worker": { thinking: "low" },
			},
		});
	});

	it("rejects bad profile names, roles, models, and thinking levels", () => {
		for (const bad of [
			{ type: "profile_apply" },
			{ type: "profile_apply", name: "" },
			{ type: "profile_apply", name: "-starts-with-dash" },
			{ type: "profile_apply", name: "has space" },
			{ type: "profile_apply", name: "x".repeat(65) },
			{ type: "profile_apply", name: "constructor" },
			{ type: "profile_delete", name: "prototype" },
			{ type: "profile_rename", from: "a" },
			{ type: "profile_duplicate", from: "a", to: "../b" },
			{ type: "profile_save", name: "ok" },
			{ type: "profile_save", name: "ok", roles: [] },
			{ type: "profile_save", name: "ok", roles: { worker: "anthropic/x" } },
			{ type: "profile_save", name: "ok", roles: { worker: { model: "bad model" } } },
			{ type: "profile_save", name: "ok", roles: { worker: { thinking: "extreme" } } },
			{ type: "profile_save", name: "ok", roles: { "bad role": { thinking: "low" } } },
			{ type: "profile_save", name: "ok", roles: { worker: { model: 3 } } },
			{ type: "profile_save_current", name: "__proto__" },
		]) {
			expect(parse(bad), JSON.stringify(bad)).toBeUndefined();
		}
		expect(
			parseClientMessage('{"type":"profile_save","name":"ok","roles":{"__proto__":{"thinking":"low"}}}'),
		).toBeUndefined();
	});

	it("validates profile names like the engine does", () => {
		expect(isValidProfileName("deep-work.v2_A")).toBe(true);
		expect(isValidProfileName("9lives")).toBe(true);
		expect(isValidProfileName("x".repeat(64))).toBe(true);
		for (const name of ["", "_x", ".x", "x".repeat(65), "a/b", "constructor", "prototype", "__proto__", 3]) {
			expect(isValidProfileName(name), String(name)).toBe(false);
		}
		expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("connector messages", () => {
	it("accepts every connector command", () => {
		expect(parseClientMessage('{"type":"connectors_list"}')).toEqual({ type: "connectors_list" });
		for (const type of [
			"connector_connect",
			"connector_signin",
			"connector_disconnect",
			"connector_remove",
		]) {
			expect(parseClientMessage(JSON.stringify({ type, connectorId: "notion" }))).toEqual({
				type,
				connectorId: "notion",
			});
		}
		expect(
			parseClientMessage('{"type":"connector_mode","connectorId":"linear","mode":"read_write"}'),
		).toEqual({ type: "connector_mode", connectorId: "linear", mode: "read_write" });
		expect(parseClientMessage('{"type":"connector_mode","connectorId":"linear","mode":"read_only"}')).toEqual(
			{
				type: "connector_mode",
				connectorId: "linear",
				mode: "read_only",
			},
		);
	});

	it("rejects bad connector ids and modes", () => {
		expect(parseClientMessage('{"type":"connector_connect"}')).toBeUndefined();
		expect(parseClientMessage('{"type":"connector_connect","connectorId":"../x"}')).toBeUndefined();
		expect(parseClientMessage('{"type":"connector_remove","connectorId":"__proto__"}')).toBeUndefined();
		expect(
			parseClientMessage(`{"type":"connector_signin","connectorId":"${"a".repeat(41)}"}`),
		).toBeUndefined();
		expect(
			parseClientMessage('{"type":"connector_mode","connectorId":"notion","mode":"all"}'),
		).toBeUndefined();
		expect(parseClientMessage('{"type":"connector_mode","connectorId":"notion"}')).toBeUndefined();
	});

	it("accepts setup, draft answers, scans, and imports", () => {
		expect(parseClientMessage('{"type":"connector_setup","connectorId":"discord"}')).toEqual({
			type: "connector_setup",
			connectorId: "discord",
		});
		expect(parseClientMessage('{"type":"connector_draft_reply","draftId":"d1","approve":true}')).toEqual({
			type: "connector_draft_reply",
			draftId: "d1",
			approve: true,
		});
		expect(parseClientMessage('{"type":"connectors_scan"}')).toEqual({ type: "connectors_scan" });
		expect(parseClientMessage('{"type":"connector_import","ids":["cursor:github"]}')).toEqual({
			type: "connector_import",
			ids: ["cursor:github"],
		});
		for (const bad of [
			'{"type":"connector_draft_reply","draftId":"d1"}',
			'{"type":"connector_draft_reply","draftId":3,"approve":false}',
			'{"type":"connector_import","ids":"cursor:github"}',
			'{"type":"connector_import","ids":[3]}',
			JSON.stringify({ type: "connector_import", ids: Array.from({ length: 201 }, (_, i) => `a:${i}`) }),
			'{"type":"connector_setup","connectorId":"../x"}',
		]) {
			expect(parseClientMessage(bad), bad.slice(0, 80)).toBeUndefined();
		}
	});
});

describe("computer control messages", () => {
	const parse = (value: object) => parseClientMessage(JSON.stringify(value));
	const token = "k3Y_0123456789abcdef-ABCDEF.~+/=";

	it("registers the desktop app's helper at a loopback MCP address, and unregisters it", () => {
		expect(parse({ type: "computer_register", url: "http://127.0.0.1:51234/mcp", token })).toEqual({
			type: "computer_register",
			url: "http://127.0.0.1:51234/mcp",
			token,
		});
		expect(parse({ type: "computer_register", url: "http://127.0.0.1:1/mcp", token, extra: 1 })).toEqual({
			type: "computer_register",
			url: "http://127.0.0.1:1/mcp",
			token,
		});
		expect(parse({ type: "computer_register", url: "http://127.0.0.1:65535/mcp", token })).toMatchObject({
			url: "http://127.0.0.1:65535/mcp",
		});
		expect(parse({ type: "computer_unregister" })).toEqual({ type: "computer_unregister" });
	});

	it("rejects any address other than http://127.0.0.1:<port>/mcp", () => {
		for (const url of [
			"https://127.0.0.1:51234/mcp",
			"http://localhost:51234/mcp",
			"http://[::1]:51234/mcp",
			"http://127.0.0.2:51234/mcp",
			"http://0.0.0.0:51234/mcp",
			"http://example.com:51234/mcp",
			"http://127.0.0.1/mcp",
			"http://127.0.0.1:0/mcp",
			"http://127.0.0.1:65536/mcp",
			"http://127.0.0.1:051234/mcp",
			"http://127.0.0.1:51234/",
			"http://127.0.0.1:51234/mcp/",
			"http://127.0.0.1:51234/mcp/x",
			"http://127.0.0.1:51234/MCP",
			"http://127.0.0.1:51234/mcp?x=1",
			"http://127.0.0.1:51234/mcp#x",
			"http://user:pass@127.0.0.1:51234/mcp",
			"http://127.0.0.1:51234@evil.example/mcp",
			" http://127.0.0.1:51234/mcp",
			"http://127.0.0.1:51234/mcp\n",
		]) {
			expect(parse({ type: "computer_register", url, token }), url).toBeUndefined();
		}
		expect(parse({ type: "computer_register", token })).toBeUndefined();
		expect(parse({ type: "computer_register", url: 51234, token })).toBeUndefined();
	});

	it("rejects a key that is missing, too short or long, or not safe for a header", () => {
		const url = "http://127.0.0.1:51234/mcp";
		for (const bad of [
			undefined,
			7,
			"",
			"short",
			"x".repeat(513),
			`${"a".repeat(20)} b`,
			`${"a".repeat(20)}\r\nX-Evil: 1`,
			`${"a".repeat(20)}"`,
		]) {
			expect(parse({ type: "computer_register", url, token: bad }), String(bad)).toBeUndefined();
		}
	});
});
