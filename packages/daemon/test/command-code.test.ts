import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelAuthRuntime } from "../src/auth.ts";
import {
	COMMAND_CODE_ANTHROPIC_BASE_URL,
	COMMAND_CODE_ANTHROPIC_PROVIDER_ID,
	COMMAND_CODE_API_KEY_ENV,
	COMMAND_CODE_BASE_URL,
	COMMAND_CODE_PROVIDER_ID,
	createCommandCodeAnthropicProviderConfig,
	createCommandCodeProviderConfig,
	registerCommandCodeProviders,
} from "../src/extensions/command-code.ts";
import { tempDir } from "./helpers.ts";

describe("Command Code catalog", () => {
	it("lists the OpenAI-compatible models through the shared gateway", () => {
		const models = createCommandCodeProviderConfig().getModels();
		expect(models.map((model) => model.id)).toContain("deepseek/deepseek-v4.1-flash");
		expect(models.find((model) => model.id === "deepseek/deepseek-v4.1-flash")).toMatchObject({
			provider: COMMAND_CODE_PROVIDER_ID,
			baseUrl: COMMAND_CODE_BASE_URL,
			api: "openai-completions",
			contextWindow: 1_000_000,
		});
	});

	it("lists the Anthropic models behind the same key", () => {
		const models = createCommandCodeAnthropicProviderConfig().getModels();
		expect(models.map((model) => model.id)).toContain("claude-sonnet-5-5");
		expect(models.every((model) => model.api === "anthropic-messages")).toBe(true);
		// Pi streams Anthropic through its SDK, which appends `/v1/messages`, so the base
		// URL must stop before `/v1`: `<base>/v1/messages` is the gateway's real route.
		expect(COMMAND_CODE_BASE_URL).toBe("https://api.commandcode.ai/provider/v1");
		expect(COMMAND_CODE_ANTHROPIC_BASE_URL).toBe("https://api.commandcode.ai/provider");
		expect(models.every((model) => model.baseUrl === COMMAND_CODE_ANTHROPIC_BASE_URL)).toBe(true);
	});

	it("registers both providers through the engine extension", () => {
		const registered: { id: string }[] = [];
		registerCommandCodeProviders({
			registerProvider: (provider: { id: string }) => registered.push(provider),
		} as never);
		expect(registered.map((provider) => provider.id)).toEqual([
			COMMAND_CODE_PROVIDER_ID,
			COMMAND_CODE_ANTHROPIC_PROVIDER_ID,
		]);
	});
});

describe("Command Code accounts (offline)", () => {
	const saved = process.env[COMMAND_CODE_API_KEY_ENV];
	afterEach(() => {
		if (saved === undefined) delete process.env[COMMAND_CODE_API_KEY_ENV];
		else process.env[COMMAND_CODE_API_KEY_ENV] = saved;
	});

	it("offers both providers for API key sign-in", async () => {
		delete process.env[COMMAND_CODE_API_KEY_ENV];
		const home = tempDir();
		const providers = (await createModelAuthRuntime(home, home)).getProviders();
		const openai = providers.find((provider) => provider.id === COMMAND_CODE_PROVIDER_ID);
		const anthropic = providers.find((provider) => provider.id === COMMAND_CODE_ANTHROPIC_PROVIDER_ID);
		expect(openai?.name).toBe("Command Code");
		expect(openai?.auth.apiKey?.name).toBe("Command Code API key");
		expect(anthropic?.name).toBe("Command Code (Anthropic)");
	});

	it("stores the key in the assistant's home and a fresh runtime sees it", async () => {
		delete process.env[COMMAND_CODE_API_KEY_ENV];
		const home = tempDir();
		const first = await createModelAuthRuntime(home, home);
		await first.login(COMMAND_CODE_PROVIDER_ID, "api_key", {
			prompt: async () => "cc-test-not-real",
			notify: () => {},
		});
		const fresh = await createModelAuthRuntime(home, home);
		expect(fresh.getProviderAuthStatus(COMMAND_CODE_PROVIDER_ID)).toEqual({
			configured: true,
			source: "stored",
		});
		expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
		await fresh.logout(COMMAND_CODE_PROVIDER_ID);
		expect(
			(await createModelAuthRuntime(home, home)).getProviderAuthStatus(COMMAND_CODE_PROVIDER_ID).configured,
		).toBe(false);
	});
});
