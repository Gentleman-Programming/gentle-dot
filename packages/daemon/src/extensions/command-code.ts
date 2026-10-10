import type { Provider, ProviderStreams } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Command Code as a model provider (S34). The user signs in with one API key in
 * Accounts, and the assistant reaches every model behind the same gateway.
 *
 * Two providers share one Command Code key and one gateway: `commandcode` speaks the
 * OpenAI chat-completions API, `commandcode-anthropic` speaks Anthropic's messages API.
 * They need different base URLs, because each SDK appends its own path
 * (`/chat/completions` and `/v1/messages`).
 * The catalog mirrors the Command Code setup the user already uses in OpenCode.
 *
 * This file is copied raw into the installed runtime (`runtime-build.ts`) and the
 * engine loads it with `-e`, so it must stay self-contained: no imports from
 * sibling files in this repository.
 */

export const COMMAND_CODE_PROVIDER_ID = "commandcode";
export const COMMAND_CODE_ANTHROPIC_PROVIDER_ID = "commandcode-anthropic";
/** OpenAI-compatible gateway: the OpenAI SDK appends `/chat/completions`. */
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
/** Anthropic gateway: the Anthropic SDK appends `/v1/messages`, so `/v1` stays out. */
export const COMMAND_CODE_ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";
export const COMMAND_CODE_API_KEY_ENV = "COMMANDCODE_API_KEY";

type CommandCodeApi = "openai-completions" | "anthropic-messages";

/** One catalog entry. Pi adds provider, base URL, and API when it lists the model. */
interface CatalogModel {
	id: string;
	name: string;
	input: ("text" | "image")[];
	reasoning: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** Command Code is quota-based, so zero rates avoid inventing per-token pricing. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The OpenAI-compatible catalog. Limits come from the Command Code setup; a model
 * with no published cost keeps the zero rates above.
 */
const COMMAND_CODE_MODELS: readonly CatalogModel[] = [
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		input: ["text"],
		reasoning: false,
		contextWindow: 1050000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 400000,
		maxTokens: 128000,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		input: ["text"],
		reasoning: false,
		contextWindow: 400000,
		maxTokens: 128000,
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		input: ["text"],
		reasoning: false,
		contextWindow: 400000,
		maxTokens: 128000,
		cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		input: ["text"],
		reasoning: false,
		contextWindow: 400000,
		maxTokens: 128000,
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro (latest)",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 384000,
		cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash (latest)",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 384000,
		cost: { input: 0.14, output: 0.28, cacheRead: 0.01, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4-flash-vision-exp",
		name: "DeepSeek V4 Flash Vision (exp)",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4-flash-fast",
		name: "DeepSeek V4 Flash Fast",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "deepseek/deepseek-v4.1-flash-fast",
		name: "DeepSeek V4.1 Flash Fast",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.7-Code",
		name: "Kimi K2.7 Code",
		input: ["text"],
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.7-Code-Highspeed",
		name: "Kimi K2.7 Code HighSpeed",
		input: ["text"],
		reasoning: false,
		contextWindow: 262000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6",
		input: ["text"],
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 131072,
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	},
	{
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 131072,
		cost: { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "z-ai/glm-5.3-flash",
		name: "GLM-5.3 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "z-ai/glm-5.3-flashx",
		name: "GLM-5.3 FlashX",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.3",
		name: "GLM-5.3",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.2",
		name: "GLM-5.2",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.2-Fast",
		name: "GLM-5.2 Fast",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5.1",
		name: "GLM-5.1",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 131072,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	},
	{
		id: "zai-org/GLM-5",
		name: "GLM-5",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 131072,
		cost: { input: 0.95, output: 3.15, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M3",
		name: "MiniMax M3",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M2.7",
		name: "MiniMax M2.7",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 131072,
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
	},
	{
		id: "MiniMaxAI/MiniMax-M2.5",
		name: "MiniMax M2.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 131072,
		cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.6-pro",
		name: "MiMo V2.6 Pro",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.6-pro-ultraspeed",
		name: "MiMo V2.6 Pro UltraSpeed",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.6-flash",
		name: "MiMo V2.6 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xiaomi/mimo-v2.5",
		name: "MiMo V2.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.8-Omni-Flash",
		name: "Qwen 3.8 Omni Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.8-Max-0902",
		name: "Qwen 3.8 Max 0902",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.8-Max",
		name: "Qwen 3.8 Max",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.8-27B",
		name: "Qwen 3.8 27B",
		input: ["text"],
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.8-Flash",
		name: "Qwen 3.8 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.7-Max",
		name: "Qwen 3.7 Max",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 131072,
		cost: { input: 1.25, output: 3.75, cacheRead: 0.25, cacheWrite: 1.56 },
	},
	{
		id: "Qwen/Qwen3.7-Plus",
		name: "Qwen 3.7 Plus",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.7-Flash",
		name: "Qwen 3.7 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "Qwen/Qwen3.6-Max-Preview",
		name: "Qwen 3.6 Max Preview",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 131072,
		cost: { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
	},
	{
		id: "Qwen/Qwen3.6-Plus",
		name: "Qwen 3.6 Plus",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 131072,
		cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
	},
	{
		id: "meituan/LongCat-2.0",
		name: "LongCat 2.0",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "stepfun/Step-5-Preview",
		name: "Step 5 Preview",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "stepfun/Step-3.7-Flash",
		name: "Step 3.7 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "stepfun/Step-3.5-Flash",
		name: "Step 3.5 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 131072,
		cost: { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 },
	},
	{
		id: "tencent/hy3-paid",
		name: "Tencent Hy3",
		input: ["text"],
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "tencent/hy4-preview",
		name: "Tencent Hy4 Preview",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 65536,
		cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "google/gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 65536,
		cost: { input: 0.25, output: 1.5, cacheRead: 0.03, cacheWrite: 0 },
	},
	{
		id: "sakana/fugu-ultra",
		name: "Fugu Ultra",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "nvidia/nemotron-3-ultra-550b-a55b",
		name: "Nemotron 3 Ultra",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "thinkingmachines/inkling",
		name: "Inkling",
		input: ["text"],
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "thinkingmachines/inkling-small",
		name: "Inkling Small",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "stealth/space-bunny-alpha",
		name: "Space Bunny Alpha",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "poolside/laguna-s-2.1-free",
		name: "Laguna S 2.1",
		input: ["text"],
		reasoning: false,
		contextWindow: 256000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "inclusionai/ling-3.0-flash-sante:free",
		name: "Ling 3.0 Flash Sante",
		input: ["text"],
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "inclusionai/ling-3.1-flash:free",
		name: "Ling 3.1 Flash",
		input: ["text"],
		reasoning: false,
		contextWindow: 262144,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "meta/muse-spark-1.1",
		name: "Muse Spark 1.1",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "meta/muse-spark-1.2",
		name: "Muse Spark 1.2",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "meta/muse-spark-1.2-contributor",
		name: "Muse Spark 1.2 Contributor",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "meta/muse-spark-1.3",
		name: "Muse Spark 1.3",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "meta/muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		input: ["text"],
		reasoning: false,
		contextWindow: 1048576,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xai/grok-4.5",
		name: "Grok 4.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 500000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xai/grok-4.6",
		name: "Grok 4.6",
		input: ["text"],
		reasoning: false,
		contextWindow: 500000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "xai/grok-4.7",
		name: "Grok 4.7",
		input: ["text"],
		reasoning: false,
		contextWindow: 500000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

/**
 * The Anthropic-messages catalog: the Claude models behind the same Command Code key.
 */
const COMMAND_CODE_ANTHROPIC_MODELS: readonly CatalogModel[] = [
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 16000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000000,
		maxTokens: 32000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		input: ["text"],
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 8192,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
];

/** Catalog entries as models of `provider`, with the provider's base URL and API. */
function commandCodeModels<A extends CommandCodeApi>(
	provider: string,
	api: A,
	baseUrl: string,
	models: readonly CatalogModel[],
) {
	return models.map((model) => ({
		...model,
		cost: { ...ZERO_COST, ...model.cost },
		provider,
		baseUrl,
		api,
	}));
}

/** One API key login for both providers: a stored credential, or COMMANDCODE_API_KEY. */
function commandCodeAuth(): Provider<CommandCodeApi>["auth"] {
	return {
		apiKey: {
			name: "Command Code API key",
			async login(interaction) {
				interaction.signal.throwIfAborted();
				const entered = await interaction.prompt({
					type: "secret",
					message: "Enter your Command Code API key",
					signal: interaction.signal,
				});
				interaction.signal.throwIfAborted();
				const key = entered.trim();
				if (!key) throw new Error("Command Code requires a non-empty API key");
				return { type: "api_key", key };
			},
			async resolve({ ctx, credential, signal }) {
				signal.throwIfAborted();
				const stored = credential?.key?.trim();
				const key = stored || (await ctx.env(COMMAND_CODE_API_KEY_ENV))?.trim();
				signal.throwIfAborted();
				if (!key) return undefined;
				return { auth: { apiKey: key }, source: stored ? "API key" : COMMAND_CODE_API_KEY_ENV };
			},
		},
	};
}

/** Pi's streaming implementation for the provider's API, loaded lazily. */
function commandCodeStreams(api: CommandCodeApi): ProviderStreams {
	return piAi.lazyApi(async () => {
		const runtime = piAi as typeof piAi & {
			openAICompletionsApi?: () => ProviderStreams;
			anthropicMessagesApi?: () => ProviderStreams;
		};
		const factory =
			api === "anthropic-messages" ? runtime.anthropicMessagesApi : runtime.openAICompletionsApi;
		if (!factory) throw new Error(`Command Code needs Pi's ${api} API factory`);
		return factory();
	});
}

export function createCommandCodeProviderConfig(): Provider<"openai-completions"> {
	const streams = commandCodeStreams("openai-completions");
	return {
		id: COMMAND_CODE_PROVIDER_ID,
		name: "Command Code",
		baseUrl: COMMAND_CODE_BASE_URL,
		auth: commandCodeAuth(),
		getModels: () =>
			commandCodeModels(
				COMMAND_CODE_PROVIDER_ID,
				"openai-completions",
				COMMAND_CODE_BASE_URL,
				COMMAND_CODE_MODELS,
			),
		refreshModels: async () => {},
		stream: streams.stream,
		streamSimple: streams.streamSimple,
	};
}

export function createCommandCodeAnthropicProviderConfig(): Provider<"anthropic-messages"> {
	const streams = commandCodeStreams("anthropic-messages");
	return {
		id: COMMAND_CODE_ANTHROPIC_PROVIDER_ID,
		name: "Command Code (Anthropic)",
		baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
		auth: commandCodeAuth(),
		getModels: () =>
			commandCodeModels(
				COMMAND_CODE_ANTHROPIC_PROVIDER_ID,
				"anthropic-messages",
				COMMAND_CODE_ANTHROPIC_BASE_URL,
				COMMAND_CODE_ANTHROPIC_MODELS,
			),
		refreshModels: async () => {},
		stream: streams.stream,
		streamSimple: streams.streamSimple,
	};
}

/** The engine loads this file with `-e`, so it registers both providers on load. */
export function registerCommandCodeProviders(pi: ExtensionAPI): void {
	pi.registerProvider(createCommandCodeProviderConfig());
	pi.registerProvider(createCommandCodeAnthropicProviderConfig());
}

export default registerCommandCodeProviders;
