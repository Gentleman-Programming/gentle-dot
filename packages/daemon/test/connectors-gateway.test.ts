import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-mcp-cli.ts", import.meta.url));
const GUARD = fileURLToPath(new URL("../src/extensions/approval-guard.ts", import.meta.url));

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function setup(options: { home?: boolean; cliMode?: "auto" } = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const envFile = join(dataDir, "agent-env.json");
	const argsFile = join(dataDir, "agent-args.json");
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
		backoffMs: [50],
		agentEnv: {
			...process.env,
			FAKE_AGENT_ENV_FILE: envFile,
			FAKE_AGENT_ARGS_FILE: argsFile,
			...(options.cliMode ? { FAKE_MCP_CLI_MODE: options.cliMode } : {}),
		},
		...(options.home ? { agentHome } : {}),
		authRuntime: async () => fake.runtime,
		connectorCli: { command: process.execPath, args: [FAKE_CLI] },
		log: (line) => logs.push(line),
	});
	daemons.push(d);
	const agentEnv = () => JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string | undefined>;
	const agentArgs = () => JSON.parse(readFileSync(argsFile, "utf8")) as string[];
	return {
		d,
		dataDir,
		agentHome,
		logs,
		agentEnv,
		agentArgs,
		...(await connect(d)),
		connect: () => connect(d),
	};
}

async function connect(d: DotDaemon) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (m: object) => ws.send(JSON.stringify(m));
	function find<T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
	) {
		return waitFor(() =>
			messages.find(
				(m): m is Extract<ServerMessage, { type: T }> =>
					m.type === type && where(m as Extract<ServerMessage, { type: T }>),
			),
		);
	}
	return { ws, messages, send, find };
}

describe("connectors over the protocol", () => {
	it("lists the connectors, and /connectors opens the screen without reaching the assistant", async () => {
		const { send, find, messages } = await setup();
		send({ type: "connectors_list" });
		const list = await find("connectors");
		expect(list.connectors.map((c) => [c.id, c.status])).toEqual([
			["notion", "off"],
			["linear", "off"],
			["atlassian", "off"],
		]);
		expect(list.open).toBeUndefined();
		send({ type: "send", text: "/connectors" });
		expect((await find("connectors", (m) => m.open === true)).connectors).toHaveLength(3);
		expect(messages.some((m) => m.type === "user_message")).toBe(false);
	});

	it("connects: the sign-in goes to the window that asked, every window is refreshed, and the agent restarts with the new policy", async () => {
		const { d, send, find, agentEnv, connect: other } = await setup({ cliMode: "auto" });
		const second = await other();
		const pid = d.supervisor.pid;
		expect(JSON.parse(agentEnv().GENTLE_DOT_CONNECTOR_POLICY ?? "{}").connectors).toEqual({});
		send({ type: "connector_connect", connectorId: "notion" });
		const link = await find("auth_event", (m) => m.event.kind === "auth_url");
		expect(link.flowId).toMatch(/^connector-/);
		expect(await find("auth_done")).toMatchObject({ ok: true, providerId: "notion" });
		await second.find("connectors", (m) => m.connectors[0]?.status === "connected");
		expect(second.messages.some((m) => m.type === "auth_event" || m.type === "auth_done")).toBe(false);
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
		await waitFor(() => JSON.parse(agentEnv().GENTLE_DOT_CONNECTOR_POLICY ?? "{}").connectors?.notion);
		expect(JSON.parse(agentEnv().GENTLE_DOT_CONNECTOR_POLICY ?? "{}").connectors.notion.mode).toBe(
			"read_only",
		);
	});

	it("waits for the running answer before restarting for a connector change", async () => {
		const { d, send, find } = await setup({ cliMode: "auto" });
		send({ type: "send", text: "hang" });
		await find("agent_state", (m) => m.state === "thinking");
		const pid = d.supervisor.pid;
		send({ type: "connector_connect", connectorId: "linear" });
		await find("auth_done");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(d.supervisor.pid).toBe(pid);
		send({ type: "abort" });
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
	});

	it("cancels a connector sign-in through auth_reply and refuses unknown connectors", async () => {
		const { send, find } = await setup();
		send({ type: "connector_connect", connectorId: "atlassian" });
		const prompt = await find("auth_prompt");
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, cancelled: true });
		expect(await find("auth_done")).toMatchObject({ ok: false, message: "Sign-in cancelled." });
		send({ type: "connector_signin", connectorId: "gmail" });
		expect(await find("error", (m) => m.code === "unknown_connector")).toBeTruthy();
	});

	it("restores a changed mcp.json before the agent starts again", async () => {
		const { d, send, find, agentHome, logs } = await setup({ cliMode: "auto" });
		send({ type: "connector_connect", connectorId: "notion" });
		await find("auth_done");
		await waitFor(() => d.supervisor.state === "ready");
		const file = join(agentHome, "mcp.json");
		const approved = readFileSync(file, "utf8");
		writeFileSync(file, JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", "id"] } } }));
		await d.supervisor.restart();
		expect(readFileSync(file, "utf8")).toBe(approved);
		expect(logs.some((l) => l.includes("restored"))).toBe(true);
	});

	it("loads the approval guard into the assistant's own engine", async () => {
		const { agentArgs, agentEnv } = await setup({ home: true });
		const args = agentArgs();
		expect(args[args.indexOf("-e") + 1]).toBe(GUARD);
		expect(JSON.parse(agentEnv().GENTLE_DOT_CONNECTOR_POLICY ?? "{}")).toMatchObject({
			connectors: {},
			protectedPaths: expect.arrayContaining([GUARD]),
		});
	});
});
