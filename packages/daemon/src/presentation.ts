import { basename } from "node:path";
import type { Activity, ActivityKind, ActivitySource } from "@gentle-dot/protocol";
import { redactPreview } from "./activity-preview.ts";

/** The life cycle of one tool call, as the activity list shows it. */
export type ActivityStatus = "running" | "done" | "failed";

/** The titles of one tool family: while it runs, once it succeeded, once it failed. */
type Tense = readonly [running: string, done: string, failed: string];

/**
 * Turns an internal tool call into a neutral activity title. Rich clients can
 * additionally use the raw tool name and source from activityOf. The title matches the
 * call's status, so a finished or failed call never shows as still running.
 */
export function describeTool(
	toolName: string,
	args: unknown,
	status: ActivityStatus = "running",
): { kind: ActivityKind; title: string } {
	const name = toolName.toLowerCase();
	const file = fileOf(args);
	const titled = (kind: ActivityKind, titles: Tense): { kind: ActivityKind; title: string } => ({
		kind,
		title: status === "running" ? titles[0] : status === "done" ? titles[1] : titles[2],
	});
	if (name === "read")
		return titled(
			"read",
			file
				? ([`Reading ${file}`, `Read ${file}`, `Could not read ${file}`] as const)
				: (["Reading a file", "Read a file", "Could not read a file"] as const),
		);
	if (name === "write" || name === "edit")
		return titled(
			"edit",
			file
				? ([`Editing ${file}`, `Edited ${file}`, `Could not edit ${file}`] as const)
				: (["Editing a file", "Edited a file", "Could not edit a file"] as const),
		);
	if (name === "bash") return titled("run", ["Running a command", "Ran a command", "A command failed"]);
	if (name.startsWith("mem_save") || name === "mem_update" || name === "mem_session_summary")
		return titled("memory", ["Saving a note", "Saved a note", "Could not save a note"]);
	if (name.startsWith("mem_"))
		return titled("memory", ["Checking my notes", "Checked my notes", "Could not check my notes"]);
	if (name.startsWith("subagent_"))
		return titled("delegate", ["Asking a helper", "Asked a helper", "Could not ask a helper"]);
	if (["web_search", "fetch_content", "get_search_content", "source_check"].includes(name))
		return titled("search", [
			"Looking things up online",
			"Looked things up online",
			"Could not look things up online",
		]);
	if (["grep", "find", "ls"].includes(name) || name.startsWith("codegraph"))
		return titled("search", ["Searching files", "Searched files", "Could not search files"]);
	if (name.startsWith("ask_user")) return titled("other", ["Asking you", "Asked you", "Could not ask you"]);
	return titled("other", ["Working", "Finished", "Failed"]);
}

/** Engine direct MCP names are `mcp__<server>__<tool>` (mcp-servers/tool-adapter). */
export function sourceOf(tool: string): ActivitySource {
	const name = tool.toLowerCase();
	if (name.startsWith("mem_")) return "engram";
	if (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name)) return "mcp";
	if (name.startsWith("mcp__")) {
		const server = /^mcp__(.+?)__/.exec(name)?.[1];
		switch (server) {
			case "slack":
			case "linear":
			case "gmail":
			case "notion":
			case "atlassian":
			case "discord":
				return server;
			default:
				return "mcp";
		}
	}
	if (name.startsWith("gentle_review")) return "rdd";
	if (["web_search", "fetch_content", "get_search_content", "source_check", "web_enable"].includes(name))
		return "web";
	if (["read", "write", "edit", "grep", "find", "ls"].includes(name) || name.startsWith("codegraph"))
		return "files";
	if (name === "bash" || name === "bash_background" || name.startsWith("job_") || name === "monitor")
		return "shell";
	if (name.startsWith("subagent_")) return "subagent";
	return "other";
}

/** Shared live/history activity builder: no raw arguments or non-text results on the wire. */
export function activityOf(
	id: string,
	tool: string,
	args: unknown,
	status: ActivityStatus,
	result?: unknown,
	secrets: readonly string[] = [],
): Activity {
	const described = describeTool(tool, args, status);
	const activity: Activity = {
		id,
		...described,
		title: redactPreview(described.title, 200, secrets),
		status,
		tool,
		source: sourceOf(tool),
	};
	if (args !== undefined) activity.detail = redactPreview(args, 200, secrets);
	if (status !== "running" && result !== undefined)
		activity.output = redactPreview(typeof result === "string" ? result : textOf(result), 2000, secrets);
	return activity;
}

/** Excludes encrypted/redacted thinking and provider signatures. */
export function reasoningOf(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) => {
			const b = block as { type?: string; thinking?: unknown; redacted?: boolean };
			return b?.type === "thinking" && !b.redacted && typeof b.thinking === "string" ? [b.thinking] : [];
		})
		.join("");
}

function fileOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const path = record.path ?? record.file_path ?? record.filePath;
	return typeof path === "string" && path !== "" ? basename(path) : undefined;
}

/** Plain text of a user or assistant message whose content is a string or content blocks. */
export function textOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: unknown) => {
			const b = block as { type?: string; text?: unknown };
			return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
		})
		.join("");
}
