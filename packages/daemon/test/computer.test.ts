import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConnectorInfo, ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp, sendLikeThePanel } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { oauthOptions } from "./fake-oauth.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const HELPER = "http://127.0.0.1:51234/mcp";
const KEY = "s3cr3t-Computer-Key-0123456789abcdef";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

interface Setup {
	browser?: "auto";
	/** Written to `<data>/connectors.json` before the daemon starts. */
	saved?: object;
	/** Files below the home folder the import scan reads, by relative path. */
	importFiles?: Record<string, object>;
}

async function setup(options: Setup = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const importHome = join(dataDir, "import-home");
	const envFile = join(dataDir, "agent-env.json");
	const logs: string[] = [];
	if (options.saved) writeFileSync(join(dataDir, "connectors.json"), JSON.stringify(options.saved));
	for (const [path, content] of Object.entries(options.importFiles ?? {})) {
		mkdirSync(dirname(join(importHome, path)), { recursive: true });
		writeFileSync(join(importHome, path), JSON.stringify(content));
	}
	const fake = fakeAuthRuntime();
	// The desktop app registers the helper and makes the connector changes (S25.2).
	const app = fakeApp([], "allow");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome,
		backoffMs: [50],
		agentEnv: {
			...process.env,
			FAKE_AGENT_ENV_FILE: envFile,
		},
		authRuntime: async () => fake.runtime,
		connectorOAuth: oauthOptions(options.browser === "auto"),
		importHome,
		appChannel: app.daemonEnd,
		log: (line) => logs.push(line),
	});
	daemons.push(d);
	const mcpFile = join(agentHome, "mcp.json");
	const servers = (): Record<string, unknown> =>
		existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers : {};
	const agentEnv = () => readFileSync(envFile, "utf8");
	const policy = () =>
		JSON.parse(JSON.parse(agentEnv()).GENTLE_DOT_CONNECTOR_POLICY ?? "{}") as {
			builtin?: string[];
			connectors?: Record<string, { mode: string }>;
		};
	return {
		d,
		dataDir,
		logs,
		mcpFile,
		servers,
		agentEnv,
		policy,
		app,
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
	/** The next connector list after the ones already received. */
	async function list(where: (connectors: ConnectorInfo[]) => boolean = () => true) {
		const seen = messages.length;
		send({ type: "connectors_list" });
		const found = await waitFor(() =>
			messages
				.slice(seen)
				.find(
					(m): m is Extract<ServerMessage, { type: "connectors" }> =>
						m.type === "connectors" && where(m.connectors),
				),
		);
		return found.connectors;
	}
	return { ws, messages, send, find, list };
}

const computerOf = (connectors: ConnectorInfo[]) => connectors.find((c) => c.id === "computer");
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function restarted(d: DotDaemon, pid: number | undefined) {
	await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
}

describe("computer control registration (S24.7)", () => {
	it("registering on an install with no saved connectors is not reported as a blocked change", async () => {
		const { send, logs, messages, servers, dataDir } = await setup();
		send({ type: "computer_register", url: HELPER, token: KEY });
		await waitFor(() => servers().computer);
		// Longer than the one-second backup check, so a late revert would show.
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(logs.filter((line) => line.includes("put back"))).toEqual([]);
		expect(messages.filter((m) => m.type === "toast")).toEqual([]);
		expect(existsSync(join(dataDir, "connectors.json"))).toBe(false);
	});

	it("renders the helper as a built-in direct server with the key in its header, and the key goes nowhere else", async () => {
		const {
			d,
			dataDir,
			logs,
			mcpFile,
			servers,
			agentEnv,
			policy,
			send,
			find,
			messages,
			connect: other,
		} = await setup();
		const second = await other();
		const pid = d.supervisor.pid;
		expect(policy().builtin).toBeUndefined();

		send({ type: "computer_register", url: HELPER, token: KEY });
		const listed = await second.find("connectors", (m) => computerOf(m.connectors) !== undefined);
		expect(computerOf(listed.connectors)).toEqual({
			id: "computer",
			name: "Computer",
			reads: expect.any(String),
			sends: expect.any(String),
			added: true,
			enabled: true,
			mode: "read_write",
			status: "connected",
			noSignIn: true,
			builtin: true,
		});
		// Direct exposure, nothing hidden, and the key only in the header the engine sends.
		// The timeout leaves the user five minutes to answer the helper's native dialogs.
		expect(servers().computer).toEqual({
			url: HELPER,
			headers: { Authorization: `Bearer ${KEY}` },
			exposure: "direct",
			timeout: 300,
		});
		expect(statSync(mcpFile).mode & 0o777).toBe(0o600);
		// The engine restarts to read it, and its guard lets the computer's tools run without cards.
		await restarted(d, pid);
		await waitFor(() => policy().builtin?.includes("computer"));
		expect(policy().builtin).toEqual(["computer"]);

		await find("connectors", (m) => computerOf(m.connectors) !== undefined);
		expect(computerOf(await second.list())).toBeDefined();
		// With no saved connector the record is never written; when it is, it never holds the helper.
		const recordFile = join(dataDir, "connectors.json");
		const record = existsSync(recordFile) ? readFileSync(recordFile, "utf8") : "";
		expect(record).not.toContain("computer");
		for (const text of [
			JSON.stringify(messages),
			JSON.stringify(second.messages),
			logs.join("\n"),
			agentEnv(),
			record,
		]) {
			expect(text).not.toContain(KEY);
			expect(text).not.toContain("51234");
		}
	});

	it("removes it on computer_unregister, which only the app can send (L61)", async () => {
		const { d, servers, send, list, connect: other } = await setup();
		const second = await other();
		send({ type: "computer_register", url: HELPER, token: KEY });
		await waitFor(() => servers().computer);
		const pid = d.supervisor.pid;

		// A window with the access key (the agent could be one) cannot remove or repoint it.
		second.ws.send(JSON.stringify({ type: "computer_unregister" }));
		second.ws.send(JSON.stringify({ type: "computer_register", url: "http://127.0.0.1:9/mcp", token: KEY }));
		await second.find("error", (m) => m.code === "app_required");
		await settle();
		expect(servers().computer).toMatchObject({ url: HELPER });

		send({ type: "computer_unregister" });
		await waitFor(() => !servers().computer);
		expect(computerOf(await list())).toBeUndefined();
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
	});

	it("stays while windows come and go, and goes away when the app does", async () => {
		const { d, servers, send, ws, app, connect: other } = await setup();
		const second = await other();
		send({ type: "computer_register", url: HELPER, token: KEY });
		await waitFor(() => servers().computer);

		ws.close();
		await settle();
		expect(servers().computer).toBeDefined();
		expect(computerOf(await second.list())).toBeDefined();

		// The app quitting also stops the daemon it launched (S35.2); the helper is gone from the files.
		app.close();
		await d.closed;
		expect(servers().computer).toBeUndefined();
	});

	it("cannot be changed or removed through the connector messages, and a saved connector with its name is renamed", async () => {
		const { d, servers, send, messages, list } = await setup({
			saved: {
				version: 1,
				connectors: {
					computer: {
						enabled: true,
						mode: "read_write",
						custom: { name: "Computer", origin: "x", server: { url: "http://127.0.0.1:9/mcp" }, fields: [] },
					},
				},
			},
		});
		expect(computerOf(await list())).toBeUndefined();
		expect(servers().computer).toBeUndefined();
		expect((await list()).find((c) => c.id === "computer-2")).toMatchObject({
			name: "Computer",
			enabled: true,
		});
		// The engine reaches it through the proxy; its real address stays in the daemon.
		expect(servers()["computer-2"]).toMatchObject({ url: `http://127.0.0.1:${d.port}/mcp/computer-2` });

		send({ type: "computer_register", url: HELPER, token: KEY });
		await waitFor(() => servers().computer);
		const before = JSON.stringify(servers().computer);
		const commands = [
			{ type: "connector_connect" },
			{ type: "connector_signin" },
			{ type: "connector_setup" },
			{ type: "connector_disconnect" },
			{ type: "connector_mode", mode: "read_only" },
			{ type: "connector_remove" },
		];
		const seen = messages.length;
		for (const command of commands) send({ ...command, connectorId: "computer" });
		const refusals = await waitFor(() => {
			const errors = messages.slice(seen).filter((m) => m.type === "error");
			return errors.length >= commands.length && errors;
		});
		expect(refusals.map((m) => m.type === "error" && m.code)).toEqual(
			commands.map(() => "unknown_connector"),
		);
		await settle();
		expect(messages.slice(seen).some((m) => m.type === "auth_prompt" || m.type === "auth_event")).toBe(false);
		expect(JSON.stringify(servers().computer)).toBe(before);
		expect(computerOf(await list())).toMatchObject({ builtin: true, enabled: true, mode: "read_write" });
	});

	it("never appears in the import scan, and an imported server never gets its name", async () => {
		const { servers, send, find } = await setup({
			importFiles: {
				"Library/Application Support/Claude/claude_desktop_config.json": {
					mcpServers: {
						helper: { url: HELPER, headers: { Authorization: `Bearer ${KEY}` } },
						computer: { command: "npx", args: ["-y", "computer-mcp@1.0.0"] },
					},
				},
			},
		});
		send({ type: "computer_register", url: HELPER, token: KEY });
		await waitFor(() => servers().computer);

		send({ type: "connectors_scan" });
		const { found } = await find("connector_imports");
		expect(found.map((c) => c.name)).toEqual(["computer"]);
		expect(JSON.stringify(found)).not.toContain("51234");

		send({ type: "connector_import", ids: found.map((c) => c.id) });
		expect((await find("connector_imported")).names).toEqual(["computer-2"]);
		await waitFor(() => servers()["computer-2"]);
		expect(servers().computer).toEqual({
			url: HELPER,
			headers: { Authorization: `Bearer ${KEY}` },
			exposure: "direct",
			timeout: 300,
		});
	});

	it("says when the current model cannot see images", async () => {
		const { d, send, list } = await setup();
		const pid = d.supervisor.pid;
		send({ type: "computer_register", url: HELPER, token: KEY });
		await restarted(d, pid);
		// The fake engine's default model accepts images.
		expect(computerOf(await list((c) => computerOf(c) !== undefined))?.noImages).toBeUndefined();
		await d.supervisor.request({ type: "set_model", provider: "fake", modelId: "fake-fast" });
		expect(computerOf(await list())?.noImages).toBe(true);
		await d.supervisor.request({ type: "set_model", provider: "fake", modelId: "fake-model" });
		expect(computerOf(await list())?.noImages).toBeUndefined();
	});
});

describe("connectors next to the computer (regression)", () => {
	it("connects, changes, and removes a connector while the helper is registered, and puts back a tampered mcp.json", async () => {
		const { d, mcpFile, servers, send, find, list, policy } = await setup({ browser: "auto" });
		send({ type: "computer_register", url: HELPER, token: KEY });
		await waitFor(() => servers().computer);

		send({ type: "connector_connect", connectorId: "notion" });
		expect(await find("auth_done")).toMatchObject({ ok: true, providerId: "notion" });
		const connected = await list((c) => c.find((x) => x.id === "notion")?.status === "connected");
		expect(connected.map((c) => [c.id, c.status])).toEqual([
			["notion", "connected"],
			["linear", "off"],
			["atlassian", "off"],
			["discord", "off"],
			["slack", "off"],
			["gmail", "off"],
			["computer", "connected"],
		]);
		expect(Object.keys(servers())).toEqual(["notion", "computer"]);
		expect(servers().notion).toMatchObject({
			url: `http://127.0.0.1:${d.port}/mcp/notion`,
			exposure: "direct",
		});

		send({ type: "connector_mode", connectorId: "notion", mode: "read_write" });
		await waitFor(() => d.supervisor.state === "ready" && policy().connectors?.notion?.mode === "read_write");

		writeFileSync(mcpFile, '{"mcpServers":{}}\n');
		await waitFor(() => servers().computer && servers().notion);

		send({ type: "connector_remove", connectorId: "notion" });
		await waitFor(() => !servers().notion);
		expect(Object.keys(servers())).toEqual(["computer"]);
	});
});
