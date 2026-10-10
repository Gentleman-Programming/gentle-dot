import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSessionMessages } from "./conversations.ts";
import { textOf } from "./presentation.ts";
import type { AgentSupervisor } from "./supervisor.ts";

/** When the open session is replaced: past this file size or this many compactions. */
export interface RotationLimits {
	bytes: number;
	compactions: number;
}

export const DEFAULT_ROTATION: RotationLimits = { bytes: 20 * 1024 * 1024, compactions: 10 };

/** `customType` of the hidden message that carries the earlier session into the new one. */
export const HANDOFF_TYPE = "gentle-dot.handoff";

/** The engine's session format (`CURRENT_SESSION_VERSION` in pi-coding-agent 1.0.4). */
const SESSION_VERSION = 3;
const RECENT_MESSAGES = 12;
const MESSAGE_CHARS = 2000;
const HANDOFF_INTRO =
	"This conversation continues from an earlier session that grew too long. The user sees one continuous chat and cannot see this note; carry on naturally and do not mention it.";

export function rotationLimits(env: NodeJS.ProcessEnv): RotationLimits {
	const positive = (value: string | undefined) => {
		const number = Number(value);
		return Number.isInteger(number) && number > 0 ? number : undefined;
	};
	return {
		bytes: positive(env.GENTLE_DOT_ROTATE_BYTES) ?? DEFAULT_ROTATION.bytes,
		compactions: positive(env.GENTLE_DOT_ROTATE_COMPACTIONS) ?? DEFAULT_ROTATION.compactions,
	};
}

function entries(file: string, mark: string): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes(mark)) continue;
		try {
			found.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// A torn line is skipped.
		}
	}
	return found;
}

/**
 * What the new session needs to know: the latest compaction summary (the
 * engine already wrote it, so no extra model call), or, before any
 * compaction, the previous handoff plus the last messages.
 */
export function handoffText(file: string): string {
	const summary = entries(file, '"compaction"')
		.filter((e) => e.type === "compaction" && typeof e.summary === "string")
		.at(-1)?.summary as string | undefined;
	if (summary) return `${HANDOFF_INTRO}\n\nSummary of the conversation so far:\n\n${summary}`;
	const previous = entries(file, HANDOFF_TYPE)
		.filter((e) => e.type === "custom_message" && e.customType === HANDOFF_TYPE)
		.at(-1);
	const recent = readSessionMessages(file)
		.flatMap((raw) => {
			const message = raw as { role?: unknown };
			if (message.role !== "user" && message.role !== "assistant") return [];
			const text = textOf(message).trim();
			const who = message.role === "user" ? "User" : "Assistant";
			return text
				? [`${who}: ${text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text}`]
				: [];
		})
		.slice(-RECENT_MESSAGES);
	const earlier = previous ? textOf(previous).replace(HANDOFF_INTRO, "").trim() : "";
	return [
		HANDOFF_INTRO,
		earlier ? `Earlier context:\n\n${earlier}` : "",
		recent.length > 0 ? `The latest messages:\n\n${recent.join("\n\n")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Writes a new session next to `previousFile` holding only the handoff, as a
 * hidden custom message: the engine sends it to the model as context, and its
 * history never shows it. Field names, ids, and the file name follow what the
 * engine writes itself (pi-coding-agent 1.0.4 `dist/core/session-manager.js`:
 * header 697-704, file name 711-713, custom message 947-958, entry ids 21-29).
 */
export async function writeHandoffSession(
	previousFile: string,
	text: string,
	cwd = process.cwd(),
): Promise<string> {
	const { uuidv7 } = await import("@earendil-works/pi-ai");
	const id = uuidv7();
	const timestamp = new Date().toISOString();
	const previousCwd = entries(previousFile, '"session"')[0]?.cwd;
	const header = {
		type: "session",
		version: SESSION_VERSION,
		id,
		timestamp,
		cwd: typeof previousCwd === "string" ? previousCwd : cwd,
		parentSession: previousFile,
	};
	const handoff = {
		type: "custom_message",
		customType: HANDOFF_TYPE,
		content: text,
		display: false,
		id: randomUUID().slice(0, 8),
		parentId: null,
		timestamp,
	};
	const file = join(dirname(previousFile), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(handoff)}\n`, { flag: "wx", mode: 0o600 });
	return file;
}

export interface RotatorOptions {
	limits: RotationLimits;
	/** True while nothing is running, asking, or being sent. */
	canRotate: () => boolean;
	/** The engine's working folder, for a previous session without one. */
	cwd?: string;
	/** Server mode (S25.8): gives the handoff session to the engine's user, which opens and extends it. */
	handOver?: (paths: string[]) => void;
	log?: (line: string) => void;
}

/**
 * Replaces the open session with a fresh one seeded with a handoff once the
 * session file grows too large or holds too many compactions. The chat stays
 * one: the daemon links the files, and history pages read through them.
 */
export class SessionRotator {
	private readonly supervisor: AgentSupervisor;
	private readonly options: RotatorOptions;
	private rotating = false;
	/** Compactions counted so far in one file, read incrementally. */
	private counted = { file: "", offset: 0, count: 0, rest: "" };

	constructor(supervisor: AgentSupervisor, options: RotatorOptions) {
		this.supervisor = supervisor;
		this.options = options;
	}

	/** Rotates when the open session is over a limit and the chat is idle; true when it did. */
	async maybeRotate(): Promise<boolean> {
		if (this.rotating || !this.options.canRotate()) return false;
		const file = this.supervisor.sessionFile;
		if (!file || !existsSync(file)) return false;
		const { limits } = this.options;
		const { size } = statSync(file);
		if (size < limits.bytes && this.compactionsIn(file, size) < limits.compactions) return false;
		this.rotating = true;
		try {
			const state = (await this.supervisor.request({ type: "get_state" })).data as
				| { isStreaming?: boolean; isCompacting?: boolean }
				| undefined;
			if (state?.isStreaming || state?.isCompacting || !this.options.canRotate()) return false;
			return await this.rotate(file);
		} catch (error) {
			this.log(`rotation failed, the chat stays in ${file}: ${(error as Error).message}`);
			return false;
		} finally {
			this.rotating = false;
		}
	}

	private async rotate(file: string): Promise<boolean> {
		const previous = [...this.supervisor.previousSessions, file];
		let seed: string;
		try {
			seed = await writeHandoffSession(file, handoffText(file), this.options.cwd);
			this.options.handOver?.([seed]);
		} catch (error) {
			this.log(`rotation skipped, the chat stays in ${file}: ${(error as Error).message}`);
			return false;
		}
		this.supervisor.linkSessions(seed, previous);
		try {
			await this.supervisor.request({ type: "switch_session", sessionPath: seed });
			await this.verify(seed);
			this.log(`rotation: the chat continues in ${seed}`);
			return true;
		} catch (error) {
			// The engine's session format may have drifted; never leave the user without a chat.
			this.log(
				`rotation: the engine did not load the handoff session ${seed} (${(error as Error).message}); starting a fresh session without it`,
			);
		}
		await this.supervisor.request({ type: "new_session", parentSession: file });
		const fresh = this.supervisor.sessionFile;
		if (fresh && fresh !== file) this.supervisor.linkSessions(fresh, previous);
		return true;
	}

	/** The engine opened the handoff session and its context holds the handoff. */
	private async verify(seed: string): Promise<void> {
		if (this.supervisor.sessionFile !== seed) {
			throw new Error(`the engine opened ${this.supervisor.sessionFile ?? "no session"}`);
		}
		const response = await this.supervisor.request({ type: "get_messages" });
		const messages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];
		if (!messages.some((m) => (m as { customType?: unknown }).customType === HANDOFF_TYPE)) {
			throw new Error("the handoff is missing from its context");
		}
	}

	private compactionsIn(file: string, size: number): number {
		if (this.counted.file !== file || size < this.counted.offset) {
			this.counted = { file, offset: 0, count: 0, rest: "" };
		}
		if (size > this.counted.offset) {
			const buffer = Buffer.alloc(size - this.counted.offset);
			const fd = openSync(file, "r");
			try {
				readSync(fd, buffer, 0, buffer.length, this.counted.offset);
			} finally {
				closeSync(fd);
			}
			const lines = (this.counted.rest + buffer.toString("utf8")).split("\n");
			this.counted.rest = lines.pop() ?? "";
			this.counted.count += lines.filter(isCompaction).length;
			this.counted.offset = size;
		}
		return this.counted.count;
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

function isCompaction(line: string): boolean {
	if (!line.includes('"compaction"')) return false;
	try {
		return (JSON.parse(line) as { type?: unknown }).type === "compaction";
	} catch {
		return false;
	}
}
