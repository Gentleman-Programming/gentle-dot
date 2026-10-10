// Server mode (S25.8, B1): the daemon runs as root, and the engine's sign-in files (`auth.json`,
// `models.json`, `settings.json`) belong to the engine's user. Pi's ModelRuntime runs a value that
// starts with `!` as a shell command, so the daemon never opens those files itself: a helper started
// as the engine's user does, and answers over IPC. On the desktop nothing changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DaemonOptions, type DotDaemon, startDaemon } from "../src/daemon.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** The engine's environment without a model key from the machine running the tests. */
function cleanEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) delete env[key];
	return env;
}

/** An API key that is a shell command: it records its parent process (who ran it), then prints a key. */
function plantCommandKey(agentHome: string, marker: string): void {
	mkdirSync(agentHome, { recursive: true });
	writeFileSync(
		join(agentHome, "auth.json"),
		JSON.stringify({ openai: { type: "api_key", key: `!echo $PPID > '${marker}'; echo sk-from-command` } }),
	);
}

async function setup(vps: DaemonOptions["vps"] | undefined, plant?: (agentHome: string) => void) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	plant?.(agentHome);
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome,
		agentEnv: cleanEnv(),
		backoffMs: [50],
		...(vps ? { vps } : {}),
	});
	daemons.push(d);
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (m: object) => ws.send(JSON.stringify(m));
	const find = <T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
		after = 0,
	) =>
		waitFor(
			() =>
				messages
					.slice(after)
					.find(
						(m): m is Extract<ServerMessage, { type: T }> =>
							m.type === type && where(m as Extract<ServerMessage, { type: T }>),
					),
			15_000,
		);
	/** Signs in with an API key the way the Accounts screen does. */
	const signIn = async (providerId: string, key: string) => {
		const seen = messages.length;
		send({ type: "auth_login", providerId, method: "api_key" });
		const prompt = await find("auth_prompt", () => true, seen);
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: key });
		return find("auth_done", (m) => m.providerId === providerId, seen);
	};
	const accounts = async () => {
		const seen = messages.length;
		send({ type: "auth_list" });
		return find("auth_providers", () => true, seen);
	};
	return { d, dataDir, agentHome, messages, send, find, signIn, accounts };
}

/** Server mode with the test's own user standing in for the engine's, and a helper the daemon starts. */
const vpsAs = (engine: { uid: number; gid: number }): NonNullable<DaemonOptions["vps"]> => ({
	engine,
	connector: own,
	handOver: () => {},
	// The daemon's own files: with the test's user there is nothing to switch to.
	access: (fn) => fn(),
	authHelper: { command: process.execPath, args: [CLI, "--auth-helper"] },
});

describe("server mode: sign-in runs as the engine's user (S25.8, B1)", () => {
	it("never runs a planted `!command` API key in the daemon's own process", async () => {
		const marker = join(tempDir(), "who-ran-it");
		const s = await setup(vpsAs(own), (home) => plantCommandKey(home, marker));
		const listed = await s.accounts();
		// The key resolved, so voice is on, but in the helper: the shell's parent is not the daemon.
		expect(listed.providers.find((p) => p.id === "openai")).toMatchObject({ configured: true });
		expect(listed.voice).toMatchObject({ transcribe: true });
		await waitFor(() => existsSync(marker));
		const parent = Number(readFileSync(marker, "utf8").trim());
		expect(parent).toBeGreaterThan(0);
		expect(parent).not.toBe(process.pid);
	});

	it("fails closed when the helper cannot start as the engine's user: nothing runs", async () => {
		// A user the test cannot become: the helper's spawn is refused, like a broken engine user.
		const marker = join(tempDir(), "who-ran-it");
		const s = await setup(vpsAs({ uid: own.uid + 1, gid: own.gid }), (home) => plantCommandKey(home, marker));
		const seen = s.messages.length;
		s.send({ type: "auth_list" });
		await waitFor(
			() => s.messages.slice(seen).find((m) => m.type === "error" || m.type === "auth_providers"),
			15_000,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(marker)).toBe(false);
	});

	it("signs in, lists, uses the key for voice, and signs out through the helper", async () => {
		const s = await setup(vpsAs(own));
		expect((await s.signIn("openai", "sk-helper-test-not-real")).ok).toBe(true);
		const auth = JSON.parse(readFileSync(join(s.agentHome, "auth.json"), "utf8"));
		expect(auth.openai).toMatchObject({ type: "api_key", key: "sk-helper-test-not-real" });
		const listed = await s.accounts();
		expect(listed.providers.find((p) => p.id === "openai")).toMatchObject({
			configured: true,
			source: "stored",
		});
		expect(listed.voice).toMatchObject({ transcribe: true });
		s.send({ type: "auth_logout", providerId: "openai" });
		await waitFor(() => !JSON.parse(readFileSync(join(s.agentHome, "auth.json"), "utf8")).openai);
		expect((await s.accounts()).providers.find((p) => p.id === "openai")).toMatchObject({
			configured: false,
		});
	});

	it("cancels a sign-in waiting in the helper", async () => {
		const s = await setup(vpsAs(own));
		const seen = s.messages.length;
		s.send({ type: "auth_login", providerId: "openai", method: "api_key" });
		const prompt = await s.find("auth_prompt", () => true, seen);
		s.send({ type: "auth_reply", flowId: prompt.prompt.flowId, cancelled: true });
		expect(await s.find("auth_done", () => true, seen)).toMatchObject({
			ok: false,
			message: "Sign-in cancelled.",
		});
		expect(
			existsSync(join(s.agentHome, "auth.json")) && readFileSync(join(s.agentHome, "auth.json"), "utf8"),
		).not.toContain("openai");
	});
});

describe("on the desktop, sign-in stays in the daemon (regression)", () => {
	it("signs in with an API key, turns voice on, and signs out, with no helper", async () => {
		const s = await setup(undefined);
		expect((await s.signIn("openai", "sk-desktop-test-not-real")).ok).toBe(true);
		const listed = await s.accounts();
		expect(listed.providers.find((p) => p.id === "openai")).toMatchObject({
			configured: true,
			source: "stored",
		});
		expect(listed.voice).toMatchObject({ transcribe: true });
		s.send({ type: "auth_logout", providerId: "openai" });
		await waitFor(() => !JSON.parse(readFileSync(join(s.agentHome, "auth.json"), "utf8")).openai);
		expect((await s.accounts()).voice).toMatchObject({ transcribe: false });
	});
});
