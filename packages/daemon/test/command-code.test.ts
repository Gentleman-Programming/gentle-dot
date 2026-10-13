import { statSync } from "node:fs";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
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

/** A stand-in for the gateway's `GET /models`, with the fields the real one publishes. */
function fakeGateway(data: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ object: "list", data }), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

/** A `RefreshModelsContext` bare enough to drive one refresh, publishing inline. */
function refreshContext(allowNetwork = true): RefreshModelsContext {
	return {
		allowNetwork,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	};
}

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

describe("Command Code gateway catalog", () => {
	it("filters the gateway's models by the endpoint each provider speaks", async () => {
		const fetchImpl = fakeGateway([
			{
				id: "deepseek/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				context_length: 1_000_000,
				supported_endpoints: ["/chat/completions", "/responses"],
			},
			{
				id: "claude-sonnet-5-5",
				name: "Claude Sonnet 5.5",
				context_length: 1_000_000,
				supported_endpoints: ["/messages"],
			},
			{
				id: "brand-new-model",
				name: "Brand New",
				context_length: 500_000,
				supported_endpoints: ["/chat/completions"],
			},
		]);
		const openai = createCommandCodeProviderConfig({ fetchImpl });
		const anthropic = createCommandCodeAnthropicProviderConfig({ fetchImpl });
		await openai.refreshModels?.(refreshContext());
		await anthropic.refreshModels?.(refreshContext());

		const openaiIds = openai.getModels().map((model) => model.id);
		expect(openaiIds).toContain("brand-new-model");
		expect(openaiIds).not.toContain("claude-sonnet-5-5");
		// The fallback still supplies what the gateway does not publish (the output limit).
		expect(openai.getModels().find((model) => model.id === "deepseek/deepseek-v4.1-flash")?.maxTokens).toBe(
			32_768,
		);

		expect(anthropic.getModels().map((model) => model.id)).toEqual(["claude-sonnet-5-5"]);
	});

	it("keeps the fallback catalog when the gateway is unreachable", async () => {
		const fetchImpl = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const provider = createCommandCodeProviderConfig({ fetchImpl });
		const before = provider.getModels().length;
		await provider.refreshModels?.(refreshContext());
		expect(provider.getModels().length).toBe(before);
	});

	it("does not reach the gateway when the runtime is offline", async () => {
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const provider = createCommandCodeProviderConfig({ fetchImpl });
		await provider.refreshModels?.(refreshContext(false));
		expect(called).toBe(false);
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
