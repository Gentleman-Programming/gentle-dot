import { describe, expect, it } from "vitest";
import { isAppCommand, isPinCommand, parseClientMessage } from "../src/index.ts";

describe("channel protocol (WhatsApp, phase 1)", () => {
	it("accepts the channel read commands", () => {
		expect(parseClientMessage('{"type":"channel_list"}')).toEqual({ type: "channel_list" });
		expect(parseClientMessage('{"type":"channel_allowlist"}')).toEqual({ type: "channel_allowlist" });
		expect(parseClientMessage('{"type":"channel_pair_status"}')).toEqual({ type: "channel_pair_status" });
	});

	it("accepts well-formed allowlist changes with an E.164 digits-only number", () => {
		expect(
			parseClientMessage('{"type":"channel_allowlist_change","action":"add","number":"5491112345678"}'),
		).toEqual({ type: "channel_allowlist_change", action: "add", number: "5491112345678" });
		expect(
			parseClientMessage('{"type":"channel_allowlist_change","action":"remove","number":"5491112345678"}'),
		).toEqual({ type: "channel_allowlist_change", action: "remove", number: "5491112345678" });
	});

	it("rejects malformed allowlist changes", () => {
		expect(
			parseClientMessage('{"type":"channel_allowlist_change","action":"add","number":"+54 9 11 15"}'),
		).toBeUndefined();
		expect(
			parseClientMessage('{"type":"channel_allowlist_change","action":"upsert","number":"5491112345678"}'),
		).toBeUndefined();
		expect(parseClientMessage('{"type":"channel_allowlist_change","action":"add"}')).toBeUndefined();
	});

	it("accepts the pairing, verify and unpair commands", () => {
		for (const type of [
			"channel_pair_start",
			"channel_pair_regenerate",
			"channel_pair_cancel",
			"channel_verify",
			"channel_unpair",
		]) {
			expect(parseClientMessage(`{"type":"${type}"}`)).toEqual({ type });
		}
	});

	it("gates channel changes behind the app/PIN surface but lets reads through", () => {
		expect(isAppCommand({ type: "channel_allowlist_change", action: "add", number: "5491112345678" })).toBe(true);
		expect(isAppCommand({ type: "channel_pair_start" })).toBe(true);
		expect(isAppCommand({ type: "channel_unpair" })).toBe(true);
		expect(isAppCommand({ type: "channel_verify" })).toBe(true);
		expect(isAppCommand({ type: "channel_list" })).toBe(false);
		expect(isAppCommand({ type: "channel_pair_status" })).toBe(false);
		expect(isAppCommand({ type: "channel_allowlist" })).toBe(false);
		expect(isPinCommand({ type: "channel_unpair" })).toBe(true);
	});
});
