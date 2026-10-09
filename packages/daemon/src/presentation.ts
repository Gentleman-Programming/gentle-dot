import { basename } from "node:path";
import type { ActivityKind } from "@gentle-dot/protocol";

/**
 * Turns an internal tool call into a neutral activity. Tool names never reach
 * the user; only the kind and a short human title do.
 */
export function describeTool(toolName: string, args: unknown): { kind: ActivityKind; title: string } {
	const name = toolName.toLowerCase();
	const file = fileOf(args);
	if (name === "read") return { kind: "read", title: file ? `Reading ${file}` : "Reading a file" };
	if (name === "write" || name === "edit")
		return { kind: "edit", title: file ? `Editing ${file}` : "Editing a file" };
	if (name === "bash") return { kind: "run", title: "Running a command" };
	if (name.startsWith("mem_save") || name === "mem_update" || name === "mem_session_summary") {
		return { kind: "memory", title: "Saving a note" };
	}
	if (name.startsWith("mem_")) return { kind: "memory", title: "Checking my notes" };
	if (name.startsWith("subagent_")) return { kind: "delegate", title: "Asking a helper" };
	if (["web_search", "fetch_content", "get_search_content", "source_check"].includes(name)) {
		return { kind: "search", title: "Looking things up online" };
	}
	if (["grep", "find", "ls"].includes(name) || name.startsWith("codegraph")) {
		return { kind: "search", title: "Searching files" };
	}
	if (name.startsWith("ask_user")) return { kind: "other", title: "Asking you" };
	return { kind: "other", title: "Working" };
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
