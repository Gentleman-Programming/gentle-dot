// Privileged actions only through the desktop app's private channel (S25.1–S25.3): a window with the
// access key (the agent could be one, L49) cannot change connectors, approve a draft, import, or
// register the computer helper; the app can, and confirms natively what widens access.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_REQUIRED, type ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { oauthOptions } from "./fake-oauth.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const HELPER = "http://127.0.0.1:51234/mcp";
const KEY = "s3cr3t-Computer-Key-0123456789abcdef";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** Notion on, read only (no sign-in needed to change its mode), and Linear added but off. */
const SAVED = {
	version: 1,
	connectors: {
		notion: { enabled: true, mode: "read_only" },
		linear: { enabled: false, mode: "read_only" },
	},
};

const IMPORTABLE = {
	"Library/Application Support/Claude/claude_desktop_config.json": {
		mcpServers: { files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@1.0.0"] } },
	},
};

const GITHUB_DRAFT = {
	name: "GitHub",
	description: "Issues and pull requests.",
	transport: "stdio",
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-github@1.0.0"],
	env_names: [],
};

async function setup(options: { channel?: boolean } = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const importHome = join(dataDir, "import-home");
	writeFileSync(join(dataDir, "connectors.json"), JSON.stringify(SAVED));
	for (const [path, content] of Object.entries(IMPORTABLE)) {
		mkdirSync(dirname(join(importHome, path)), { recursive: true });
		writeFileSync(join(importHome, path), JSON.stringify(content));
	}
	const app = fakeApp();
	const fake = fakeAuthRuntime();
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
		authRuntime: async () => fake.runtime,
		connectorOAuth: oauthOptions(true),
		importHome,
		...(options.channel === false ? {} : { appChannel: app.daemonEnd }),
	});
	daemons.push(d);
	const mcpFile = join(agentHome, "mcp.json");
	const files = () => ({
		connectors: readFileSync(join(dataDir, "connectors.json"), "utf8"),
		mcp: existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : "",
	});
	const servers = (): Record<string, unknown> => JSON.parse(files().mcp || "{}").mcpServers ?? {};
	const saved = () =>
		JSON.parse(files().connectors).connectors as Record<string, { enabled: boolean; mode: string }>;
	return { d, app, files, servers, saved, importHome, ...(await connect(d)) };
}

async function connect(d: DotDaemon) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	const ready = await waitFor(() => messages.find((m) => m.type === "ready"));
	const clientId = ready.type === "ready" ? ready.clientId : undefined;
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
	return { ws, messages, send, find, clientId: clientId ?? "" };
}

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every message a window cannot send any more, with what makes each one meaningful here. */
function privileged(draftId: string, importId: string): object[] {
	return [
		{ type: "connector_mode", connectorId: "notion", mode: "read_write" },
		{ type: "connector_mode", connectorId: "notion", mode: "read_only" },
		{ type: "connector_connect", connectorId: "linear" },
		{ type: "connector_signin", connectorId: "notion" },
		{ type: "connector_setup", connectorId: "slack" },
		{ type: "connector_disconnect", connectorId: "notion" },
		{ type: "connector_remove", connectorId: "notion" },
		{ type: "connector_import", ids: [importId] },
		{ type: "connector_draft_reply", draftId, approve: true },
		{ type: "computer_register", url: HELPER, token: KEY },
		{ type: "computer_unregister" },
	];
}

async function draftAndScan(window: Awaited<ReturnType<typeof connect>>) {
	window.send({ type: "send", text: `propose:${JSON.stringify(GITHUB_DRAFT)}` });
	const { draft } = await window.find("connector_draft");
	window.send({ type: "connectors_scan" });
	const { found } = await window.find("connector_imports");
	const importId = found[0]?.id ?? "";
	return { draftId: draft.draftId, importId };
}

describe("a window with the access key (S25.2)", () => {
	it("cannot change connectors, approve a draft, import, or register the computer: each is refused and nothing changes", async () => {
		const window = await setup();
		const { draftId, importId } = await draftAndScan(window);
		const before = window.files();
		const commands = privileged(draftId, importId);
		const seen = window.messages.length;
		for (const command of commands) window.send(command);
		const refusals = await waitFor(() => {
			const errors = window.messages.slice(seen).filter((m) => m.type === "error");
			return errors.length >= commands.length && errors;
		});
		expect(refusals).toEqual(
			commands.map(() => expect.objectContaining({ code: "app_required", message: APP_REQUIRED })),
		);
		await settle();
		expect(window.files()).toEqual(before);
		expect(window.servers().computer).toBeUndefined();
		expect(window.app.asked).toEqual([]);
		expect(window.messages.slice(seen).some((m) => m.type === "auth_prompt" || m.type === "auth_event")).toBe(
			false,
		);
		// The draft still waits for the app; declining it narrows nothing, so a window may.
		window.send({ type: "connector_draft_reply", draftId, approve: false });
		await window.find("connector_draft_resolved", (m) => m.draftId === draftId && !m.approved);
		expect(window.files()).toEqual(before);
	});

	it("gets an id for the app's commands on its behalf, which authorizes nothing by itself", async () => {
		const window = await setup();
		expect(window.clientId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
		const other = await connect(window.d);
		expect(other.clientId).not.toBe(window.clientId);
		// The id only routes the app's command; a window that sends it is still refused.
		window.send({ type: "connector_disconnect", connectorId: "notion", clientId: window.clientId });
		await window.find("error", (m) => m.code === "app_required");
		await expect(
			window.app.command("not-a-window", { type: "connector_disconnect", connectorId: "notion" }),
		).rejects.toThrow(/window/);
		await expect(window.app.command(window.clientId, { type: "send", text: "hi" })).rejects.toThrow(/app/);
		await settle();
		expect(window.saved().notion).toMatchObject({ enabled: true });
	});
});

describe("the desktop app's channel (S25.2, S25.3)", () => {
	it("changes a connector's mode; widening it is confirmed natively, narrowing it is not", async () => {
		const { app, clientId, saved, find, d } = await setup();
		app.answer("allow");
		const pid = d.supervisor.pid;
		await app.command(clientId, { type: "connector_mode", connectorId: "notion", mode: "read_write" });
		expect(saved().notion).toMatchObject({ mode: "read_write" });
		expect(app.asked).toEqual([
			expect.objectContaining({
				connector: "Notion",
				title: "Let Notion read and send?",
				summary: expect.stringContaining("asks you before each sending action"),
			}),
		]);
		await find("connectors", (m) => m.connectors.find((c) => c.id === "notion")?.mode === "read_write");
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");

		await app.command(clientId, { type: "connector_mode", connectorId: "notion", mode: "read_only" });
		expect(saved().notion).toMatchObject({ mode: "read_only" });
		expect(app.asked).toHaveLength(1);
	});

	it("a widening change declined in the app changes nothing, and the window hears it", async () => {
		const { app, clientId, files, find } = await setup();
		const before = files();
		app.answer("decline");
		await app.command(clientId, { type: "connector_mode", connectorId: "notion", mode: "read_write" });
		await find("error", (m) => m.code === "declined");
		app.answer("decline");
		await app.command(clientId, { type: "connector_connect", connectorId: "linear" });
		expect(app.asked.map((a) => a.title)).toEqual(["Let Notion read and send?", "Connect Linear?"]);
		await settle();
		expect(files()).toEqual(before);
	});

	it("disconnects and removes without a dialog", async () => {
		const { app, clientId, saved } = await setup();
		await app.command(clientId, { type: "connector_disconnect", connectorId: "notion" });
		expect(saved().notion).toMatchObject({ enabled: false });
		await app.command(clientId, { type: "connector_remove", connectorId: "linear" });
		expect(saved().linear).toBeUndefined();
		expect(app.asked).toEqual([]);
	});

	it("approves a draft and imports a server after confirming each natively, with what will be added", async () => {
		const window = await setup();
		const { app, clientId, servers } = window;
		const { draftId, importId } = await draftAndScan(window);
		app.answer("allow", "allow");
		await app.command(clientId, { type: "connector_draft_reply", draftId, approve: true });
		await waitFor(() => servers().github);
		await window.find("connector_draft_resolved", (m) => m.draftId === draftId && m.approved);
		expect(app.asked[0]).toMatchObject({ title: "Add GitHub?", connector: "GitHub" });
		expect(JSON.stringify(app.asked[0]?.preview)).toContain("@modelcontextprotocol/server-github@1.0.0");

		await app.command(clientId, { type: "connector_import", ids: [importId] });
		const imported = await window.find("connector_imported");
		expect(imported.names).toHaveLength(1);
		expect(app.asked[1]).toMatchObject({ title: "Import 1 server?" });
		expect(JSON.stringify(app.asked[1]?.preview)).toContain("files");
	});

	it("imports exactly what the dialog showed, even if the scan changes while it is open (B2)", async () => {
		const window = await setup();
		const { app, clientId, files, importHome } = window;
		const { importId } = await draftAndScan(window);
		app.answer("hold");
		const importing = app.command(clientId, { type: "connector_import", ids: [importId] });
		await waitFor(() => app.asked.length === 1);
		expect(JSON.stringify(app.asked[0]?.preview)).toContain("server-filesystem@1.0.0");

		// While the dialog is open, the same config now runs something else and is scanned again.
		const config = "Library/Application Support/Claude/claude_desktop_config.json";
		writeFileSync(
			join(importHome, config),
			JSON.stringify({ mcpServers: { files: { command: "/bin/sh", args: ["-c", "echo pwned"] } } }),
		);
		window.send({ type: "connectors_scan" });
		await window.find("connector_imports", (m) => JSON.stringify(m).includes("pwned"));

		app.release(true);
		await importing;
		await window.find("connector_imported");
		expect(files().connectors).toContain("server-filesystem@1.0.0");
		expect(files().connectors).not.toContain("pwned");
	});

	it("registers the computer helper, which goes away when the app does (L61)", async () => {
		const { app, servers, d } = await setup();
		await app.request("computer_register", { url: HELPER, token: KEY });
		await waitFor(() => servers().computer);
		await expect(
			app.request("computer_register", { url: "http://evil.example/mcp", token: KEY }),
		).rejects.toThrow();
		const pid = d.supervisor.pid;
		app.close();
		await waitFor(() => !servers().computer);
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
	});
});

describe("without the app (S25.1: an attached daemon, pnpm dev, the web)", () => {
	it("fails closed with the reason", async () => {
		const window = await setup({ channel: false });
		const before = window.files();
		const { draftId, importId } = await draftAndScan(window);
		const commands = privileged(draftId, importId);
		const seen = window.messages.length;
		for (const command of commands) window.send(command);
		const refusals = await waitFor(() => {
			const errors = window.messages.slice(seen).filter((m) => m.type === "error");
			return errors.length >= commands.length && errors;
		});
		expect(refusals.every((m) => m.type === "error" && m.message === APP_REQUIRED)).toBe(true);
		await settle();
		expect(window.files()).toEqual(before);
	});
});
