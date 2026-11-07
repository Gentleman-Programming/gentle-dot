import type { AuthProvider } from "@gentle-dot/protocol";
import { expect, it } from "vitest";
import { searchProviders } from "../src/provider-search.ts";

// Public provider labels match the advertised subscriptions, not provider IDs.
const providers: AuthProvider[] = [
	{
		id: "openai",
		name: "OpenAI",
		methods: ["oauth", "api_key"],
		oauthName: "OpenAI (ChatGPT subscription)",
		configured: false,
	},
	{
		id: "openai-codex",
		name: "OpenAI Codex (legacy)",
		methods: ["oauth"],
		oauthName: "OpenAI (ChatGPT Plus/Pro)",
		configured: true,
		source: "stored",
	},
	{ id: "key-only-service", name: "Key Service", methods: ["api_key"], configured: false },
];

it("matches subscription aliases with existing case and trim normalization", () => {
	for (const query of ["chatgpt", "  ChAtGpT  "]) {
		expect(searchProviders(providers, query)).toEqual(providers.slice(0, 2));
	}
});

it("retains display-name, empty-query, missing-provider and no-match behavior", () => {
	expect(searchProviders(providers, "  oPeNaI  ")).toEqual(providers.slice(0, 2));
	expect(searchProviders(providers, "key service")).toEqual([providers[2]]);
	expect(searchProviders(providers, "")).toEqual(providers);
	expect(searchProviders(providers, "   ")).toEqual(providers);
	expect(searchProviders(undefined, "chatgpt")).toEqual([]);
	expect(searchProviders(providers, "missing")).toEqual([]);
	expect(searchProviders(providers, "key-only-service")).toEqual([]);
});

it("preserves original objects, IDs, methods, contents and ordering", () => {
	const before = structuredClone(providers);
	for (const provider of providers) {
		Object.freeze(provider.methods);
		Object.freeze(provider);
	}
	Object.freeze(providers);
	const matches = searchProviders(providers, "openai");
	expect(matches[0]).toBe(providers[0]);
	expect(matches[1]).toBe(providers[1]);
	searchProviders(providers, "chatgpt");
	expect(providers).toEqual(before);
});
