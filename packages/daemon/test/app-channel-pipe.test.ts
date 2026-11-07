// Framing over an owned connected fixture stream, not the production Windows transport.
// Native Windows ownership remains covered by windows-app-channel*.test.ts.
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AppChannel } from "../src/app-channel.ts";
import { waitFor } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

// TCP avoids Unix socket pathname limits under long, isolated checkout-local TMPDIRs.
async function listen() {
	const server = createServer();
	const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanups.push(() => {
		if (server.listening) server.close();
	});
	return { server, accepted, port: (server.address() as AddressInfo).port };
}

function collectFrames(peer: Socket): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	let buffer = "";
	peer.setEncoding("utf8");
	peer.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			frames.push(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
			buffer = buffer.slice(end + 1);
		}
	});
	return frames;
}

describe("connected fixture stream framing", () => {
	it("exchanges frames in both directions", async () => {
		const { accepted, port } = await listen();
		const channel = new AppChannel(connect({ host: "127.0.0.1", port }));
		cleanups.push(() => channel.close());
		const peer = await accepted;
		cleanups.push(() => peer.destroy());
		const frames = collectFrames(peer);
		const waiting = channel.request("approve", { connector: "notion" }, 5000);
		const ask = (await waitFor(() => frames[0])) as { id: number; method: string };
		expect(ask).toMatchObject({ kind: "request", id: 1, method: "approve" });
		peer.write(`${JSON.stringify({ kind: "response", id: ask.id, result: { approved: true } })}\n`);
		await expect(waiting).resolves.toEqual({ approved: true });
		channel.handler = (method, params) => ({ method, params });
		peer.write(`${JSON.stringify({ kind: "request", id: 7, method: "probe", params: { n: 1 } })}\n`);
		const answer = (await waitFor(() => frames[1])) as Record<string, unknown>;
		expect(answer).toEqual({ kind: "response", id: 7, result: { method: "probe", params: { n: 1 } } });
	});

	it("closes the channel when the fixture endpoint cannot be reached", async () => {
		const { server, port } = await listen();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		const channel = new AppChannel(connect({ host: "127.0.0.1", port }));
		cleanups.push(() => channel.close());
		await waitFor(() => !channel.connected);
		expect(channel.connected).toBe(false);
	});
});
