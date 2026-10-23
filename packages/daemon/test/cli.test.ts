import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Socket, connect as unixConnect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";
import { expectPosixMode } from "./support/posix-modes.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("gentle-dot command", () => {
	it("keeps the access key out of redirected output, such as a log file", async () => {
		const dataDir = join(tempDir(), "data");
		const child = spawn(process.execPath, [CLI], {
			env: {
				...process.env,
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_AGENT_BIN: process.execPath,
				GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const exited = new Promise((resolve) => child.on("close", resolve));
		try {
			await waitFor(() => output.includes("Gentle Dot is running"), 15_000);
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
		const token = readFileSync(join(dataDir, "token"), "utf8").trim();
		expect(output).not.toContain(token);
		expect(output).toContain(`the access key is in ${join(dataDir, "token")}`);
		expectPosixMode(dataDir, 0o700);
	});

	it.skipIf((process.getuid?.() ?? 0) === 0)(
		"refuses server mode it cannot keep: GENTLE_DOT_VPS as a user that is not root (S25.8)",
		async () => {
			const dataDir = join(tempDir(), "data");
			const child = spawn(process.execPath, [CLI], {
				env: {
					...process.env,
					GENTLE_DOT_VPS: "1",
					GENTLE_DOT_DATA_DIR: dataDir,
					GENTLE_DOT_PORT: "0",
					GENTLE_DOT_AGENT_BIN: process.execPath,
					GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
			const code = await Promise.race([
				new Promise((resolve) => child.on("close", resolve)),
				new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000)),
			]);
			if (code === "still running") child.kill("SIGTERM");
			expect(code).toBe(1);
			expect(output).toMatch(/failed to start: Server mode .* root/);
			expect(output).not.toContain("Gentle Dot is running");
		},
	);

	it("a daemon launched with the app's channel exits when the app goes (S35.2, #22)", async () => {
		const dataDir = join(tempDir(), "data");
		const channel = await appChannel();
		const child = spawn(process.execPath, [CLI], {
			env: {
				...process.env,
				GENTLE_DOT_DATA_DIR: dataDir,
				GENTLE_DOT_PORT: "0",
				GENTLE_DOT_AGENT_BIN: process.execPath,
				GENTLE_DOT_AGENT_ARGS: JSON.stringify([FAKE_AGENT]),
				...channel.env,
			},
			stdio: ["ignore", "pipe", "pipe", ...(channel.inherited ? [channel.inherited] : [])],
		});
		channel.inherited?.destroy();
		let output = "";
		const collect = (chunk: Buffer) => {
			output += chunk.toString();
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
		try {
			// The daemon is up once it asks the app for something (the connectors' integrity key).
			const app = await channel.app();
			await new Promise((resolve) => app.once("data", resolve));
			// The app quits, crashes, or is killed: the kernel closes its end of the channel.
			app.destroy();
			expect(await exited).toBe(0);
		} finally {
			child.kill("SIGKILL");
			channel.close();
		}
		expect(output).toContain("the desktop app's channel closed; stopping the assistant");
	});
});

/** The app's end of the private channel (S25.1), and what the daemon is handed to reach it. */
interface TestAppChannel {
	/** The app's connected end, once the daemon has connected where it connects by name. */
	app(): Promise<Socket>;
	/** The descriptor the daemon inherits where this host has one. */
	inherited?: Socket;
	/** The pipe name the daemon is told to connect to where this host has no descriptor. */
	env?: Record<string, string>;
	/** Drops the app's end and the listener. */
	close(): void;
}

/**
 * A stand-in app holding the daemon's private channel the way the real one does on this platform: a
 * connected pair of Unix sockets handed over as fd 3 on POSIX (Node has no socketpair), and a named
 * pipe whose name the daemon is given in `GENTLE_DOT_CHANNEL_PIPE` on Windows (W7). The subject is
 * the same one either way — the channel the app owns — so the test keeps exercising the daemon's own
 * reaction to it closing on both hosts instead of skipping the Windows one.
 */
async function appChannel(): Promise<TestAppChannel> {
	if (process.platform !== "win32") {
		const path = join(tempDir(), "pair.sock");
		const server = createServer();
		await new Promise<void>((done) => server.listen(path, done));
		const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
		const daemon = unixConnect(path);
		await new Promise((resolve) => daemon.once("connect", resolve));
		const app = await accepted;
		server.close();
		return { app: async () => app, inherited: daemon, close: () => app.destroy() };
	}
	const name = `\\\\.\\pipe\\gentle-dot-test-${randomBytes(8).toString("hex")}`;
	const server = createServer();
	await new Promise<void>((done) => server.listen(name, done));
	const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
	return { app: () => accepted, env: { GENTLE_DOT_CHANNEL_PIPE: name }, close: () => server.close() };
}
