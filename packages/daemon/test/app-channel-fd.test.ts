// The POSIX fd-3 channel never reaches descendants. Windows uses branded native
// adoption instead; the retired anonymous-stdio selector must grant no privilege.
import { spawn } from "node:child_process";
import { createServer, type Socket, connect as unixConnect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";
import { hasInheritedAppChannel } from "./support/platform-absence.ts";

const CHILD = fileURLToPath(new URL("./fixtures/app-channel-child.ts", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A connected pair of Unix sockets (Node has no socketpair). */
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

async function runChild(mode: "normal" | "leak") {
	const { app, daemon } = await socketPair();
	const child = spawn(process.execPath, [CHILD, mode], { stdio: ["ignore", "pipe", "pipe", daemon] });
	daemon.destroy();
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
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

describe.skipIf(
	!hasInheritedAppChannel("the app channel on fd 3 (S25.1)"),
)("the app channel on fd 3 (S25.1)", () => {
	it("is opened by the daemon and never reaches the children it spawns", async () => {
		const { code, stderr, lines } = await runChild("normal");
		expect(code, stderr).toBe(0);
		const report = lines.find((frame) => frame.method === "report")?.params as Record<string, unknown>;
		expect(report, stderr).toBeDefined();
		expect(report.identity).toMatch(/^-?\d+:\d+$/);
		expect(report.fromSpawn).not.toBe(report.identity);
		expect(report.fromSpawnSync).not.toBe(report.identity);
		expect(report.fromShell).toBe("none");
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

describe.skipIf(process.platform !== "win32")("the retired Windows anonymous app pipes", () => {
	// Native adoption/drain/descendant exclusion belongs to windows-app-channel*.test.ts.
	// This fixture now proves that even real stdio pipes and the old selector cannot
	// acquire an unbranded privileged channel. It never reaches its descendant spawns.
	for (const invalid of [undefined, "stdin", "stdout"] as const) {
		it(`refuses the legacy selector with ${invalid ?? "valid"} stdio`, async () => {
			const child = spawn(process.execPath, [WINDOWS_CHILD], {
				env: { ...process.env, GENTLE_DOT_APP_STDIO: "v1" },
				stdio: [invalid === "stdin" ? "ignore" : "pipe", invalid === "stdout" ? "ignore" : "pipe", "pipe"],
				timeout: 5000,
			});
			let stdout = "";
			let stderr = "";
			let failure: Error | undefined;
			child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
			const closed = new Promise<number | null>((resolve) => {
				child.once("error", (error) => { failure = error; });
				child.once("close", resolve);
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end();
			const code = await closed;
			expect(failure).toBeUndefined();
			expect(code).toBe(2);
			expect(stdout).toBe("");
			expect(stderr).toBe("Expected the Windows app channel.\nselector=v1\n");
		}, 10_000);
	}
});
