/**
 * Approval guard, loaded into the engine with `-e` (docs/design.md §3).
 *
 * Connector tools (`mcp__<server>__<tool>`) run without asking only when they are read-only:
 * the server marks them `readOnlyHint: true` AND they are on the connector's curated list.
 * Anything else asks the user through a confirm card with a preview, and is blocked when the
 * user declines, when nobody can answer, or when the connector is set to read only. Calls made
 * by other tools (nested calls) go through the same hook.
 *
 * The policy (approved connectors, modes, curated lists, protected files) comes from the
 * daemon in this process's environment, which the assistant cannot change. Without a valid
 * policy nothing counts as read-only, so every connector call asks.
 *
 * Connectors are the user's to change: writes, edits, and commands that touch the connector
 * files or run `mcp add/login/logout/remove` are blocked with a note to use the Connectors screen.
 * This file has no dependencies besides Node, so the engine loads it as is.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const POLICY_ENV = "GENTLE_DOT_CONNECTOR_POLICY";

export type ConnectorMode = "read_only" | "read_write";

export interface ConnectorPolicy {
	/** Approved connectors by server name; undefined when the policy is missing or invalid. */
	connectors?: Record<string, { name: string; mode: ConnectorMode; readOnlyTools: string[] }>;
	/** Files only the daemon may change. */
	protectedPaths: string[];
}

export type GuardDecision =
	| { action: "pass" }
	| { action: "ask"; title: string; message: string }
	| { action: "block"; reason: string };

export interface GuardCall {
	toolName: string;
	input: Record<string, unknown>;
	/** The tool's `readOnlyHint` annotation, as the server declared it. */
	readOnlyHint?: unknown;
	/** The working folder relative paths resolve against. */
	cwd: string;
}

const USE_CONNECTORS_SCREEN =
	"Connectors are managed by the user in the Connectors screen. Ask the user to make this change there.";
const DECLINED = "The user did not allow this action. Do not try it again unless the user asks.";
const NO_UI = "This action needs the user's approval, and no one can approve it right now.";
const CONNECTOR_COMMAND = /\bmcp\s+(?:add|login|logout|remove)\b/;
/** Arguments that say where an action goes and what it says, shown first in the preview. */
const KEY_FIELDS = [
	/^(to|cc|bcc|recipients?|channel|chat|parent|page|database|space|project|team|issue|title|subject|name)/i,
	/^(body|text|content|message|comment|description|markdown)/i,
];
const MAX_FIELDS = 6;
const MAX_VALUE = 160;

/** Like the engine's tool names: everything but letters, digits, and `_` becomes `_`. */
const toolId = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

/** Read-only only when the server declares it AND the curated list names it (fail closed). */
export function isReadOnlyCall(
	server: string,
	toolName: string,
	readOnlyHint: unknown,
	readOnlyTools: readonly string[],
): boolean {
	return readOnlyHint === true && readOnlyTools.some((tool) => toolId(server, tool) === toolName);
}

/** The policy from the daemon, or undefined when it is missing or malformed. */
export function parsePolicy(raw: string | undefined): ConnectorPolicy | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const policy = value as Partial<ConnectorPolicy>;
	if (typeof policy !== "object" || policy === null) return undefined;
	if (!Array.isArray(policy.protectedPaths) || !policy.protectedPaths.every((p) => typeof p === "string"))
		return undefined;
	const connectors = policy.connectors;
	if (typeof connectors !== "object" || connectors === null || Array.isArray(connectors)) return undefined;
	for (const entry of Object.values(connectors)) {
		const valid =
			typeof entry === "object" &&
			entry !== null &&
			typeof entry.name === "string" &&
			(entry.mode === "read_only" || entry.mode === "read_write") &&
			Array.isArray(entry.readOnlyTools) &&
			entry.readOnlyTools.every((tool) => typeof tool === "string");
		if (!valid) return undefined;
	}
	return { connectors, protectedPaths: policy.protectedPaths };
}

export function decide(call: GuardCall, policy: ConnectorPolicy): GuardDecision {
	const { toolName, input } = call;
	if (toolName === "write" || toolName === "edit") {
		const path = input.path ?? input.file_path;
		if (typeof path === "string" && isProtected(resolvePath(path, call.cwd), policy.protectedPaths))
			return { action: "block", reason: USE_CONNECTORS_SCREEN };
		return { action: "pass" };
	}
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const touches =
			CONNECTOR_COMMAND.test(command) ||
			command.includes("PI_CODING_AGENT_DIR") ||
			policy.protectedPaths.flatMap(spellings).some((path) => command.includes(path));
		return touches ? { action: "block", reason: USE_CONNECTORS_SCREEN } : { action: "pass" };
	}
	if (!toolName.startsWith("mcp__")) return { action: "pass" };

	const approved = policy.connectors;
	const server = approved
		? Object.keys(approved).find((id) => toolName.startsWith(toolId(id, "")))
		: /^mcp__(.+?)__/.exec(toolName)?.[1];
	if (approved && !server)
		return {
			action: "block",
			reason: "This connector is not approved. Ask the user to add it from the Connectors screen.",
		};
	const connector = server && approved ? approved[server] : undefined;
	if (connector && isReadOnlyCall(server ?? "", toolName, call.readOnlyHint, connector.readOnlyTools))
		return { action: "pass" };
	const name = connector?.name ?? server ?? "a connector";
	if (connector?.mode === "read_only")
		return {
			action: "block",
			reason: `${name} is set to read only, so this action was not run. If the user wants it, ask them to switch ${name} to "Read and send" in Connectors.`,
		};
	const action = describeAction(toolName, server ?? "");
	return {
		action: "ask",
		title: `Allow ${name} to ${action}?`,
		message: [`The assistant wants to ${action} in ${name}.`, "", ...previewLines(input)]
			.join("\n")
			.trimEnd(),
	};
}

/** `mcp__notion__notion_create_pages` -> "create pages". */
function describeAction(toolName: string, server: string): string {
	let action = toolName.slice(toolId(server, "").length);
	if (action.startsWith(`${server}_`)) action = action.slice(server.length + 1);
	const words = action.split("_").filter(Boolean).join(" ");
	return words ? words.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "use a tool";
}

function previewLines(input: Record<string, unknown>): string[] {
	const rank = (key: string) => {
		const index = KEY_FIELDS.findIndex((pattern) => pattern.test(key));
		return index < 0 ? KEY_FIELDS.length : index;
	};
	const keys = Object.keys(input).sort((a, b) => rank(a) - rank(b));
	const lines = keys.slice(0, MAX_FIELDS).map((key) => `${key}: ${shorten(input[key])}`);
	if (keys.length > MAX_FIELDS) lines.push(`…and ${keys.length - MAX_FIELDS} more`);
	return lines;
}

function shorten(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	const short = text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
	// Lines inside one value are indented, so they do not read as fields of their own.
	return short.replace(/\n/g, "\n  ");
}

function resolvePath(path: string, cwd: string): string {
	const home = process.env.HOME;
	const expanded = home && (path === "~" || path.startsWith("~/")) ? `${home}${path.slice(1)}` : path;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** A path as written and with symlinks resolved (`/var` is `/private/var` on macOS), for a missing file too. */
function spellings(path: string): string[] {
	const absolute = resolve(path);
	let real = absolute;
	try {
		real = realpathSync(absolute);
	} catch {
		try {
			real = join(realpathSync(dirname(absolute)), basename(absolute));
		} catch {}
	}
	return real === absolute ? [absolute] : [absolute, real];
}

function isProtected(path: string, protectedPaths: string[]): boolean {
	// macOS and Windows folders usually ignore case.
	const candidates = spellings(path).map((p) => p.toLowerCase());
	return protectedPaths.some((p) => spellings(p).some((s) => candidates.includes(s.toLowerCase())));
}

export default function approvalGuard(pi: ExtensionAPI): void {
	const parsed = parsePolicy(process.env[POLICY_ENV]);
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const fallback = agentDir ? [resolve(agentDir, "mcp.json"), resolve(agentDir, "mcp-auth.json")] : [];
	const policy: ConnectorPolicy = parsed ?? { protectedPaths: fallback };

	pi.on("tool_call", async (event, ctx) => {
		const annotations = event.toolName.startsWith("mcp__")
			? pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations
			: undefined;
		const decision = decide(
			{
				toolName: event.toolName,
				input: event.input as Record<string, unknown>,
				readOnlyHint: annotations?.readOnlyHint,
				cwd: ctx.cwd,
			},
			policy,
		);
		if (decision.action === "pass") return undefined;
		if (decision.action === "block") return { block: true, reason: decision.reason };
		if (!ctx.hasUI) return { block: true, reason: NO_UI };
		const allowed = await ctx.ui.confirm(decision.title, decision.message);
		return allowed ? undefined : { block: true, reason: DECLINED };
	});
}
