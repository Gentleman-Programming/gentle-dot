import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AuthProvider } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import {
	discoverRoles,
	LiveModelSwitch,
	ProfileError,
	ProfileStore,
	parseProfilesFile,
	serializeProfilesFile,
	toModelOptions,
} from "../src/profiles.ts";
import { HIDDEN_NAMES } from "../src/white-label.ts";
import { tempDir } from "./helpers.ts";

function setup() {
	const root = tempDir();
	const configHome = join(root, "gentle-ai");
	const agentHome = join(root, "agent");
	const shellHome = join(root, "shell");
	const store = new ProfileStore({ configHome, agentHome, importPath: join(shellHome, "profiles.json") });
	const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const write = (path: string, value: unknown) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	};
	return {
		store,
		configHome,
		agentHome,
		shellHome,
		json,
		write,
		profilesPath: join(configHome, "profiles.json"),
		modelsPath: join(configHome, "models.json"),
		subagentsPath: join(agentHome, "subagents.json"),
		settingsPath: join(agentHome, "settings.json"),
	};
}

// Bytes as the engine's serializeProfilesFile writes them (lib/agent-profiles.ts).
const ENGINE_FILE = `${JSON.stringify(
	{
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: {
			"deep-work": {
				orchestrator: { model: "anthropic/claude-opus-4", thinking: "high" },
				"gentle-ai-worker": { model: "openai/gpt-5", thinking: "medium" },
				"review-refuter": { thinking: "low" },
			},
			fast: { "gentle-ai-explore": { model: "openai/gpt-5-mini" } },
		},
		active: "deep-work",
	},
	null,
	2,
)}\n`;

describe("profile file format", () => {
	it("round-trips a store written by the engine byte for byte", () => {
		const file = parseProfilesFile(ENGINE_FILE);
		expect(file?.active).toBe("deep-work");
		expect(file?.profiles.fast).toEqual({ "gentle-ai-explore": { model: "openai/gpt-5-mini" } });
		expect(serializeProfilesFile(file ?? { profiles: {} })).toBe(ENGINE_FILE);
	});

	it("normalizes like the engine: string routes, effort alias, invalid names and stale active dropped", () => {
		const file = parseProfilesFile(
			JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				profiles: {
					legacy: { worker: "openai/gpt-5", checker: { effort: "low" }, broken: { model: "bad model" } },
					"bad name": { worker: { thinking: "low" } },
					constructor: {},
				},
				active: "gone",
			}),
		);
		expect(file).toEqual({
			profiles: { legacy: { worker: { model: "openai/gpt-5" }, checker: { thinking: "low" } } },
		});
		expect(parseProfilesFile('{"kind":"other","version":1,"profiles":{}}')).toBeUndefined();
		expect(parseProfilesFile("{nope")).toBeUndefined();
	});
});

describe("profile store", () => {
	it("creates, updates, duplicates, renames, and deletes profiles", async () => {
		const { store, json, profilesPath } = setup();
		expect(store.list()).toEqual({ profiles: [] });
		await store.save("fast", { orchestrator: { model: "fake/fake-fast" } });
		await store.save("fast", { orchestrator: { model: "fake/fake-model", thinking: "low" } });
		await store.duplicate("fast", "copy");
		await store.rename("copy", "deep");
		expect(store.list().profiles.map((p) => p.name)).toEqual(["deep", "fast"]);
		expect(json(profilesPath)).toEqual({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			profiles: {
				fast: { orchestrator: { model: "fake/fake-model", thinking: "low" } },
				deep: { orchestrator: { model: "fake/fake-model", thinking: "low" } },
			},
		});
		await store.remove("deep");
		expect(Object.keys(json(profilesPath).profiles as object)).toEqual(["fast"]);
	});

	it("refuses invalid names, duplicates, missing profiles, and deleting the profile in use", async () => {
		const { store } = setup();
		await store.save("a", {});
		await store.save("b", {});
		await store.apply("a");
		const code = (promise: Promise<unknown>) =>
			promise.then(
				() => "resolved",
				(error: ProfileError) => error.code,
			);
		expect(await code(store.save("bad name", {}))).toBe("invalid_name");
		expect(await code(store.save("constructor", {}))).toBe("invalid_name");
		expect(await code(store.rename("a", "b"))).toBe("duplicate_name");
		expect(await code(store.duplicate("missing", "c"))).toBe("missing_profile");
		expect(await code(store.remove("a"))).toBe("active_profile");
		expect(await code(store.saveCurrent("b"))).toBe("duplicate_name");
		const error = await store.remove("a").catch((e: ProfileError) => e);
		expect((error as ProfileError).message).toBe(
			"That profile is in use. Switch to another one before deleting it.",
		);
	});

	it("moves the in-use marker when the active profile is renamed", async () => {
		const { store } = setup();
		await store.save("a", {});
		await store.apply("a");
		await store.rename("a", "renamed");
		expect(store.list().active).toBe("renamed");
	});

	it("writes the store atomically with mode 0600 and leaves no temp files", async () => {
		const { store, configHome, profilesPath } = setup();
		await store.save("a", { orchestrator: { model: "fake/fake-model" } });
		expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
		expect(readdirSync(configHome)).toEqual(["profiles.json"]);
	});

	it("serializes concurrent writes so none is lost", async () => {
		const { store } = setup();
		await Promise.all(["a", "b", "c", "d", "e"].map((name) => store.save(name, {})));
		expect(store.list().profiles.map((p) => p.name)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("reports an unreadable store instead of replacing it", async () => {
		const { store, configHome, profilesPath } = setup();
		mkdirSync(configHome, { recursive: true });
		writeFileSync(profilesPath, "{broken");
		expect(() => store.list()).toThrow(ProfileError);
		await expect(store.save("a", {})).rejects.toMatchObject({ code: "store_invalid" });
		expect(readFileSync(profilesPath, "utf8")).toBe("{broken");
	});
});

describe("applying a profile", () => {
	it("writes the active marker, models.json, subagents.json, and settings.json, keeping other keys", async () => {
		const { store, json, write, agentHome, profilesPath, modelsPath, subagentsPath, settingsPath } = setup();
		const agentFile = join(agentHome, "agents", "gentle-ai-worker.md");
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		writeFileSync(agentFile, "---\nname: gentle-ai-worker\nmodel: old/model\n---\nBody\n");
		write(subagentsPath, {
			parallel: 3,
			model_profiles: {
				"gentle-ai-explore": { model: "old/explore" },
				"gentle-ai-worker": { effort: "low" },
			},
		});
		write(settingsPath, {
			theme: "dark",
			defaultProvider: "old",
			defaultModel: "m",
			defaultThinkingLevel: "low",
		});
		await store.save("deep", {
			orchestrator: { model: "anthropic/claude-opus-4" },
			"gentle-ai-worker": { model: "openai/gpt-5", thinking: "high" },
			"review-refuter": { model: "openai/gpt-5-mini" },
		});

		const orchestrator = await store.apply("deep");

		expect(orchestrator).toEqual({ model: "anthropic/claude-opus-4" });
		expect(json(profilesPath).active).toBe("deep");
		expect(json(modelsPath)).toEqual({
			orchestrator: { model: "anthropic/claude-opus-4" },
			"gentle-ai-worker": { model: "openai/gpt-5", thinking: "high" },
			"review-refuter": { model: "openai/gpt-5-mini" },
		});
		// Omitted roles are cleared; review roles and the orchestrator never land here.
		expect(json(subagentsPath)).toEqual({
			parallel: 3,
			model_profiles: { "gentle-ai-worker": { model: "openai/gpt-5", effort: "high" } },
		});
		// No thinking level in the profile: the key goes away.
		expect(json(settingsPath)).toEqual({
			theme: "dark",
			defaultProvider: "anthropic",
			defaultModel: "claude-opus-4",
		});
		expect(statSync(modelsPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(agentFile, "utf8")).toBe(
			"---\nname: gentle-ai-worker\nmodel: old/model\n---\nBody\n",
		);
	});

	it("sets the thinking level and drops model_profiles when the profile routes no agent", async () => {
		const { store, json, write, subagentsPath, settingsPath } = setup();
		write(subagentsPath, { model_profiles: { "gentle-ai-explore": { model: "old/explore" } } });
		await store.save("main", { orchestrator: { model: "fake/fake-model", thinking: "max" } });
		expect(await store.apply("main")).toEqual({ model: "fake/fake-model", thinking: "max" });
		expect(json(subagentsPath)).toEqual({});
		expect(json(settingsPath)).toEqual({
			defaultProvider: "fake",
			defaultModel: "fake-model",
			defaultThinkingLevel: "max",
		});
	});

	it("leaves settings.json alone when the profile has no main assistant model", async () => {
		const { store, write, settingsPath } = setup();
		write(settingsPath, { defaultProvider: "keep", defaultModel: "me" });
		const before = readFileSync(settingsPath, "utf8");
		await store.save("agents-only", { "gentle-ai-worker": { thinking: "low" } });
		expect(await store.apply("agents-only")).toBeUndefined();
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
	});

	it("restores every file when a step fails", async () => {
		const { store, profilesPath, modelsPath, subagentsPath, settingsPath } = setup();
		await store.save("a", { "gentle-ai-worker": { model: "x/a" } });
		await store.save("b", { orchestrator: { model: "x/b" }, "gentle-ai-worker": { model: "x/b" } });
		await store.apply("a");
		writeFileSync(settingsPath, "{not json");
		const before = [profilesPath, modelsPath, subagentsPath, settingsPath].map((p) =>
			readFileSync(p, "utf8"),
		);
		await expect(store.apply("b")).rejects.toMatchObject({ code: "settings_invalid" });
		expect(
			[profilesPath, modelsPath, subagentsPath, settingsPath].map((p) => readFileSync(p, "utf8")),
		).toEqual(before);
	});

	it("waits for the engine's settings lock and takes over a stale one", async () => {
		const { store, write, json, settingsPath } = setup();
		write(settingsPath, { theme: "dark" });
		await store.save("main", { orchestrator: { model: "fake/fake-model" } });
		const lock = `${settingsPath}.lock`;
		mkdirSync(lock);
		let done = false;
		const applying = store.apply("main").then(() => {
			done = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(done).toBe(false);
		// Released the way the engine's lock library does it: by removing the directory.
		rmdirSync(lock);
		await applying;
		expect(json(settingsPath).defaultModel).toBe("fake-model");
		expect(existsSync(lock)).toBe(false);

		mkdirSync(lock);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		await store.save("other", { orchestrator: { model: "fake/fake-fast" } });
		await store.apply("other");
		expect(json(settingsPath).defaultModel).toBe("fake-fast");
		expect(existsSync(lock)).toBe(false);
	});
});

describe("saving the current setup", () => {
	it("captures agent routes, review roles, and the main assistant", async () => {
		const { store, write, json, profilesPath, subagentsPath, modelsPath } = setup();
		write(subagentsPath, {
			parallel: 2,
			model_profiles: { "gentle-ai-worker": { model: "openai/gpt-5", effort: "high" }, odd: "skip" },
		});
		write(modelsPath, {
			"review-validator": { model: "openai/gpt-5-mini", thinking: "low" },
			"gentle-ai-worker": { model: "ignored/here" },
		});
		await store.saveCurrent("mine", { model: "fake/fake-model", thinking: "medium" });
		expect((json(profilesPath).profiles as Record<string, unknown>).mine).toEqual({
			orchestrator: { model: "fake/fake-model", thinking: "medium" },
			"gentle-ai-worker": { model: "openai/gpt-5", thinking: "high" },
			"review-validator": { model: "openai/gpt-5-mini", thinking: "low" },
		});
	});
});

describe("importing profiles", () => {
	const providers: AuthProvider[] = [
		{ id: "anthropic", name: "Anthropic", methods: ["oauth"], configured: true },
		{ id: "openai", name: "OpenAI", methods: ["api_key"], configured: false },
	];

	it("offers import only when the other store has at least one profile", () => {
		const { store, shellHome } = setup();
		expect(store.importable()).toBe(false);
		mkdirSync(shellHome, { recursive: true });
		writeFileSync(
			join(shellHome, "profiles.json"),
			'{"kind":"gentle-pi.agent_model_profiles","version":1,"profiles":{}}',
		);
		expect(store.importable()).toBe(false);
		writeFileSync(join(shellHome, "profiles.json"), ENGINE_FILE);
		expect(store.importable()).toBe(true);
	});

	it("copies profiles once, renames collisions, skips the active marker, and names missing accounts", async () => {
		const { store, shellHome, json, profilesPath } = setup();
		mkdirSync(shellHome, { recursive: true });
		const source = join(shellHome, "profiles.json");
		writeFileSync(source, ENGINE_FILE);
		const sourceStat = statSync(source);
		await store.save("fast", { orchestrator: { model: "fake/fake-model" } });
		await store.save("fast-imported", { orchestrator: { model: "fake/other" } });

		const result = await store.import(providers);

		expect(result).toEqual({
			imported: [
				{ from: "deep-work", to: "deep-work" },
				{ from: "fast", to: "fast-imported-2" },
			],
			missingProviders: ["OpenAI"],
		});
		const saved = json(profilesPath);
		expect(saved.active).toBeUndefined();
		expect((saved.profiles as Record<string, unknown>)["fast-imported-2"]).toEqual({
			"gentle-ai-explore": { model: "openai/gpt-5-mini" },
		});
		expect(readFileSync(source, "utf8")).toBe(ENGINE_FILE);
		expect(statSync(source).mtimeMs).toBe(sourceStat.mtimeMs);

		// A second import finds nothing new.
		expect(await store.import(providers)).toEqual({ imported: [], missingProviders: [] });
	});

	it("reports providers it does not know by id", async () => {
		const { store, shellHome } = setup();
		mkdirSync(shellHome, { recursive: true });
		writeFileSync(
			join(shellHome, "profiles.json"),
			JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				profiles: { local: { orchestrator: { model: "ollama/llama3" } } },
			}),
		);
		expect(await store.import(providers)).toEqual({
			imported: [{ from: "local", to: "local" }],
			missingProviders: ["ollama"],
		});
	});

	it("refuses to import when there is nothing to import", async () => {
		const { store } = setup();
		await expect(store.import(providers)).rejects.toMatchObject({ code: "nothing_to_import" });
	});
});

describe("roles and models", () => {
	it("lists the main assistant, discovered agents, and review roles with plain labels", () => {
		const { agentHome } = setup();
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		mkdirSync(join(agentHome, "subagents"), { recursive: true });
		writeFileSync(join(agentHome, "agents", "gentle-ai-worker.md"), "---\nname: gentle-ai-worker\n---\n");
		writeFileSync(join(agentHome, "agents", "x.md"), '---\nname: "gentle-ai-explore"\n---\n');
		writeFileSync(join(agentHome, "agents", "jd-judge-a.md"), "---\nname: jd-judge-a\n---\n");
		writeFileSync(join(agentHome, "agents", "flow.chain.md"), "---\nname: chain\n---\n");
		writeFileSync(join(agentHome, "subagents", "gentle-ai-helper.md"), "no frontmatter\n");
		writeFileSync(join(agentHome, "subagents", "review-risk.md"), "---\nname: review-risk\n---\n");
		const roles = discoverRoles(agentHome);
		expect(roles).toEqual([
			{ id: "orchestrator", label: "Main assistant" },
			{ id: "gentle-ai-worker", label: "Builder" },
			{ id: "gentle-ai-helper", label: "Helper" },
			{ id: "gentle-ai-explore", label: "Researcher" },
			{ id: "review-refuter", label: "Reviewer: challenger" },
			{ id: "review-risk", label: "Reviewer: risk" },
			{ id: "review-validator", label: "Reviewer: validator" },
			{ id: "jd-judge-a", label: "Second opinion A" },
		]);
		for (const { label } of roles) for (const name of HIDDEN_NAMES) expect(label).not.toMatch(name);
	});

	it("keeps roles a profile routes even when no agent file defines them", () => {
		const { agentHome } = setup();
		expect(discoverRoles(agentHome, ["sdd-apply"]).map((r) => r.id)).toContain("sdd-apply");
	});

	it("forwards only provider, id, name, and reasoning", () => {
		expect(
			toModelOptions({
				models: [
					{
						provider: "fake",
						id: "fake-model",
						name: "Fake Model",
						reasoning: true,
						headers: { Authorization: "Bearer secret" },
						baseUrl: "https://internal.example",
						cost: { input: 1 },
					},
					{ provider: "fake", id: "fake-fast" },
					{ id: "no-provider" },
				],
			}),
		).toEqual([
			{ provider: "fake", id: "fake-model", name: "Fake Model", reasoning: true },
			{ provider: "fake", id: "fake-fast", name: "fake-fast", reasoning: false },
		]);
		expect(toModelOptions(undefined)).toEqual([]);
	});
});

describe("live model switch", () => {
	function agent(busy = false) {
		const sent: Record<string, unknown>[] = [];
		const fake = {
			busy,
			state: "ready",
			async request(command: Record<string, unknown>) {
				sent.push(command);
				if (command.provider === "nobody") throw new Error("No API key for nobody");
				return {};
			},
		};
		return { fake, sent };
	}

	it("switches the running conversation's model and thinking level", async () => {
		const { fake, sent } = agent();
		const live = new LiveModelSwitch(fake);
		expect(await live.switchTo({ model: "anthropic/claude-opus-4", thinking: "high" })).toBe("switched");
		expect(sent).toEqual([
			{ type: "set_model", provider: "anthropic", modelId: "claude-opus-4" },
			{ type: "set_thinking_level", level: "high" },
		]);
	});

	it("only sets the model when the profile has no thinking level", async () => {
		const { fake, sent } = agent();
		await new LiveModelSwitch(fake).switchTo({ model: "fake/a/b" });
		expect(sent).toEqual([{ type: "set_model", provider: "fake", modelId: "a/b" }]);
	});

	it("waits until the assistant is done before switching", async () => {
		const { fake, sent } = agent(true);
		const live = new LiveModelSwitch(fake);
		expect(await live.switchTo({ model: "fake/fake-fast", thinking: "low" })).toBe("deferred");
		expect(sent).toEqual([]);
		fake.busy = false;
		expect(await live.settle()).toBe("switched");
		expect(sent.map((c) => c.type)).toEqual(["set_model", "set_thinking_level"]);
		expect(await live.settle()).toBe("none");
	});

	it("reports a model the assistant cannot use", async () => {
		const { fake } = agent();
		expect(await new LiveModelSwitch(fake).switchTo({ model: "nobody/x" })).toBe("failed");
	});
});
