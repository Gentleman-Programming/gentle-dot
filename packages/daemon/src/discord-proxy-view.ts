import type { Command } from "./discord-package.ts";
import type { ProxiedConnector } from "./mcp-proxy.ts";

/** What the agent is told while the package is missing; connecting again prepares it with the saved token. */
export const DISCORD_NEEDS_PREPARATION =
	"Discord needs preparation. Open Connectors and choose Prepare for Discord; its token is kept.";

/**
 * The curated Discord connector as the proxy runs it where it is prepared (Windows): the validated
 * entry with Node instead of an npx shim. `command` is asked only for that connector.
 */
export function discordProxyView(
	view: ProxiedConnector | undefined,
	saved: { custom?: unknown } | undefined,
	command: () => Command | undefined,
): ProxiedConnector | undefined {
	// A connector that cannot run anyway (no app for its secret) keeps that reason: preparing
	// Discord would not help, and its advice would hide the real cause.
	if (!view || view.unavailable || view.id !== "discord" || saved?.custom) return view;
	const prepared = command();
	return prepared
		? { ...view, server: prepared, revision: `${view.revision}:${prepared.args[0]}` }
		: { ...view, unavailable: DISCORD_NEEDS_PREPARATION };
}
