import { describe, expect, it } from "vitest";
import { brandInbound, createEchoGuard } from "./channel-contract.js";

/**
 * The two rules the channel contract owns, not each provider (Gentleman-Programming#48):
 * the transport never answers itself, and every inbound carries the channel's identity.
 */

describe("echo guard", () => {
	it("drops the inbound that carries an id the transport already sent", () => {
		const guard = createEchoGuard();
		guard.remember("wamid.ACCB057D");
		expect(guard.isEcho("wamid.ACCB057D")).toBe(true);
	});

	it("lets a different id through, even right after remembering another", () => {
		const guard = createEchoGuard();
		guard.remember("wamid.ACCB057D");
		expect(guard.isEcho("wamid.ACEE5C66")).toBe(false);
	});

	it("forgets the oldest id instead of growing without bound", () => {
		const guard = createEchoGuard(2);
		guard.remember("a");
		guard.remember("b");
		guard.remember("c");
		expect(guard.isEcho("a")).toBe(false);
		expect(guard.isEcho("c")).toBe(true);
	});
});

describe("channel label", () => {
	it("prepends the channel label to the text the assistant receives", () => {
		expect(brandInbound("📱 [Rosita · Telegram]", "hola")).toBe("📱 [Rosita · Telegram] hola");
	});

	it("does not label the same text twice", () => {
		const once = brandInbound("📱 [Rosita · Telegram]", "hola");
		expect(brandInbound("📱 [Rosita · Telegram]", once)).toBe(once);
	});

	it("leaves an empty inbound empty rather than sending a dangling label", () => {
		expect(brandInbound("📱 [Rosita · Telegram]", "   ")).toBe("");
	});
});
