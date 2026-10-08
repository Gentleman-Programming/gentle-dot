import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Activity, ConversationSummary, HistoryMessage } from "@gentle-dot/protocol";
import { describeTool, textOf } from "./presentation.ts";

const TITLE_SCAN_BYTES = 256 * 1024;
const TITLE_LENGTH = 60;

/** Session files under `sessionDir` (and one level of subfolders), newest first. */
export function listConversations(sessionDir: string): ConversationSummary[] {
	if (!existsSync(sessionDir)) return [];
	const files: { path: string; mtime: Date }[] = [];
	for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
		const path = join(sessionDir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push({ path, mtime: statSync(path).mtime });
		if (entry.isDirectory()) {
			for (const nested of readdirSync(path, { withFileTypes: true })) {
				if (nested.isFile() && nested.name.endsWith(".jsonl")) {
					const nestedPath = join(path, nested.name);
					files.push({ path: nestedPath, mtime: statSync(nestedPath).mtime });
				}
			}
		}
	}
	return files
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
		.map(({ path, mtime }) => ({
			id: conversationIdOf(sessionDir, path),
			title: titleOf(path),
			updatedAt: mtime.toISOString(),
		}));
}

export function conversationIdOf(sessionDir: string, sessionFile: string): string {
	return relative(sessionDir, sessionFile).split(sep).join("/");
}

/** Resolves a client-supplied id to a session file inside `sessionDir`, or undefined. */
export function resolveConversation(sessionDir: string, id: string): string | undefined {
	if (!id.endsWith(".jsonl") || id.includes("\0")) return undefined;
	const root = resolve(sessionDir);
	const path = resolve(root, id);
	if (!path.startsWith(root + sep)) return undefined;
	return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

function titleOf(path: string): string {
	let name: string | undefined;
	let firstUser: string | undefined;
	for (const line of readHead(path).split("\n")) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (record.type === "session_info") name = typeof record.name === "string" ? record.name : undefined;
		const message = (record.message ?? record) as { role?: unknown };
		if (firstUser === undefined && message.role === "user") firstUser = textOf(message);
	}
	const title = (name ?? firstUser ?? "").replace(/\s+/g, " ").trim();
	if (!title) return "New conversation";
	return title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1)}…` : title;
}

function readHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(TITLE_SCAN_BYTES);
		const bytes = readSync(fd, buffer, 0, TITLE_SCAN_BYTES, 0);
		return buffer.subarray(0, bytes).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

type AgentMessage = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };

/** Converts Pi `get_messages` output into display messages; consecutive assistant messages form one turn. */
export function historyFromMessages(messages: unknown[]): HistoryMessage[] {
	const failed = new Set<string>();
	for (const raw of messages) {
		const m = raw as AgentMessage;
		if (m.role === "toolResult" && m.isError && m.toolCallId) failed.add(m.toolCallId);
	}
	const history: HistoryMessage[] = [];
	let index = 0;
	for (const raw of messages) {
		const m = raw as AgentMessage;
		if (m.role === "user") {
			history.push({ id: `h${++index}`, role: "user", text: textOf(m), activities: [] });
			continue;
		}
		if (m.role !== "assistant") continue;
		let turn = history.at(-1);
		if (turn?.role !== "assistant") {
			turn = { id: `h${++index}`, role: "assistant", text: "", activities: [] };
			history.push(turn);
		}
		const text = textOf(m);
		if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
		turn.activities.push(...activitiesOf(m, failed));
	}
	return history;
}

function activitiesOf(message: AgentMessage, failed: Set<string>): Activity[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((block: unknown) => {
		const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
		if (b?.type !== "toolCall" || typeof b.name !== "string") return [];
		const id = b.id ?? b.name;
		return [
			{ id, ...describeTool(b.name, b.arguments), status: failed.has(id) ? "failed" : "done" } as Activity,
		];
	});
}
