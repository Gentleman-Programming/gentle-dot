import { describe, expect, it } from "vitest";
import { DISCORD_NEEDS_PREPARATION, discordProxyView } from "../src/discord-proxy-view.ts";
import type { ProxiedConnector } from "../src/mcp-proxy.ts";

const view = (overrides: Partial<ProxiedConnector> = {}): ProxiedConnector => ({
	id: "discord",
	name: "Discord",
	enabled: true,
	mode: "read_only",
	readOnlyTools: ["read_messages"],
	server: { command: "npx", args: ["-y", "@pasympa/discord-mcp@2.2.0"] },
	revision: "abc",
	...overrides,
});
const entry = "/data/connector-packages/discord-2.2.0/node_modules/@pasympa/discord-mcp/dist/index.js";
const prepared = () => ({ command: "/opt/node/bin/node", args: [entry] });
const never = () => {
	throw new Error("the package was looked up");
};

describe("the Discord connector as the proxy runs it where it is prepared", () => {
	it("runs the prepared entry with Node and makes a new connection when the entry changes", () => {
		expect(discordProxyView(view(), {}, prepared)).toEqual(
			view({ server: { command: "/opt/node/bin/node", args: [entry] }, revision: `abc:${entry}` }),
		);
	});

	it("says it needs preparation while the package is not there", () => {
		expect(discordProxyView(view(), {}, () => undefined)).toEqual(
			view({ unavailable: DISCORD_NEEDS_PREPARATION }),
		);
		expect(DISCORD_NEEDS_PREPARATION).not.toMatch(/configure/i);
	});

	it("keeps the reason it already has (a secret it cannot read) without looking at the package", () => {
		const locked = view({ unavailable: "The desktop app is not connected." });
		expect(discordProxyView(locked, {}, never)).toBe(locked);
	});

	it("leaves a server of the user's own named discord, other connectors and missing ones alone", () => {
		const custom = view();
		expect(discordProxyView(custom, { custom: { server: { command: "discord" } } }, never)).toBe(custom);
		const slack = view({ id: "slack", name: "Slack", server: { url: "https://mcp.slack.com/mcp" } });
		expect(discordProxyView(slack, {}, never)).toBe(slack);
		expect(discordProxyView(undefined, undefined, never)).toBeUndefined();
	});
});
