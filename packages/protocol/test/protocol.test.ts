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
		]) {
			expect(parseClientMessage(raw), raw).toBeUndefined();
		}
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
