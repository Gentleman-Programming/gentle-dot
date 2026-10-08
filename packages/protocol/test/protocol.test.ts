import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "../src/index.ts";

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
