/**
 * Salvaged gateway coverage: the tests here describe the CURRENT client protocol and the
 * isolation/white-label contracts that still hold. The rest of the old gateway suite specified
 * features the protocol no longer has (conversations, busy queue, message numbering, deltas) —
 * see odd/tasks/gateway-tests-migration.md for the verdict.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Daemon } from "../src/daemon.ts";
import { HIDDEN_NAMES } from "../src/white-label.ts";
import { bootDaemon, BRIDGE_KEY } from "./harness.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const booted: { stop(): Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(booted.splice(0).map((b) => b.stop()));
});

async function daemon(env: NodeJS.ProcessEnv = process.env): Promise<Daemon> {
	const bootedDaemon = await bootDaemon({ env, engineCommand: [process.execPath, FAKE_AGENT] });
	booted.push(bootedDaemon);
	return bootedDaemon.daemon;
}

type Client = { ws: WebSocket; messages: ServerMessage[]; closed: Promise<number> };

function connect(d: Daemon, origin?: string): Promise<Client> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`, origin ? { origin } : {});
		const messages: ServerMessage[] = [];
		const closed = new Promise<number>((done) => ws.on("close", (code) => done(code)));
		ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		ws.on("open", () => resolve({ ws, messages, closed }));
		ws.on("error", reject);
	});
}

async function authed(d: Daemon): Promise<Client> {
	const client = await connect(d);
	send(client, { type: "hello", token: BRIDGE_KEY, protocol: 1 });
	await find(client, "ready");
	return client;
}

function send(client: Client, message: object): void {
	client.ws.send(JSON.stringify(message));
}

function find<T extends ServerMessage["type"]>(
	client: Client,
	type: T,
	where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
) {
	return waitFor(() =>
		client.messages.find(
			(m): m is Extract<ServerMessage, { type: T }> =>
				m.type === type && where(m as Extract<ServerMessage, { type: T }>),
		),
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("gateway", () => {
	it("rejects a WebSocket upgrade from a foreign origin", async () => {
		const d = await daemon();
		await expect(connect(d, "https://evil.example")).rejects.toThrow(/403/);
	});

	it("accepts the desktop app origin", async () => {
		const d = await daemon();
		const client = await connect(d, "tauri://localhost");
		send(client, { type: "hello", token: BRIDGE_KEY, protocol: 1 });
		await find(client, "ready");
	});

	it("closes with 4401 when the token is wrong", { timeout: 20_000 }, async () => {
		const d = await daemon();
		const client = await connect(d);
		send(client, { type: "hello", token: "wrong", protocol: 1 });
		expect(await client.closed).toBe(4401);
		// The refusal says why before the close lands.
		expect(client.messages).toEqual([
			{ type: "error", code: "INVALID_TOKEN", message: "Invalid authentication token" },
		]);
	});

	it("closes with 4401 when the first message is not hello", { timeout: 20_000 }, async () => {
		const d = await daemon();
		const client = await connect(d);
		send(client, { type: "get_history" });
		expect(await client.closed).toBe(4401);
	});

	it("closes with 4400 for an unsupported protocol version", { timeout: 20_000 }, async () => {
		const d = await daemon();
		const client = await connect(d);
		send(client, { type: "hello", token: BRIDGE_KEY, protocol: 2 });
		expect(await client.closed).toBe(4400);
	});

	it("answers malformed frames with an error and keeps the connection", async () => {
		const d = await daemon();
		const client = await authed(d);
		client.ws.send("{nope");
		expect((await find(client, "error")).code).toBe("bad_message");
		send(client, { type: "get_history" });
		await find(client, "history");
	});
});

describe("white label", () => {
	it("passes the product identity to the agent", async () => {
		const argsFile = join(tempDir(), "argv.json");
		const d = await daemon({ ...process.env, FAKE_AGENT_ARGS_FILE: argsFile });
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		const at = argv.indexOf("--append-system-prompt");
		expect(at).toBeGreaterThan(-1);
		// The identity travels inline. It names the branded engines as instructions for the engine
		// itself; the UI-bound contract is covered by the chatter and ask cases.
		const identity = argv[at + 1] ?? "";
		expect(identity).toContain("Gentle Dot");
		expect(d.supervisor.state).toBe("ready");
	});

	it("hides branded startup chatter", async () => {
		const d = await daemon({ ...process.env, FAKE_AGENT_BRANDING: "1" });
		const client = await authed(d);
		send(client, { type: "get_history" });
		await find(client, "history");
		const text = JSON.stringify(client.messages);
		for (const name of HIDDEN_NAMES) expect(text).not.toMatch(name);
	});

	it("rewrites branded ask text", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "ask:confirm" });
		const ask = await find(client, "ask");
		expect(ask.message).toBe("Gentle Dot wants to continue");
	});

	it("refuses internal slash commands", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "/gentle:yolo" });
		expect((await find(client, "error")).code).toBe("unsupported");
		expect(client.messages.some((m) => m.type === "user_message")).toBe(false);
	});
});

describe("own instance", () => {
	it("runs the agent with the assistant's own home and profile store", async () => {
		const scratch = tempDir();
		const argsFile = join(scratch, "argv.json");
		const envFile = join(scratch, "env.json");
		const dataDir = tempDir();
		const agentHome = join(dataDir, "agent");
		const bootedDaemon = await bootDaemon({
			dataDir,
			workspace: dataDir,
			env: {
				...process.env,
				GENTLE_DOT_AGENT_HOME: agentHome,
				FAKE_AGENT_ARGS_FILE: argsFile,
				FAKE_AGENT_ENV_FILE: envFile,
			},
			engineCommand: [process.execPath, FAKE_AGENT],
		});
		booted.push(bootedDaemon);
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		expect(argv.slice(0, 4)).toEqual(["--home", agentHome, "--mode", "rpc"]);
		const engineEnv = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
		expect(engineEnv.GENTLE_PI_CONFIG_HOME).toBe(join(dataDir, "gentle-ai"));
	});

	it("gives the agent its own HOME and XDG folders, keeping PATH, the user's git identity, and the user's Engram", { timeout: 20_000 }, async () => {
		const scratch = tempDir();
		const realHome = join(scratch, "user");
		mkdirSync(realHome);
		writeFileSync(join(realHome, ".gitconfig"), "[user]\n\tname = Someone\n");
		const envFile = join(scratch, "env.json");
		const dataDir = tempDir();
		const bootedDaemon = await bootDaemon({
			dataDir,
			workspace: join(dataDir, "workspace"),
			env: {
				...process.env,
				HOME: realHome,
				XDG_CONFIG_HOME: join(realHome, ".config"),
				XDG_DATA_HOME: join(realHome, "data"),
				XDG_CACHE_HOME: join(realHome, "cache"),
				XDG_STATE_HOME: join(realHome, "state"),
				PI_CODING_AGENT_DIR: join(realHome, ".pi", "agent"),
				GENTLE_SHELL_CONFIG: join(realHome, ".gentle-shell", "config.json"),
				// The developer shell's own Engram and git variables must not leak into the contract.
				ENGRAM_DATA_DIR: undefined,
				GENTLE_DOT_ENGRAM_DATA_DIR: undefined,
				GIT_CONFIG_GLOBAL: undefined,
				ENGRAM_URL: "http://127.0.0.1:7437",
				FAKE_AGENT_ENV_FILE: envFile,
			},
			engineCommand: [process.execPath, FAKE_AGENT],
		});
		booted.push(bootedDaemon);
		const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string | undefined>;
		const home = join(dataDir, "home");
		// The invariants that matter (own HOME/XDG, the user's git identity, the user's Engram,
		// the policy and the subagent gate); other keys may exist alongside.
		expect(env).toMatchObject({
			GENTLE_PI_CONFIG_HOME: join(dataDir, "gentle-ai"),
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			GIT_CONFIG_GLOBAL: join(realHome, ".gitconfig"),
			ENGRAM_DATA_DIR: join(realHome, ".engram"),
			ENGRAM_URL: "http://127.0.0.1:7437",
			GENTLE_DOT_CONNECTOR_POLICY: expect.stringContaining('"connectors":{}'),
			GENTLE_PI_AGENTS: "1",
		});
		// The user's PATH survives: every entry the caller had is still offered to the engine
		// (a bundled bin may be prepended, order aside).
		const userPath = process.env.PATH ?? "";
		const userEntries = userPath.split(delimiter).filter(Boolean);
		expect(userEntries.length).toBeGreaterThan(0);
		for (const entry of userEntries) expect(env.PATH?.includes(entry)).toBe(true);
		expect(statSync(home).mode & 0o777).toBe(0o700);
		expect(existsSync(join(dataDir, "workspace"))).toBe(true);
	});
});
