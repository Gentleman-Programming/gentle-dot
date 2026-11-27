import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, createModels } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type NativeProvider = Parameters<ReturnType<typeof createModels>["setProvider"]>[0];
type NanFactory = (options: { fetchImpl: typeof fetch }) => NativeProvider;
let createNanProviderConfig: NanFactory;

beforeAll(async () => {
	const require = createRequire(import.meta.url);
	const shellRoot = dirname(require.resolve("gentle-pi/package.json"));
	const sdkDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const extensionView = join(sdkDist, "core", "extensions", "pi-ai-extension-view.js");
	// Match the real extension loader; the auth-only root view does not expose the lazy factory.
	const loader = createJiti(import.meta.url, {
		fsCache: false,
		alias: {
			"@earendil-works/pi-ai": extensionView,
			"@earendil-works/pi-ai/compat": extensionView,
		},
	});
	const module = await loader.import<{ createNanProviderConfig: NanFactory }>(
		join(shellRoot, "lib", "nan-provider.ts"),
	);
	createNanProviderConfig = module.createNanProviderConfig;
	expect(typeof createNanProviderConfig).toBe("function");
});

afterEach(() => vi.restoreAllMocks());

const context: Context = {
	messages: [
		{
			role: "system",
			content: "Synthetic NaN stream contract",
			timestamp: 0,
			toolsAdded: [{
				name: "fixture_echo",
				description: "Synthetic stream fixture only",
				parameters: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
					additionalProperties: false,
				},
			}],
		},
		{ role: "user", content: "Fixture request", timestamp: 0 },
	],
};

function response(toolUse: boolean): Response {
	const chunks: string[] = [];
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
		chunks.push(`data: ${JSON.stringify({
			id: "fixture_completion", object: "chat.completion.chunk", created: 0, model: "qwen3.6",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`);
	};
	chunk({ role: "assistant", content: "Fixture " });
	chunk({ content: "answer." });
	if (toolUse) {
		chunk({ tool_calls: [{
			index: 0, id: "call_fixture", type: "function",
			function: { name: "fixture_echo", arguments: '{"te' },
		}] });
		chunk({ tool_calls: [{ index: 0, function: { arguments: 'xt":"ok"}' } }] });
	}
	chunk({}, toolUse ? "tool_calls" : "stop");
	chunks.push("data: [DONE]\n\n");
	return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

describe("real NaN lazy streaming without network", () => {
	for (const method of ["stream", "streamSimple"] as const) {
		for (const toolUse of [false, true]) {
			it(`${method} reconstructs text and ${toolUse ? "fragmented tool calls" : "a normal stop"}`, async () => {
				let discoveryCalls = 0;
				let transportCalls = 0;
				const ambientFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
					throw new Error("Ambient network fetch is forbidden in the NaN fixture");
				});
				const provider = createNanProviderConfig({
					fetchImpl: async () => {
						discoveryCalls++;
						throw new Error("Network discovery is forbidden in the NaN fixture");
					},
				});
				const models = createModels({
					authContext: { env: async () => undefined, fileExists: async () => false },
				});
				models.setProvider(provider);
				const model = provider.getModels().find((entry) => entry.id === "qwen3.6");
				if (!model) throw new Error("The real NaN offline catalog must include qwen3.6");
				expect(model.provider).toBe("nan");

				const fixtureFetch: typeof fetch = async (input, init) => {
					transportCalls++;
					const request = input instanceof Request ? input : undefined;
					const url = request?.url ?? String(input);
					expect(url).toBe("https://api.nan.builders/v1/chat/completions");
					expect((init?.method ?? request?.method ?? "GET").toUpperCase()).toBe("POST");
					const body = init?.body ?? (request ? await request.text() : undefined);
					if (typeof body !== "string") throw new Error("Expected a JSON request body");
					const payload = JSON.parse(body) as {
						model: string; stream: boolean;
						tools: { function: { name: string; parameters: unknown } }[];
					};
					expect(payload.model).toBe("qwen3.6");
					expect(payload.stream).toBe(true);
					expect(payload.tools.map((tool) => tool.function.name)).toEqual(["fixture_echo"]);
					expect(payload.tools[0]?.function.parameters).toMatchObject({
						type: "object", required: ["text"],
					});
					return response(toolUse); // Never delegate to a real transport or open a socket.
				};
				const stream = models[method](model, context, {
					apiKey: "fixture-not-a-key", fetch: fixtureFetch,
					signal: AbortSignal.timeout(20_000), maxRetries: 0,
				});
				const events = [];
				for await (const event of stream) events.push(event);
				const result = await stream.result();
				expect(events[0]?.type).toBe("start");
				expect(events.at(-1)?.type).toBe("done");
				expect(events.some((event) => event.type === "error")).toBe(false);
				expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""))
					.toBe("Fixture answer.");
				expect(result.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
					.toBe("Fixture answer.");
				expect(result.stopReason).toBe(toolUse ? "toolUse" : "stop");
				expect(result.errorMessage).toBeUndefined();
				const calls = result.content.filter((part) => part.type === "toolCall");
				expect(calls).toEqual(toolUse ? [{
					type: "toolCall", id: "call_fixture", name: "fixture_echo", arguments: { text: "ok" },
				}] : []);
				if (toolUse) {
					expect(events.some((event) => event.type === "toolcall_start")).toBe(true);
					expect(events.some((event) => event.type === "toolcall_end")).toBe(true);
				}
				expect(transportCalls).toBe(1);
				expect(discoveryCalls).toBe(0);
				expect(ambientFetch).not.toHaveBeenCalled();
			});
		}
	}
});
