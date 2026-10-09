// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are other apps' configs, written with their `${...}` references.
// S20 hardening: what the import list and the Connectors screen show of a server never carries a credential,
// wherever it sits in the command line or address, and still shows the useful shape (command, host, path).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImportCandidate } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorManager, ConnectorStore, summarize } from "../src/connectors.ts";
import { MemorySecretSource } from "../src/secret-source.ts";
import { tempDir } from "./helpers.ts";

function write(home: string, path: string, value: unknown) {
	const file = join(home, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value, null, 2));
}

const OPAQUE = "Zk3pQ9vT2mX8rL5wN1bY7cH4";

/** Each server hides one secret in a different place of its command line or address. */
const CASES: { name: string; secret: string; summary: string; server: Record<string, unknown> }[] = [
	{
		name: "remote-header",
		secret: "hdr-secret-aaaa",
		summary: "npx -y mcp-remote https://mcp.acme.dev/mcp --header Authorization: •••",
		server: {
			command: "npx",
			args: [
				"-y",
				"mcp-remote",
				"https://mcp.acme.dev/mcp",
				"--header",
				"Authorization: Bearer hdr-secret-aaaa",
			],
		},
	},
	{
		name: "remote-h",
		secret: "xkey-secret-bbbb",
		summary: "npx mcp-remote https://mcp.acme.dev/mcp -H X-API-Key: •••",
		server: {
			command: "npx",
			args: ["mcp-remote", "https://mcp.acme.dev/mcp", "-H", "X-API-Key: xkey-secret-bbbb"],
		},
	},
	{
		name: "remote-header-inline",
		secret: "inline-secret-cccc",
		summary: "npx mcp-remote https://mcp.acme.dev/mcp --header=Authorization: •••",
		server: {
			command: "npx",
			args: ["mcp-remote", "https://mcp.acme.dev/mcp", "--header=Authorization:Bearer inline-secret-cccc"],
		},
	},
	{
		name: "header-arg",
		secret: "cookie-secret-dddd",
		summary: "node proxy.js Cookie: ••• Accept: application/json",
		server: {
			command: "node",
			args: ["proxy.js", "Cookie: session=cookie-secret-dddd", "Accept: application/json"],
		},
	},
	{
		name: "query-arg",
		secret: "query-secret-eeee",
		summary: "npx mcp-remote https://api.example.com/mcp?api_key=•••&team=•••",
		server: {
			command: "npx",
			args: ["mcp-remote", "https://api.example.com/mcp?api_key=query-secret-eeee&team=t1#frag"],
		},
	},
	{
		name: "postgres",
		secret: "db-pass-ffff",
		summary: "npx -y @modelcontextprotocol/server-postgres postgresql://db.example.com:5432/app",
		server: {
			command: "npx",
			args: [
				"-y",
				"@modelcontextprotocol/server-postgres",
				"postgresql://dbuser:db-pass-ffff@db.example.com:5432/app",
			],
		},
	},
	{
		name: "path-token-arg",
		secret: OPAQUE,
		summary: "npx mcp-remote https://hooks.example.com/mcp/•••/sse-free",
		server: { command: "npx", args: ["mcp-remote", `https://hooks.example.com/mcp/${OPAQUE}/sse-free`] },
	},
	{
		name: "url-flag",
		secret: "flag-url-secret-gggg",
		summary: "uvx some-server --url=https://x.example.com/mcp?token=•••",
		server: {
			command: "uvx",
			args: ["some-server", "--url=https://x.example.com/mcp?token=flag-url-secret-gggg"],
		},
	},
	{
		name: "secret-flags",
		secret: "flag-secret-hhhh",
		summary:
			"tool --api-key ••• --password=••• --auth ••• --client-credentials ••• --bearer ••• --verbose API_TOKEN=••• --name demo",
		server: {
			command: "tool",
			args: [
				"--api-key",
				"flag-secret-hhhh-1",
				"--password=flag-secret-hhhh-2",
				"--auth",
				"flag-secret-hhhh-3",
				"--client-credentials",
				"flag-secret-hhhh-4",
				"--bearer",
				"flag-secret-hhhh-5",
				"--verbose",
				"API_TOKEN=flag-secret-hhhh-6",
				"--name",
				"demo",
			],
		},
	},
	{
		name: "prefixes",
		secret: "prefixsecretiiii",
		summary: "run ••• ••• •••",
		server: {
			command: "run",
			args: ["ghp_prefixsecretiiii", "sk-prefixsecretiiii", "xoxb-prefixsecretiiii"],
		},
	},
	{
		name: "http-userinfo",
		secret: "userinfo-secret-jjjj",
		summary: "https://mcp.example.org/v1/mcp",
		server: { type: "http", url: "https://me:userinfo-secret-jjjj@mcp.example.org/v1/mcp" },
	},
	{
		name: "http-query",
		secret: "http-query-secret-kkkk",
		summary: "https://mcp.example.net/mcp?apiKey=•••&workspace=•••",
		server: { type: "http", url: "https://mcp.example.net/mcp?apiKey=http-query-secret-kkkk&workspace=w9#x" },
	},
	{
		name: "http-path-token",
		secret: OPAQUE,
		summary: "https://hooks.example.io/services/•••/mcp",
		server: { type: "http", url: `https://hooks.example.io/services/${OPAQUE}/mcp` },
	},
];

function fixtureHome(): string {
	const home = tempDir();
	write(home, ".claude.json", {
		mcpServers: Object.fromEntries(CASES.map(({ name, server }) => [name, server])),
	});
	return home;
}

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

function setup(home: string) {
	const dataDir = tempDir();
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		secrets: new MemorySecretSource(),
	});
	const manager = new ConnectorManager({ store, importHome: home });
	managers.push(manager);
	return { store, manager };
}

const pick = (found: ImportCandidate[], name: string) => {
	const candidate = found.find((c) => c.name === name);
	if (!candidate) throw new Error(`${name} was not found`);
	return candidate;
};

describe("masking credentials in server summaries", () => {
	it("keeps every credential out of the import list and shows the command, host, and path", () => {
		const { manager } = setup(fixtureHome());
		const found = manager.scan();
		for (const { name, secret, summary } of CASES) {
			const candidate = pick(found, name);
			expect(candidate.summary, name).toBe(summary);
			expect(JSON.stringify(candidate), name).not.toContain(secret);
		}
	});

	it("keeps every credential out of the Connectors list after the import", async () => {
		const { manager } = setup(fixtureHome());
		const found = manager.scan();
		const imported = await manager.importServers(found.map((c) => c.id));
		expect(imported).toHaveLength(CASES.length);
		const list = manager.list();
		for (const { name, secret, summary } of CASES) {
			const info = list.find((c) => c.name === name);
			expect(info?.custom?.summary, name).toBe(summary);
			expect(JSON.stringify(info), name).not.toContain(secret);
		}
	});

	it("leaves ordinary arguments, package names, and paths as they are", () => {
		expect(
			summarize({
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/x/Docs", "--port", "8080"],
			}),
		).toBe("npx -y @modelcontextprotocol/server-filesystem /Users/x/Docs --port 8080");
		expect(summarize({ command: "npx", args: ["-y", "mcp-server-sequential-thinking-tools"] })).toBe(
			"npx -y mcp-server-sequential-thinking-tools",
		);
		expect(summarize({ url: "https://mcp.notion.com/mcp" })).toBe("https://mcp.notion.com/mcp");
		// An address that does not parse still loses its query and credentials.
		expect(summarize({ url: "https://me:pw-secret@bad host/mcp?key=v" })).toBe("https://bad host/mcp");
	});
});
