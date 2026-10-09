import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/index.ts";

const parse = (value: object) => parseClientMessage(JSON.stringify(value));

describe("model picker messages (S32)", () => {
	it("accepts listing the models and choosing one, with an optional thinking level", () => {
		expect(parse({ type: "models_list" })).toEqual({ type: "models_list" });
		expect(parse({ type: "model_set", provider: "openai", id: "gpt-5", extra: 1 })).toEqual({
			type: "model_set",
			provider: "openai",
			id: "gpt-5",
		});
		expect(
			parse({ type: "model_set", provider: "openrouter", id: "anthropic/claude", thinking: "high" }),
		).toEqual({ type: "model_set", provider: "openrouter", id: "anthropic/claude", thinking: "high" });
	});

	it("refuses a missing or malformed provider, model, or thinking level", () => {
		expect(parse({ type: "model_set", id: "gpt-5" })).toBeUndefined();
		expect(parse({ type: "model_set", provider: "openai" })).toBeUndefined();
		expect(parse({ type: "model_set", provider: "open/ai", id: "gpt-5" })).toBeUndefined();
		expect(parse({ type: "model_set", provider: "openai", id: "" })).toBeUndefined();
		expect(parse({ type: "model_set", provider: "openai", id: "a b" })).toBeUndefined();
		expect(parse({ type: "model_set", provider: "openai", id: "x".repeat(257) })).toBeUndefined();
		expect(parse({ type: "model_set", provider: "openai", id: "gpt-5", thinking: "turbo" })).toBeUndefined();
	});
});
