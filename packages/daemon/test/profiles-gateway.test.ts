import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { HIDDEN_NAMES } from "../src/white-label.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function setup() {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const shellHome = join(tempDir(), "shell-gentle-ai");
	const commandsFile = join(dataDir, "commands.jsonl");
	mkdirSync(join(agentHome, "agents"), { recursive: true });
	writeFileSync(
		join(agentHome, "agents", "gentle-ai-worker.md"),
		"---\nname: gentle-ai-worker\n---\nWorker\n",
	);
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: dataDir,
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: { ...process.env, FAKE_AGENT_COMMANDS_FILE: commandsFile },
		agentHome,
		profilesImportPath: join(shellHome, "profiles.json"),
		backoffMs: [50],
		authRuntime: async () => fakeAuthRuntime().runtime,
	});
	daemons.push(d);
	const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const commands = () =>
		existsSync(commandsFile)
			? readFileSync(commandsFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	return {
		d,
		json,
		commands,
		shellHome,
		profilesPath: join(dataDir, "gentle-ai", "profiles.json"),
		modelsPath: join(dataDir, "gentle-ai", "models.json"),
		subagentsPath: join(agentHome, "subagents.json"),
		settingsPath: join(agentHome, "settings.json"),
		agentFile: join(agentHome, "agents", "gentle-ai-worker.md"),
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
	/** Waits for a matching message; `after` skips messages received before that index. */
	function find<T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
		after = 0,
	) {
		return waitFor(() =>
			messages
				.slice(after)
				.find(
					(m): m is Extract<ServerMessage, { type: T }> =>
						m.type === type && where(m as Extract<ServerMessage, { type: T }>),
				),
		);
	}
	return { ws, messages, send, find };
}

describe("profiles over the gateway", () => {
	it("lists profiles with plain role names and models stripped of endpoints and headers", async () => {
		const { d } = await setup();
		const client = await connect(d);
		client.send({ type: "profiles_list" });
		const list = await client.find("profiles");
		expect(list).toMatchObject({ profiles: [], importable: false });
		expect(list.active).toBeUndefined();
		expect(list.open).toBeUndefined();
		expect(list.roles).toEqual([
			{ id: "orchestrator", label: "Main assistant" },
			{ id: "gentle-ai-worker", label: "Builder" },
			{ id: "review-refuter", label: "Reviewer: challenger" },
			{ id: "review-validator", label: "Reviewer: validator" },
		]);
		expect(list.models).toEqual([
			{ provider: "fake", id: "fake-model", name: "Fake Model", reasoning: true },
			{ provider: "fake", id: "fake-fast", name: "Fake Fast", reasoning: false },
			{ provider: "other", id: "big", name: "Other Big", reasoning: true },
		]);
		const raw = JSON.stringify(client.messages);
		expect(raw).not.toContain("fake-secret-header");
		expect(raw).not.toContain("internal.fake.example");
		expect(raw).not.toContain("cost");
		for (const role of list.roles) for (const name of HIDDEN_NAMES) expect(role.label).not.toMatch(name);
	});

	it("opens the profiles screen when the user types /profiles", async () => {
		const { d } = await setup();
		const client = await connect(d);
		client.send({ type: "send", text: " /profiles " });
		const list = await client.find("profiles");
		expect(list.open).toBe(true);
		expect(client.messages.some((m) => m.type === "user_message")).toBe(false);
	});

	it("creates and applies a profile: files written, every window refreshed, and the running model switched", async () => {
		const { d, json, commands, profilesPath, modelsPath, subagentsPath, settingsPath, agentFile } =
			await setup();
		const a = await connect(d);
		const b = await connect(d);
		const roles = {
			orchestrator: { model: "fake/fake-fast", thinking: "low" },
			"gentle-ai-worker": { model: "other/big", thinking: "high" },
		};
		a.send({ type: "profile_save", name: "quick", roles });
		const saved = await b.find("profiles", (m) => m.profiles.length === 1);
		expect(saved.profiles).toEqual([{ name: "quick", roles }]);
		expect(saved.active).toBeUndefined();
		expect(commands()).toEqual([]);

		a.send({ type: "profile_apply", name: "quick" });
		const applied = await b.find("profiles", (m) => m.active === "quick");
		expect(applied.profiles).toEqual([{ name: "quick", roles }]);
		expect(json(profilesPath).active).toBe("quick");
		expect(json(modelsPath)).toEqual(roles);
		expect(json(subagentsPath)).toEqual({
			model_profiles: { "gentle-ai-worker": { model: "other/big", effort: "high" } },
		});
		expect(json(settingsPath)).toEqual({
			defaultProvider: "fake",
			defaultModel: "fake-fast",
			defaultThinkingLevel: "low",
		});
		expect(readFileSync(agentFile, "utf8")).toBe(
			"---\nname: gentle-ai-worker\nmodel: other/big\nthinking: high\n---\nWorker\n",
		);
		expect(commands()).toEqual([
			{ type: "set_model", provider: "fake", modelId: "fake-fast", busy: false },
			{ type: "set_thinking_level", level: "low", busy: false },
		]);
		expect(a.messages.some((m) => m.type === "error")).toBe(false);
	});

	it("waits for the running answer to finish before switching the model", async () => {
		const { d, json, commands, settingsPath } = await setup();
		const client = await connect(d);
		client.send({ type: "profile_save", name: "main", roles: { orchestrator: { model: "other/big" } } });
		await client.find("profiles", (m) => m.profiles.length === 1);
		client.send({ type: "send", text: "hang" });
		await client.find("agent_state", (m) => m.state === "thinking");
		client.send({ type: "profile_apply", name: "main" });
		await client.find("profiles", (m) => m.active === "main");
		expect(json(settingsPath)).toEqual({ defaultProvider: "other", defaultModel: "big" });
		expect(commands()).toEqual([]);
		client.send({ type: "abort" });
		await waitFor(() => commands().length === 1);
		expect(commands()).toEqual([{ type: "set_model", provider: "other", modelId: "big", busy: false }]);
	});

	it("re-applies the profile in use when it is edited", async () => {
		const { d, json, commands, settingsPath } = await setup();
		const client = await connect(d);
		client.send({ type: "profile_save", name: "main", roles: { orchestrator: { model: "fake/fake-fast" } } });
		await client.find("profiles", (m) => m.profiles.length === 1);
		client.send({ type: "profile_apply", name: "main" });
		await client.find("profiles", (m) => m.active === "main");
		client.send({
			type: "profile_save",
			name: "main",
			roles: { orchestrator: { model: "other/big", thinking: "xhigh" } },
		});
		await client.find("profiles", (m) => m.profiles[0]?.roles.orchestrator?.model === "other/big");
		expect(json(settingsPath)).toMatchObject({ defaultModel: "big", defaultThinkingLevel: "xhigh" });
		expect(commands().map((c) => [c.type, c.modelId ?? c.level])).toEqual([
			["set_model", "fake-fast"],
			["set_model", "big"],
			["set_thinking_level", "xhigh"],
		]);
	});

	it("warns when the running conversation cannot use the profile's model", async () => {
		const { d, json, settingsPath } = await setup();
		const client = await connect(d);
		client.send({ type: "profile_save", name: "ghost", roles: { orchestrator: { model: "ghost/none" } } });
		await client.find("profiles", (m) => m.profiles.length === 1);
		client.send({ type: "profile_apply", name: "ghost" });
		const toast = await client.find("toast");
		expect(toast).toMatchObject({
			level: "warning",
			message:
				"Profile applied. The main assistant keeps its current model until that model's account is connected.",
		});
		expect(json(settingsPath)).toEqual({ defaultProvider: "ghost", defaultModel: "none" });
	});

	it("renames, duplicates, and deletes, with plain-language errors", async () => {
		const { d, json, profilesPath } = await setup();
		const client = await connect(d);
		client.send({ type: "profile_save", name: "a", roles: {} });
		await client.find("profiles", (m) => m.profiles.length === 1);
		client.send({ type: "profile_duplicate", from: "a", to: "b" });
		await client.find("profiles", (m) => m.profiles.length === 2);
		client.send({ type: "profile_rename", from: "b", to: "c" });
		await client.find("profiles", (m) => m.profiles.map((p) => p.name).join() === "a,c");
		client.send({ type: "profile_apply", name: "a" });
		await client.find("profiles", (m) => m.active === "a");
		client.send({ type: "profile_delete", name: "a" });
		const error = await client.find("error");
		expect(error).toEqual({
			type: "error",
			code: "active_profile",
			message: "That profile is in use. Switch to another one before deleting it.",
			seq: error.seq,
		});
		const before = client.messages.length;
		client.send({ type: "profile_delete", name: "c" });
		await client.find("profiles", (m) => m.profiles.length === 1, before);
		expect(Object.keys(json(profilesPath).profiles as object)).toEqual(["a"]);
		client.send({ type: "profile_rename", from: "missing", to: "x" });
		expect((await client.find("error", (m) => m.code !== "active_profile")).code).toBe("missing_profile");
	});

	it("saves the current setup with the running model and thinking level", async () => {
		const { d, json, profilesPath, subagentsPath } = await setup();
		writeFileSync(
			subagentsPath,
			JSON.stringify({ model_profiles: { "gentle-ai-worker": { model: "other/big" } } }),
		);
		const client = await connect(d);
		client.send({ type: "profile_save_current", name: "now" });
		const list = await client.find("profiles", (m) => m.profiles.length === 1);
		const roles = {
			orchestrator: { model: "fake/fake-model", thinking: "medium" },
			"gentle-ai-worker": { model: "other/big" },
		};
		expect(list.profiles).toEqual([{ name: "now", roles }]);
		expect((json(profilesPath).profiles as Record<string, unknown>).now).toEqual(roles);
	});

	it("imports another setup's profiles once, reporting renames and accounts to connect", async () => {
		const { d, json, shellHome, profilesPath } = await setup();
		mkdirSync(shellHome, { recursive: true });
		const source = `${JSON.stringify(
			{
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				profiles: {
					quick: { orchestrator: { model: "anthropic/claude-sonnet-4" } },
					local: { "gentle-ai-worker": { model: "fake/fake-fast" } },
				},
				active: "quick",
			},
			null,
			2,
		)}\n`;
		writeFileSync(join(shellHome, "profiles.json"), source);
		const client = await connect(d);
		client.send({ type: "profile_save", name: "quick", roles: {} });
		const listed = await client.find("profiles", (m) => m.profiles.length === 1);
		expect(listed.importable).toBe(true);

		client.send({ type: "profile_import" });
		const result = await client.find("profiles_imported");
		expect(result).toMatchObject({
			imported: [
				{ from: "quick", to: "quick-imported" },
				{ from: "local", to: "local" },
			],
			missingProviders: ["Anthropic", "fake"],
		});
		const list = await client.find("profiles", (m) => m.profiles.length === 3);
		expect(list.active).toBeUndefined();
		expect(Object.keys(json(profilesPath).profiles as object).sort()).toEqual([
			"local",
			"quick",
			"quick-imported",
		]);
		expect(readFileSync(join(shellHome, "profiles.json"), "utf8")).toBe(source);
	});
});
