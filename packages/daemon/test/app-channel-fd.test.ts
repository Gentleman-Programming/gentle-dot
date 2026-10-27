// The app's end of the channel reaches the daemon on fd 3 and goes no further (S25.1): children
// the daemon spawns (the engine, stdio servers, sign-in commands) never hold it, and a platform
// where they would gets no channel at all (fail closed).
import { spawn } from "node:child_process";
import { createServer, type Socket, connect as unixConnect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duplex, Readable, Writable } from "node:stream";
import { AppChannel } from "../src/app-channel.ts";
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

describe.skipIf(process.platform === "win32")("the app channel on fd 3 (S25.1)", () => {
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

const WINDOWS_CHILD = fileURLToPath(new URL("./fixtures/app-channel-windows-child.ts", import.meta.url));
const PRIVATE_ECHO = { sentinel: "private-app-echo-not-descendant-input" };

/** Real owned anonymous pipes. Fresh descendant pipes are tested by bytes, not dev:ino. */
async function runWindowsChild(invalid?: "stdin" | "stdout") {
	const child = spawn(process.execPath, [WINDOWS_CHILD], {
		env: { ...process.env, GENTLE_DOT_APP_STDIO: "v1" },
		stdio: [invalid === "stdin" ? "ignore" : "pipe", invalid === "stdout" ? "ignore" : "pipe", "pipe"],
		timeout: 25_000,
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	// Register close/error before exchanging any frames, including the invalid-handle cases.
	let failure: Error | undefined;
	const closed = new Promise<number | null>((resolve) => {
		child.once("error", (error) => { failure = error; });
		child.once("close", resolve);
	});
	let channel: AppChannel | undefined;
	let report: unknown;
	let echo: unknown;
	try {
		if (!invalid && child.stdout && child.stdin) {
			channel = new AppChannel(Duplex.fromWeb({
				readable: Readable.toWeb(child.stdout), writable: Writable.toWeb(child.stdin),
			}));
			channel.handler = (method, params) => {
				if (method !== "report") throw new Error(`Unexpected method: ${method}`);
				report = params;
				return { accepted: "private-report-ack" };
			};
			// Observe rejection immediately; always reap the owned process before surfacing it.
			const answer = await channel.request("echo", PRIVATE_ECHO, 20_000).then(
				(value) => ({ value }), (error: Error) => ({ error }),
			);
			const code = await closed;
			if (failure) throw failure;
			if ("error" in answer) throw answer.error;
			echo = answer.value;
			return { code, stdout, stderr, report, echo };
		}
		child.stdin?.on("error", () => {}); // Refused stdout may close its input immediately.
		child.stdin?.end();
		const code = await closed;
		if (failure) throw failure;
		return { code, stdout, stderr, report, echo };
	} finally {
		channel?.close();
	}
}

describe.skipIf(process.platform !== "win32")("the Windows anonymous app pipes (S25.1)", () => {
	it("exchanges exact frames, consumes the selector, and gives async/sync/cmd descendants distinct fresh pipes", async () => {
		const { code, stdout, stderr, echo, report } = await runWindowsChild();
		expect(code, stderr).toBe(0);
		expect(stderr).toBe("");
		expect(echo).toEqual(PRIVATE_ECHO);
		const descendant = (mode: string) => ({
			code: 0,
			stdout: `${JSON.stringify({ input: `fresh-${mode}-stdin\n`, selector: null })}\n`,
			stderr: `descendant-${mode}\n`,
		});
		const expectedReport = {
			selector: null,
			fromSpawn: descendant("async"),
			fromSpawnSync: descendant("sync"),
			fromShell: descendant("shell"),
		};
		expect(report).toEqual(expectedReport);
		// No descendant stdout/stderr bytes or extra privileged frames may escape onto the app pipe.
		const frames = stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
		expect(frames).toHaveLength(2);
		expect(frames).toContainEqual({ kind: "response", id: 1, result: PRIVATE_ECHO });
		expect(frames).toContainEqual({ kind: "request", id: 1, method: "report", params: expectedReport });
	}, 30_000);

	for (const invalid of ["stdin", "stdout"] as const) {
		it(`rejects invalid ${invalid} with the existing error, consumed selector and no privileged frames`, async () => {
			const { code, stdout, stderr, report, echo } = await runWindowsChild(invalid);
			expect(code).toBe(2);
			expect(stdout).toBe("");
			expect(stderr).toBe("The app's private Windows pipes are unavailable.\nselector=consumed\n");
			expect(report).toBeUndefined();
			expect(echo).toBeUndefined();
		}, 30_000);
	}
});
