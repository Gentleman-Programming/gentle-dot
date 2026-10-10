// The web PIN on a server (S25.8): the messages a browser sends to set it, to make a connector
// change with it, and to allow an approval with it. Anything else is refused at the parser.
import { describe, expect, it } from "vitest";
import { isPinCommand, PIN_REQUIRED, parseClientMessage } from "../src/index.ts";

const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe("web PIN messages", () => {
	it("accepts a PIN of 6 to 12 digits to set it", () => {
		expect(parse({ type: "pin_set", pin: "123456" })).toEqual({ type: "pin_set", pin: "123456" });
		expect(parse({ type: "pin_set", pin: "123456789012" })).toEqual({ type: "pin_set", pin: "123456789012" });
		for (const pin of ["12345", "1234567890123", "12345a", " 123456", 123456, ""])
			expect(parse({ type: "pin_set", pin }), String(pin)).toBeUndefined();
	});

	it("wraps one connector change with the PIN", () => {
		expect(
			parse({
				type: "pin_command",
				pin: "123456",
				command: { type: "connector_mode", connectorId: "notion", mode: "read_write" },
			}),
		).toEqual({
			type: "pin_command",
			pin: "123456",
			command: { type: "connector_mode", connectorId: "notion", mode: "read_write" },
		});
	});

	it("refuses a PIN command that wraps anything but a connector change", () => {
		const wrapped = [
			{ type: "send", text: "hi" },
			{ type: "computer_register", url: "http://127.0.0.1:5000/mcp", token: "a".repeat(43) },
			{ type: "computer_unregister" },
			{ type: "pin_set", pin: "123456" },
			{ type: "connector_mode", connectorId: "notion", mode: "everything" },
			{ type: "connector_draft_reply", draftId: "d1", approve: false },
		];
		for (const command of wrapped)
			expect(parse({ type: "pin_command", pin: "123456", command }), command.type).toBeUndefined();
		expect(
			parse({ type: "pin_command", pin: "12", command: { type: "connector_remove", connectorId: "notion" } }),
		).toBeUndefined();
	});

	it("allows an approval with the PIN", () => {
		expect(parse({ type: "pin_approve", requestId: "pin-1", pin: "123456" })).toEqual({
			type: "pin_approve",
			requestId: "pin-1",
			pin: "123456",
		});
		expect(parse({ type: "pin_approve", requestId: "pin-1" })).toBeUndefined();
		expect(parse({ type: "pin_approve", requestId: 1, pin: "123456" })).toBeUndefined();
	});

	it("names the connector changes a PIN may make: every app command except the computer helper", () => {
		const change = parse({ type: "connector_import", ids: ["claude:notion"] });
		const approveDraft = parse({ type: "connector_draft_reply", draftId: "d1", approve: true });
		const computer = parse({ type: "computer_unregister" });
		expect(change && isPinCommand(change)).toBe(true);
		expect(approveDraft && isPinCommand(approveDraft)).toBe(true);
		expect(computer && isPinCommand(computer)).toBe(false);
		expect(PIN_REQUIRED).toMatch(/PIN/);
	});
});
