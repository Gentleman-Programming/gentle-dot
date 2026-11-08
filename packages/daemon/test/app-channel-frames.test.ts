import { duplexPair } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppChannel } from "../src/app-channel.ts";
import { waitFor } from "./helpers.ts";

// Public protocol limit: one MiB of UTF-8 JSON, excluding the newline delimiter.
const LIMIT = 1024 * 1024;
const TOO_LONG = "the app's channel sent a frame that is too long; closing it";
const channels: AppChannel[] = [];
afterEach(() => {
	for (const channel of channels.splice(0)) channel.close();
});

function request(p: string, id = 1): string {
	return JSON.stringify({ kind: "request", id, method: "probe", params: { p } });
}

function fixture() {
	const [stream, input] = duplexPair();
	const output = input;
	const sent: unknown[] = [];
	let pending = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		pending += chunk;
		for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
			sent.push(JSON.parse(pending.slice(0, end)));
			pending = pending.slice(end + 1);
		}
	});
	const logged: string[] = [];
	const channel = new AppChannel(stream, {
		log: (line) => logged.push(line),
	});
	channels.push(channel);
	const delivered: { method: string; params: unknown }[] = [];
	channel.handler = (method, params) => {
		delivered.push({ method, params });
		return { ok: true };
	};
	const closed = vi.fn();
	channel.onClose(closed);
	return { input, channel, delivered, logged, sent, closed };
}

describe("app-channel UTF-8 frame limits", () => {
	it("accepts exactly the byte cap and rejects the next byte before dispatch", async () => {
		const f = fixture();
		const padding = LIMIT - Buffer.byteLength(request(""), "utf8");
		const exact = request("x".repeat(padding));
		expect(Buffer.byteLength(exact, "utf8")).toBe(LIMIT);
		f.input.write(`${exact}\n`);
		await waitFor(() => f.sent.length === 1);
		expect(f.channel.connected).toBe(true);
		expect(f.delivered).toEqual([{ method: "probe", params: { p: "x".repeat(padding) } }]);
		expect(f.sent).toEqual([{ kind: "response", id: 1, result: { ok: true } }]);
		f.input.write(`${request("x".repeat(padding + 1), 2)}\n`);
		await waitFor(() => !f.channel.connected || f.delivered.length > 1);
		expect(f.channel.connected).toBe(false);
		expect(f.delivered).toHaveLength(1);
		expect(f.sent).toHaveLength(1);
		expect(f.logged).toEqual([TOO_LONG]);
		expect(f.closed).toHaveBeenCalledTimes(1);
		f.channel.close();
		expect(f.closed).toHaveBeenCalledTimes(1);
	});

	it("rejects complete Unicode frames by bytes and rejects pending requests on close", async () => {
		const f = fixture();
		const answer = f.channel.request("waiting", {}, 1000).then(
			() => "unexpected success",
			(error: Error) => error.message,
		);
		await waitFor(() => f.sent.length === 1);
		const frame = request("é".repeat(LIMIT / 2 + 100), 9);
		expect(frame.length).toBeLessThan(LIMIT);
		expect(Buffer.byteLength(frame, "utf8")).toBeGreaterThan(LIMIT);
		f.input.write(`${frame}\n`);
		await waitFor(() => !f.channel.connected || f.delivered.length > 0);
		expect(f.channel.connected).toBe(false);
		expect(f.delivered).toEqual([]);
		expect(f.sent).toEqual([{ kind: "request", id: 1, method: "waiting", params: {} }]);
		expect(await answer).toBe("The Gentle Dot app closed its channel.");
		expect(f.logged).toEqual([TOO_LONG]);
		expect(f.closed).toHaveBeenCalledTimes(1);
	});

	it("rejects a pending Unicode frame over the byte cap without a newline", async () => {
		const f = fixture();
		const frame = request("é".repeat(LIMIT / 2 + 100));
		expect(frame.length).toBeLessThan(LIMIT);
		expect(Buffer.byteLength(frame, "utf8")).toBeGreaterThan(LIMIT);
		f.input.write(frame);
		await waitFor(() => !f.channel.connected, 200);
		expect(f.channel.connected).toBe(false);
		expect(f.delivered).toEqual([]);
		expect(f.sent).toEqual([]);
		expect(f.logged).toEqual([TOO_LONG]);
		expect(f.closed).toHaveBeenCalledTimes(1);
	});

	it("accepts consecutive valid Unicode frames even when their chunk exceeds the cap", async () => {
		const f = fixture();
		const p = "é".repeat(Math.floor(LIMIT * 0.3));
		const first = request(p, 1);
		const second = request(p, 2);
		expect(Buffer.byteLength(first, "utf8")).toBeLessThan(LIMIT);
		const chunk = `\n \t\n${first}\n${second}\n`;
		expect(Buffer.byteLength(chunk, "utf8")).toBeGreaterThan(LIMIT);
		f.input.write(chunk);
		await waitFor(() => f.sent.length === 2);
		expect(f.channel.connected).toBe(true);
		expect(f.delivered).toEqual([
			{ method: "probe", params: { p } },
			{ method: "probe", params: { p } },
		]);
		expect(f.sent).toEqual([
			{ kind: "response", id: 1, result: { ok: true } },
			{ kind: "response", id: 2, result: { ok: true } },
		]);
		expect(f.logged).toEqual([]);
		expect(f.closed).not.toHaveBeenCalled();
	});

	it("preserves a valid frame whose emoji bytes arrive in separate chunks", async () => {
		const f = fixture();
		const p = "hola ✓ 😀 ñ";
		const bytes = Buffer.from(`${request(p)}\n`, "utf8");
		const split = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;
		f.input.write(bytes.subarray(0, split));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.delivered).toEqual([]);
		expect(f.channel.connected).toBe(true);
		f.input.write(bytes.subarray(split));
		await waitFor(() => f.sent.length === 1);
		expect(f.delivered).toEqual([{ method: "probe", params: { p } }]);
		expect(f.sent).toEqual([{ kind: "response", id: 1, result: { ok: true } }]);
		expect(f.channel.connected).toBe(true);
		expect(f.logged).toEqual([]);
		expect(f.closed).not.toHaveBeenCalled();
	});
});
