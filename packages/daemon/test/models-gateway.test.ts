import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { ServerMessage, UploadedFile } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

const lines = (file: string) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];

async function setup() {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const commandsFile = join(dataDir, "commands.jsonl");
	const promptsFile = join(dataDir, "prompts.jsonl");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: {
			...process.env,
			FAKE_AGENT_COMMANDS_FILE: commandsFile,
			FAKE_AGENT_PROMPTS_FILE: promptsFile,
		},
		agentHome,
		profilesImportPath: join(tempDir(), "profiles.json"),
		backoffMs: [50],
		authRuntime: async () => fakeAuthRuntime().runtime,
	});
	daemons.push(d);
	const upload = (name: string, body: Buffer) =>
		new Promise<UploadedFile>((resolve, reject) => {
			const req = request(
				{
					host: "127.0.0.1",
					port: d.port,
					path: "/upload",
					method: "POST",
					headers: { Authorization: `Bearer ${d.token}`, "X-File-Name": encodeURIComponent(name) },
				},
				(res) => {
					let text = "";
					res.on("data", (chunk) => {
						text += chunk;
					});
					res.on("end", () =>
						res.statusCode === 200 ? resolve(JSON.parse(text) as UploadedFile) : reject(new Error(text)),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	return {
		d,
		upload,
		commands: () => lines(commandsFile),
		prompts: () => lines(promptsFile),
		settings: () =>
			JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8")) as Record<string, unknown>,
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
	return { messages, send, find };
}

describe("the in-chat model picker (S32)", () => {
	it("lists the current model and thinking, the models by account, and profiles as quick picks, without secrets", async () => {
		const { d } = await setup();
		const client = await connect(d);
		client.send({
			type: "profile_save",
			name: "quick",
			roles: { orchestrator: { model: "fake/fake-fast" }, "gentle-ai-worker": { model: "other/big" } },
		});
		await client.find("profiles", (m) => m.profiles.length === 1);
		client.send({ type: "models_list" });
		const list = await client.find("models");
		expect(list.current).toEqual({
			provider: "fake",
			id: "fake-model",
			name: "Fake Model",
			thinking: "medium",
		});
		expect(list.next).toBeUndefined();
		const levels = ["off", "minimal", "low", "medium", "high"];
		expect(list.groups).toEqual([
			{
				provider: "fake",
				name: "fake",
				models: [
					{ provider: "fake", id: "fake-model", name: "Fake Model", images: true, thinkingLevels: levels },
					{ provider: "fake", id: "fake-fast", name: "Fake Fast", images: false },
				],
			},
			{
				provider: "other",
				name: "other",
				models: [{ provider: "other", id: "big", name: "Other Big", images: false, thinkingLevels: levels }],
			},
		]);
		expect(list.profiles).toEqual([{ name: "quick", model: "fake/fake-fast" }]);
		const raw = JSON.stringify(client.messages);
		for (const secret of ["fake-secret-header", "internal.fake.example", "baseUrl", "headers", "cost"])
			expect(raw).not.toContain(secret);
	});

	it("switches the running model and thinking live, tells every window, and keeps the choice", async () => {
		const { d, commands, settings } = await setup();
		const a = await connect(d);
		const b = await connect(d);
		a.send({ type: "model_set", provider: "other", id: "big", thinking: "high" });
		const switched = await b.find("models", (m) => m.current?.id === "big");
		expect(switched.current).toEqual({ provider: "other", id: "big", name: "Other Big", thinking: "high" });
		expect(commands()).toEqual([
			{ type: "set_model", provider: "other", modelId: "big", busy: false },
			{ type: "set_thinking_level", level: "high", busy: false },
		]);
		expect(settings()).toEqual({
			defaultProvider: "other",
			defaultModel: "big",
			defaultThinkingLevel: "high",
		});
		// A window that connects now shows the chosen model.
		const c = await connect(d);
		expect(c.messages.find((m) => m.type === "ready")).toMatchObject({ model: "Other Big" });
		expect(a.messages.some((m) => m.type === "error")).toBe(false);
	});

	it("changes only the model when no thinking level is given, keeping the saved thinking default", async () => {
		const { d, commands, settings } = await setup();
		const client = await connect(d);
		client.send({ type: "model_set", provider: "fake", id: "fake-model", thinking: "low" });
		await client.find("models", (m) => m.current?.thinking === "low");
		client.send({ type: "model_set", provider: "fake", id: "fake-fast" });
		await client.find("models", (m) => m.current?.id === "fake-fast");
		expect(commands().slice(2)).toEqual([
			{ type: "set_model", provider: "fake", modelId: "fake-fast", busy: false },
		]);
		expect(settings()).toEqual({
			defaultProvider: "fake",
			defaultModel: "fake-fast",
			defaultThinkingLevel: "low",
		});
	});

	it("applies a switch made during a reply to the next message, without stopping the reply", async () => {
		const { d, commands } = await setup();
		const client = await connect(d);
		client.send({ type: "send", text: "hang" });
		await client.find("agent_state", (m) => m.state === "thinking");
		client.send({ type: "model_set", provider: "other", id: "big" });
		const waiting = await client.find("models", (m) => m.next !== undefined);
		expect(waiting.current?.id).toBe("fake-model");
		expect(waiting.next).toEqual({ provider: "other", id: "big", name: "Other Big" });
		expect(commands()).toEqual([]);
		expect(client.messages.some((m) => m.type === "message_done")).toBe(false);
		client.send({ type: "abort" });
		const after = await client.find("models", (m) => m.current?.id === "big" && m.next === undefined);
		expect(after.current?.name).toBe("Other Big");
		expect(commands()).toEqual([{ type: "set_model", provider: "other", modelId: "big", busy: false }]);
	});

	it("refuses a model that is not available or a thinking level it does not support, inline and unchanged", async () => {
		const { d, commands } = await setup();
		const client = await connect(d);
		client.send({ type: "model_set", provider: "ghost", id: "none" });
		const missing = await client.find("error", (m) => m.code === "model_unavailable");
		expect(missing.message).toBe("That model is not available. Connect its account in Accounts first.");
		client.send({ type: "model_set", provider: "fake", id: "fake-model", thinking: "max" });
		const thinking = await client.find("error", (m) => m.code === "thinking_unavailable");
		expect(thinking.message).toBe("That model does not support that thinking level.");
		client.send({ type: "model_set", provider: "fake", id: "fake-fast", thinking: "high" });
		await client.find("error", (m) => m.code === "thinking_unavailable" && m !== thinking);
		expect(commands()).toEqual([]);
		expect(client.messages.some((m) => m.type === "models" && m.current?.id !== "fake-model")).toBe(false);
	});

	it("sends images only when the chosen model accepts them", async () => {
		const { d, upload, prompts } = await setup();
		const client = await connect(d);
		client.send({ type: "model_set", provider: "fake", id: "fake-fast" });
		await client.find("models", (m) => m.current?.id === "fake-fast");
		const shot = await upload("shot.png", PNG);
		client.send({ type: "send", text: "look", attachments: [{ uploadId: shot.uploadId, name: shot.name }] });
		await client.find("message_done");
		const [prompt] = prompts();
		expect(prompt?.images).toBeUndefined();
		expect(String(prompt?.message)).toContain("shot.png");
	});

	it("still applies a profile exactly as before (regression)", async () => {
		const { d, commands, settings } = await setup();
		const client = await connect(d);
		const roles = { orchestrator: { model: "fake/fake-fast", thinking: "low" } };
		client.send({ type: "profile_save", name: "quick", roles });
		await client.find("profiles", (m) => m.profiles.length === 1);
		client.send({ type: "profile_apply", name: "quick" });
		await client.find("profiles", (m) => m.active === "quick");
		await waitFor(() => commands().length === 2);
		expect(commands()).toEqual([
			{ type: "set_model", provider: "fake", modelId: "fake-fast", busy: false },
			{ type: "set_thinking_level", level: "low", busy: false },
		]);
		expect(settings()).toEqual({
			defaultProvider: "fake",
			defaultModel: "fake-fast",
			defaultThinkingLevel: "low",
		});
		// The picker follows the profile.
		const picked = await client.find("models", (m) => m.current?.id === "fake-fast");
		expect(picked.activeProfile).toBe("quick");
	});
});
