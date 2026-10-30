// The Windows end of the app's private channel (S25.1, W7b): the daemon connects by name to a pipe
// the app created before it spawned. The name is not a secret — the app authenticates the daemon by
// the accepted connection's PID — so this pins the daemon's side: it must exchange frames in both
// directions and fail closed when the pipe is gone. It runs on every platform: the fake app is a
// `net.createServer` on a real path (a Unix socket on Linux/macOS, `\\.\pipe\…` on Windows).
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppChannel, namedPipeSocket } from "../src/app-channel.ts";
import { tempDir, waitFor } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A real path the fake app can listen on and the daemon can connect to. */
function channelPath(): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\gentle-dot-test-${randomBytes(8).toString("hex")}`
		: join(tempDir(), "app-channel-pipe.sock");
}

/** A fake app listening on a real path; `accepted` resolves with the daemon's connection. */
async function listen(path: string): Promise<{ accepted: Promise<Socket> }> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(path, done));
	cleanups.push(() => server.close());
	return { accepted: new Promise<Socket>((resolve) => server.once("connection", resolve)) };
}

/** The frames `peer` has received so far, parsed line by line. */
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

describe("the daemon's end of a named pipe (S25.1, W7b)", () => {
	it("exchanges frames in both directions", async () => {
		const path = channelPath();
		const { accepted } = await listen(path);
		const channel = new AppChannel(namedPipeSocket(path));
		cleanups.push(() => channel.close());
		const peer = await accepted;
		cleanups.push(() => peer.destroy());
		const frames = collectFrames(peer);

		// Daemon to app: a request, answered by the fake app.
		const waiting = channel.request("approve", { connector: "notion" }, 5000);
		const ask = (await waitFor(() => frames[0])) as { id: number; method: string };
		expect(ask).toMatchObject({ kind: "request", id: 1, method: "approve" });
		peer.write(`${JSON.stringify({ kind: "response", id: ask.id, result: { approved: true } })}\n`);
		await expect(waiting).resolves.toEqual({ approved: true });

		// App to daemon: a request, answered by the channel's handler.
		channel.handler = (method, params) => ({ method, params });
		peer.write(`${JSON.stringify({ kind: "request", id: 7, method: "probe", params: { n: 1 } })}\n`);
		const answer = (await waitFor(() => frames[1])) as Record<string, unknown>;
		expect(answer).toEqual({ kind: "response", id: 7, result: { method: "probe", params: { n: 1 } } });
	});

	it("closes the channel when the pipe cannot be reached", async () => {
		const channel = new AppChannel(namedPipeSocket(channelPath()));
		cleanups.push(() => channel.close());
		await waitFor(() => !channel.connected);
		expect(channel.connected).toBe(false);
	});
});
