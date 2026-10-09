// The app's end of the channel reaches the daemon on fd 3 and goes no further (S25.1): children
// the daemon spawns (the engine, stdio servers, sign-in commands) never hold it, and a platform
// where they would gets no channel at all (fail closed).
import { spawn } from "node:child_process";
import { createServer, type Socket, connect as unixConnect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

const CHILD = fileURLToPath(new URL("./fixtures/app-channel-child.ts", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A connected pair of Unix sockets (Node has no socketpair): the app's end and the daemon's. */
async function socketPair(): Promise<{ app: Socket; daemon: Socket }> {
	const path = join(tempDir(), "pair.sock");
	const server = createServer();
	await new Promise<void>((done) => server.listen(path, done));
	const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
	const daemon = unixConnect(path);
	await new Promise((resolve) => daemon.once("connect", resolve));
	const app = await accepted;
	server.close();
	cleanups.push(() => app.destroy());
	return { app, daemon };
}

/** Runs the stand-in with the daemon's end on fd 3, then drops the test's copy of it. */
async function runChild(mode: "normal" | "leak") {
	const { app, daemon } = await socketPair();
	const child = spawn(process.execPath, [CHILD, mode], { stdio: ["ignore", "pipe", "pipe", daemon] });
	daemon.destroy();
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const lines: Record<string, unknown>[] = [];
	let buffer = "";
	app.setEncoding("utf8");
	app.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
			buffer = buffer.slice(end + 1);
			lines.push(frame);
			if (frame.kind === "request")
				app.write(`${JSON.stringify({ kind: "response", id: frame.id, result: {} })}\n`);
		}
	});
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	return { code, stdout, stderr, lines };
}

describe("the app channel on fd 3 (S25.1)", () => {
	it("is opened by the daemon and never reaches the children it spawns", async () => {
		const { code, stderr, lines } = await runChild("normal");
		expect(code, stderr).toBe(0);
		const report = lines.find((frame) => frame.method === "report")?.params as Record<string, unknown>;
		expect(report, stderr).toBeDefined();
		expect(report.identity).toMatch(/^-?\d+:\d+$/);
		// A child that inherited it would print the same socket identity.
		expect(report.fromSpawn).not.toBe(report.identity);
		expect(report.fromSpawnSync).not.toBe(report.identity);
		expect(report.fromShell).toBe("none");
		// The probe the daemon runs at startup does see a leak when there is one.
		expect(report.detectsALeak).toBe(true);
	});

	it("is refused and closed where a child would inherit it", async () => {
		const { code, stdout, stderr, lines } = await runChild("leak");
		expect(code, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ refused: true, closed: true });
		expect(lines).toEqual([]);
		expect(stderr).toMatch(/children would inherit/);
	});
});
