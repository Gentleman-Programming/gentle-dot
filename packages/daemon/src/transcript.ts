/**
 * The conversation as the daemon saw it: the prompts it routed and the answers it delivered.
 *
 * The engine keeps its own session files, but they carry the whole agent transcript (tool calls,
 * steering, reasoning) and their layout is the engine's business. A window that opens later only
 * needs the chat, so the daemon records that itself, appends it to one file and serves pages of
 * it. It survives a restart because the file outlives the process.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeRecord } from "./jsonl.js";

export interface TranscriptEntry {
	id: string;
	role: "user" | "assistant";
	text: string;
	/** Epoch ms, so a client can order or timestamp it. */
	at: number;
}

/** How many messages a page holds when the client does not ask. */
export const DEFAULT_PAGE = 50;

export class Transcript {
	private entries: TranscriptEntry[] = [];
	private seq = 0;

	constructor(private readonly file: string) {}

	/** Reads what earlier runs appended. A malformed line is skipped, not fatal. */
	load(): void {
		if (!existsSync(this.file)) return;
		for (const line of readFileSync(this.file, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				const entry = JSON.parse(line) as TranscriptEntry;
				if (typeof entry.id === "string" && (entry.role === "user" || entry.role === "assistant")) {
					this.entries.push(entry);
				}
			} catch {
				// a torn last line is the normal way an append dies; skip it
			}
		}
	}

	add(role: TranscriptEntry["role"], text: string): TranscriptEntry | null {
		const body = text.trim();
		if (body === "") return null;
		const entry: TranscriptEntry = { id: `t-${Date.now().toString(36)}-${++this.seq}`, role, text: body, at: Date.now() };
		this.entries.push(entry);
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, encodeRecord(entry));
		} catch (error) {
			// Losing the file must not lose the conversation in this process.
			console.error(`[Transcript] Could not append (${this.file}):`, error);
		}
		return entry;
	}

	/**
	 * The page of messages before `before` (an id), or the newest page when it is undefined.
	 * `hasEarlier` says whether an older page exists.
	 */
	page(before?: string, limit = DEFAULT_PAGE): { messages: TranscriptEntry[]; hasEarlier: boolean } {
		let end = this.entries.length;
		if (before) {
			const at = this.entries.findIndex((entry) => entry.id === before);
			if (at >= 0) end = at;
		}
		const start = Math.max(0, end - limit);
		return { messages: this.entries.slice(start, end), hasEarlier: start > 0 };
	}

	size(): number {
		return this.entries.length;
	}
}
