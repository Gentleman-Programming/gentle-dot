// The daemon lives as long as the app that launched it (S35.2, #22), and the engine owns its home on
// the first start (S35.3, #13).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppChannel } from "../src/app-channel.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const MARKER = ".gentle-shell-home";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function start(
	options: { appChannel?: ReturnType<typeof fakeApp>; agentHome?: string; dataDir?: string } = {},
) {
	const dataDir = options.dataDir ?? tempDir();
	const markerFile = join(tempDir(), "marker.json");
	const logs: string[] = [];
	const fake = fakeAuthRuntime();
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: options.agentHome ?? join(dataDir, "agent"),
		agentEnv: { ...process.env, FAKE_AGENT_MARKER_FILE: markerFile },
		backoffMs: [50],
		authRuntime: async () => fake.runtime,
		...(options.appChannel ? { appChannel: options.appChannel.daemonEnd } : {}),
		log: (line) => logs.push(line),
	});
	daemons.push(d);
	const markedAtSpawn = () => JSON.parse(readFileSync(markerFile, "utf8")) as boolean;
	return { d, dataDir, logs, markedAtSpawn };
}

const health = (port: number) =>
	fetch(`http://127.0.0.1:${port}/health`).then(
		(res) => res.ok,
		() => false,
	);

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("the daemon's lifetime (S35.2)", () => {
	it("a daemon started by the app stops when its app channel closes", async () => {
		const app = fakeApp();
		const { d, logs } = await start({ appChannel: app });
		const engine = d.supervisor.pid;
		expect(engine).toBeDefined();
		expect(await health(d.port)).toBe(true);
		let stopped = false;
		void d.closed.then(() => {
			stopped = true;
		});

		app.close();
		await waitFor(() => stopped, 10_000);
		expect(d.supervisor.state).toBe("stopped");
		expect(alive(engine as number)).toBe(false);
		expect(await health(d.port)).toBe(false);
		expect(logs.join("\n")).toMatch(/channel closed.*stopping/);
	});

	it("a daemon without a channel keeps running as today", async () => {
		const { d } = await start();
		let stopped = false;
		void d.closed.then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(stopped).toBe(false);
		expect(d.supervisor.state).toBe("ready");
		expect(await health(d.port)).toBe(true);
	});

	it("closing twice, or closing while the app quits, stops once", async () => {
		const app = fakeApp();
		const { d } = await start({ appChannel: app });
		const first = d.close();
		app.close();
		await Promise.all([first, d.close(), d.closed]);
		expect(d.supervisor.state).toBe("stopped");
	});
});

describe("frames the app would refuse are never sent (S35.2: a refused frame would close the channel)", () => {
	it("an approval too large for one frame is refused here and the channel stays open", async () => {
		const app = fakeApp(["allow"]);
		const channel = new AppChannel(app.daemonEnd);
		const huge = { name: "text", value: "x".repeat(1024 * 1024) };
		expect(await channel.approve({ connector: "Notion", action: "create pages", preview: [huge] })).toBe(
			false,
		);
		expect(app.asked).toEqual([]);
		expect(channel.connected).toBe(true);
		expect(
			await channel.approve({
				connector: "Notion",
				action: "create pages",
				preview: [{ name: "t", value: "x" }],
			}),
		).toBe(true);
		channel.close();
	});
});

describe("the engine's own home (S35.3)", () => {
	const engineVersion = (
		createRequire(import.meta.url)("gentle-pi/package.json" as string) as { version: string }
	).version;

	it("a fresh default data dir is marked as the engine's own before the first spawn", async () => {
		const { dataDir, markedAtSpawn } = await start();
		expect(markedAtSpawn()).toBe(true);
		const marker = JSON.parse(readFileSync(join(dataDir, "agent", MARKER), "utf8"));
		// The format gentle-shell writes itself (bin/gentle-shell.mjs, writeHomeOwnershipMarker).
		expect(marker).toEqual({ createdBy: "gentle-shell", version: engineVersion });
	});

	it("an overridden agent home is never marked", async () => {
		const chosen = tempDir();
		const { markedAtSpawn } = await start({ agentHome: chosen });
		expect(markedAtSpawn()).toBe(false);
		expect(existsSync(join(chosen, MARKER))).toBe(false);
	});

	it("an install stuck without the marker recovers on the next start", async () => {
		// What #13 left behind: the daemon's files in the home, and no marker.
		const dataDir = tempDir();
		const home = join(dataDir, "agent");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		writeFileSync(join(home, "auth.json"), "{}\n");
		writeFileSync(join(home, "mcp.json"), `${JSON.stringify({ mcpServers: {} })}\n`);
		const { markedAtSpawn } = await start({ dataDir });
		expect(markedAtSpawn()).toBe(true);
		expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("{}\n");
	});

	it("a marker gentle-shell already wrote is kept as it is", async () => {
		const dataDir = tempDir();
		const home = join(dataDir, "agent");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const own = `${JSON.stringify({ createdBy: "gentle-shell", version: "3.9.0" })}\n`;
		writeFileSync(join(home, MARKER), own);
		await start({ dataDir });
		expect(readFileSync(join(home, MARKER), "utf8")).toBe(own);
	});
});
