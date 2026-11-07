import assert from "node:assert/strict";
import test from "node:test";
import { searchProviders } from "../src/provider-search.ts";

// Public AuthProvider shapes; labels match the advertised SDK subscriptions.
const providers = [
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
	{
		id: "key-only-service",
		name: "Key Service",
		methods: ["api_key"],
		configured: false,
	},
];

test("ChatGPT subscription aliases match with existing case and trim normalization", () => {
	for (const query of ["chatgpt", "  ChAtGpT  "]) {
		assert.deepEqual(searchProviders(providers, query), providers.slice(0, 2));
	}
});

test("display names and empty queries retain existing matching behavior", () => {
	assert.deepEqual(searchProviders(providers, "  oPeNaI  "), providers.slice(0, 2));
	assert.deepEqual(searchProviders(providers, "key service"), [providers[2]]);
	assert.deepEqual(searchProviders(providers, ""), providers);
	assert.deepEqual(searchProviders(providers, "   "), providers);
	assert.deepEqual(searchProviders(undefined, "chatgpt"), []);
	assert.deepEqual(searchProviders(providers, "missing"), []);
	assert.deepEqual(searchProviders(providers, "key-only-service"), []);
});

test("search preserves original objects, IDs, methods, contents and ordering", () => {
	const before = structuredClone(providers);
	for (const provider of providers) {
		Object.freeze(provider.methods);
		Object.freeze(provider);
	}
	Object.freeze(providers);
	const matches = searchProviders(providers, "openai");
	assert.equal(matches[0], providers[0]);
	assert.equal(matches[1], providers[1]);
	searchProviders(providers, "chatgpt");
	assert.deepEqual(providers, before);
});
