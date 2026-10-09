import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp, sendLikeThePanel } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { oauthOptions } from "./fake-oauth.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const GUARD = fileURLToPath(new URL("../src/extensions/approval-guard.ts", import.meta.url));

/** The engine's mcp.json without the proxy key, which changes with every engine launch. */
const withoutKey = (text: string) => text.replace(/Bearer [^"]+/g, "Bearer <key>");

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function setup(options: { home?: boolean; browser?: "auto" } = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const envFile = join(dataDir, "agent-env.json");
	const argsFile = join(dataDir, "agent-args.json");
	const logs: string[] = [];
	const fake = fakeAuthRuntime();
	// Connector changes come from the desktop app (S25.2); it allows the ones it confirms.
	const app = fakeApp([], "allow");
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
		},
		...(options.home ? { agentHome } : {}),
		authRuntime: async () => fake.runtime,
		connectorOAuth: oauthOptions(options.browser === "auto"),
		appChannel: app.daemonEnd,
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
		...(await connect(d, app)),
		connect: () => connect(d, app),
	};
}

async function connect(d: DotDaemon, app: ReturnType<typeof fakeApp>) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	const ready = await waitFor(() => messages.find((m) => m.type === "ready"));
	const clientId = ready.type === "ready" ? (ready.clientId ?? "") : "";
	const send = sendLikeThePanel(
		app,
		() => clientId,
		(m) => ws.send(JSON.stringify(m)),
	);
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
			["discord", "off"],
			["slack", "off"],
			["gmail", "off"],
		]);
		expect(list.open).toBeUndefined();
		send({ type: "send", text: "/connectors" });
		expect((await find("connectors", (m) => m.open === true)).connectors).toHaveLength(6);
		expect(messages.some((m) => m.type === "user_message")).toBe(false);
	});

	it("connects: the sign-in goes to the window that asked, every window is refreshed, and the agent restarts with the new policy", async () => {
		const { d, send, find, agentEnv, connect: other } = await setup({ browser: "auto" });
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
		const { d, send, find } = await setup({ browser: "auto" });
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
		send({ type: "connector_signin", connectorId: "nope" });
		expect(await find("error", (m) => m.code === "unknown_connector")).toBeTruthy();
	});

	it("restores a changed mcp.json before the agent starts again", async () => {
		const { d, send, find, agentHome, logs } = await setup({ browser: "auto" });
		send({ type: "connector_connect", connectorId: "notion" });
		await find("auth_done");
		await waitFor(() => d.supervisor.state === "ready");
		const file = join(agentHome, "mcp.json");
		const approved = readFileSync(file, "utf8");
		writeFileSync(file, JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", "id"] } } }));
		await d.supervisor.restart();
		expect(withoutKey(readFileSync(file, "utf8"))).toBe(withoutKey(approved));
		expect(readFileSync(file, "utf8")).not.toBe(approved);
		expect(logs.some((l) => l.includes("put back"))).toBe(true);
	});

	it("keeps a connector the user turned off turned off when the agent edits the files and ends itself (B1)", async () => {
		const { d, send, find, messages, dataDir, agentHome, agentEnv } = await setup({ browser: "auto" });
		const started = d.supervisor.pid;
		send({ type: "connector_connect", connectorId: "notion" });
		await find("auth_done");
		// The sign-in is quick: let the restart for connecting finish before the next change.
		await waitFor(() => d.supervisor.pid !== started && d.supervisor.state === "ready");
		send({ type: "connector_disconnect", connectorId: "notion" });
		await waitFor(() => !JSON.parse(agentEnv().GENTLE_DOT_CONNECTOR_POLICY ?? "{}").connectors?.notion);
		await waitFor(() => d.supervisor.state === "ready" && !d.supervisor.busy);
		const approved = {
			connectors: readFileSync(join(dataDir, "connectors.json"), "utf8"),
			mcp: readFileSync(join(agentHome, "mcp.json"), "utf8"),
		};
		const pid = d.supervisor.pid;
		send({ type: "send", text: "tamper" });
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready", 10_000);
		// The new engine got the user's state, not the edited files.
		const policy = JSON.parse(agentEnv().GENTLE_DOT_CONNECTOR_POLICY ?? "{}");
		expect(policy.connectors).toEqual({});
		expect(policy.proxied).toEqual([]);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(approved.connectors);
		expect(withoutKey(readFileSync(join(agentHome, "mcp.json"), "utf8"))).toBe(withoutKey(approved.mcp));
		expect(existsSync(join(dataDir, "workspace", ".pi", "mcp.json"))).toBe(false);
		await find("toast", (m) => m.message === "A change to your connectors was blocked.");
		send({ type: "connectors_list" });
		await waitFor(() =>
			messages.some(
				(m) => m.type === "connectors" && m.connectors[0]?.enabled === false && m.connectors[0]?.added,
			),
		);
		expect(
			messages.some(
				(m) =>
					m.type === "connectors" &&
					m.connectors[0]?.enabled === true &&
					m.connectors[0].mode === "read_write",
			),
		).toBe(false);
	});

	it("puts the files back while the agent keeps running, and after the run settles (B1)", async () => {
		const { d, send, find, dataDir, agentHome } = await setup();
		await waitFor(() => d.supervisor.state === "ready");
		const pid = d.supervisor.pid;
		send({ type: "send", text: "tamper:stay" });
		await find("toast", (m) => m.message === "A change to your connectors was blocked.");
		await waitFor(() => !existsSync(join(dataDir, "workspace", ".pi", "mcp.json")));
		await waitFor(
			() => JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers.notion === undefined,
		);
		expect(JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8")).connectors).toEqual({});
		expect(d.supervisor.pid).toBe(pid);
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
