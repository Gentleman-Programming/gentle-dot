// The app channel's frame cap is a byte count, not a character count (S25.1, S25.2). The app's
// end writes with `Buffer.byteLength`, so the daemon has to read with the same rule: a frame of
// multi-byte characters must not slip past a cap that only counted UTF-16 code units.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AppChannel, MAX_FRAME } from "../src/app-channel.ts";
import { waitFor } from "./helpers.ts";

/** A channel over a PassThrough, with what it delivered and the lines it logged. */
function channelWith() {
	const stream = new PassThrough();
	const delivered: { method: string; params: unknown }[] = [];
	const logged: string[] = [];
	const channel = new AppChannel(stream, { log: (line) => logged.push(line) });
	channel.handler = (method, params) => {
		delivered.push({ method, params });
		return { ok: true };
	};
	return { stream, channel, delivered, logged };
}

/** A request frame with `padding` ASCII characters of payload. */
function asciiFrame(padding: number): string {
	return JSON.stringify({ kind: "request", id: 1, method: "probe", params: { p: "x".repeat(padding) } });
}

describe("the app channel's frame cap counts bytes (S25.1)", () => {
	it("accepts a frame of exactly the cap and refuses the next byte", async () => {
		const { stream, channel, delivered } = channelWith();
		// Grow the payload until the frame lands on the cap exactly; one byte is enough per 'x'.
		const padding = MAX_FRAME - Buffer.byteLength(asciiFrame(0));
		expect(Buffer.byteLength(asciiFrame(padding))).toBe(MAX_FRAME);

		stream.write(`${asciiFrame(padding)}\n`);
		await waitFor(() => delivered.length === 1);
		expect(delivered.map((frame) => frame.method)).toEqual(["probe"]);
		expect(channel.connected).toBe(true);

		stream.write(`${asciiFrame(padding + 1)}\n`);
		await waitFor(() => delivered.length === 2 || !channel.connected);
		expect(delivered).toHaveLength(1);
		expect(channel.connected).toBe(false);
	});

	it("refuses a frame that is over the cap in bytes and under it in characters", async () => {
		const { stream, channel, delivered, logged } = channelWith();
		// Each `é` is one UTF-16 code unit and two UTF-8 bytes, so a length check lets this through.
		const frame = JSON.stringify({
			kind: "request",
			id: 1,
			method: "probe",
			params: { p: "é".repeat(MAX_FRAME / 2 + 100) },
		});
		expect(Buffer.byteLength(frame)).toBeGreaterThan(MAX_FRAME);
		expect(frame.length).toBeLessThan(MAX_FRAME);

		stream.write(`${frame}\n`);
		await waitFor(() => delivered.length === 1 || !channel.connected);
		expect(delivered).toEqual([]);
		expect(channel.connected).toBe(false);
		expect(logged.some((line) => line.includes("too long"))).toBe(true);
	});

	it("refuses a frame that never completes and is already over the cap in bytes", async () => {
		const { stream, channel } = channelWith();
		const partial = `{"kind":"request","id":1,"method":"probe","params":{"p":"${"é".repeat(MAX_FRAME / 2 + 100)}"`;
		expect(Buffer.byteLength(partial)).toBeGreaterThan(MAX_FRAME);
		expect(partial.length).toBeLessThan(MAX_FRAME);

		stream.write(partial);
		await waitFor(() => !channel.connected, 200);
		expect(channel.connected).toBe(false);
	});

	it("still delivers a multi-byte frame that is well under the cap", async () => {
		const { stream, channel, delivered } = channelWith();
		const params = { p: "hola ✓ 😀 ñ" };
		stream.write(`${JSON.stringify({ kind: "request", id: 1, method: "probe", params })}\n`);
		await waitFor(() => delivered.length === 1);
		expect(delivered).toEqual([{ method: "probe", params }]);
		expect(channel.connected).toBe(true);
	});
});
