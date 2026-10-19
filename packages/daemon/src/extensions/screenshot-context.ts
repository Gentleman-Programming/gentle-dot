/**
 * Keeps one model call inside a request size the provider answers (S24.10, S1/S2).
 *
 * The engine resends the whole history on each call, so a long control session carried every
 * screenshot it ever took and, once enough of them piled up, the whole request broke the provider
 * (HTTP 500 with no body, indistinguishable from an outage). Nothing capped the total: the image
 * caps only look at one image at a time. Two steps shape one request, never the saved session, so
 * the chat stays one continuous chat:
 *
 * 1. Every computer screenshot but the last becomes a one-line entry in its place, built from what
 *    the tool already returned (no extra model calls).
 * 2. The request total is then brought under a budget by dropping the oldest images of tool
 *    results, of any tool, and only then by truncating the oldest large tool outputs. User and
 *    assistant messages are never rewritten, and the newest image always stays.
 *
 * The budget is the configured one, lowered by the ceiling learned for the model in use (S1, see
 * `limits.ts`). Nothing learned is exactly the configured budget.
 */

import { effectiveBudget, LIMITS_FILE_ENV, readLimits } from "../limits.ts";

const COMPUTER_TOOL = "mcp__computer__";

/**
 * Where the request budget is set, in bytes. Unset or not a positive number means
 * `DEFAULT_REQUEST_BUDGET`.
 */
export const REQUEST_BUDGET_ENV = "GENTLE_DOT_REQUEST_BUDGET_BYTES";

/**
 * A starting value, not a provider's real limit: no such limit is knowable (the failure carries no
 * body and varies by model), so this is half of the ~16 MB request observed to fail, leaving a
 * margin for what the count does not see (JSON framing, the reply, provider-side accounting). The
 * ceiling learned for a model may lower it, never raise it (`limits.ts`).
 */
export const DEFAULT_REQUEST_BUDGET = 8 * 1024 * 1024;

/** A tool output shorter than this is never truncated: it is not what makes a request large. */
const LARGE_TEXT = 2_000;
/** How much of a truncated tool output stays, so the model still sees what the call returned. */
const TEXT_HEAD = 500;

interface Block {
	type: string;
	text?: string;
	data?: string;
}

interface Message {
	role?: string;
	toolName?: string;
	content?: unknown;
}

function isScreenshotResult(message: Message): boolean {
	return (
		message.role === "toolResult" &&
		typeof message.toolName === "string" &&
		message.toolName.startsWith(COMPUTER_TOOL) &&
		Array.isArray(message.content) &&
		message.content.some((block: Block) => block?.type === "image")
	);
}

/** The front app from the helper's metadata block, when there is one. */
function frontApp(content: Block[]): string | undefined {
	for (const block of content) {
		if (block.type !== "text" || !block.text?.startsWith("{")) continue;
		try {
			const app = JSON.parse(block.text).frontApp;
			if (typeof app === "string" && app) return app;
		} catch {
			// Not the metadata block.
		}
	}
	return undefined;
}

function isMetadata(block: Block): boolean {
	return block.type === "text" && frontApp([block]) !== undefined;
}

/** The one-line entry left in place of an image, naming the tool (and app) it came from. */
function logLine(toolName: string | undefined, content: Block[]): Block {
	const name = toolName ?? "";
	if (!name.startsWith(COMPUTER_TOOL)) {
		return { type: "text", text: `[earlier screenshot omitted: ${name || "tool output"}]` };
	}
	const tool = name.slice(COMPUTER_TOOL.length) || "action";
	const app = frontApp(content);
	return { type: "text", text: `[earlier screenshot omitted: ${tool}${app ? ` in ${app}` : ""}]` };
}

/** Blocks of a message's content, or none when the content is plain text. */
function blocksOf(message: Message): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** An image's base64 payload, or a text block's bytes: what the provider charges for. */
function blockBytes(block: Block | undefined): number {
	if (block?.type === "image") return typeof block.data === "string" ? Buffer.byteLength(block.data) : 0;
	return typeof block?.text === "string" ? Buffer.byteLength(block.text) : 0;
}

/**
 * What one message adds to a request. JSON framing is left out on purpose; it is a small constant
 * next to base64 images.
 */
function messageBytes(message: Message): number {
	if (typeof message.content === "string") return Buffer.byteLength(message.content);
	return blocksOf(message).reduce((total, block) => total + blockBytes(block), 0);
}

function configuredBudget(env: Record<string, string | undefined>): number {
	const raw = env[REQUEST_BUDGET_ENV]?.trim();
	if (!raw) return DEFAULT_REQUEST_BUDGET;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_REQUEST_BUDGET;
}

/**
 * The budget for one call: the configured one, lowered by what a refused and then answered request
 * taught about the model the engine is on. A missing, torn, or unreadable file leaves the configured
 * budget in force, so nothing learned is the same request shaping as before S1.
 */
function budgetFrom(env: Record<string, string | undefined>): number {
	const configured = configuredBudget(env);
	const file = env[LIMITS_FILE_ENV]?.trim();
	return file ? effectiveBudget(configured, readLimits(file)) : configured;
}

/** The head of a tool output plus what was cut, without splitting a surrogate pair. */
function truncateText(text: string): string {
	const cut = text.slice(0, TEXT_HEAD);
	const head = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
	return `${head}[truncated: ${text.length - head.length} characters removed to keep the request under its size budget]`;
}

/**
 * A message with the images at `drop` left out; its text stays, plus one line naming the tool. The
 * helper's metadata goes with the last image, since it describes a screenshot that is no longer
 * there.
 */
function withoutImages(message: Message, drop: Set<number>): Message {
	const content = blocksOf(message);
	const kept = content.filter((_block, i) => !drop.has(i));
	const anyImage = kept.some((block) => block?.type === "image");
	return {
		...message,
		content: [...kept.filter((block) => anyImage || !isMetadata(block)), logLine(message.toolName, content)],
	};
}

/**
 * The messages for one model call, under the request budget: the oldest tool images go first (the
 * newest image always stays), and only if that is not enough, the oldest large tool outputs are
 * truncated. User and assistant messages are never rewritten. Returns the input array itself when
 * nothing had to change.
 */
export function applyRequestBudget<T extends Message>(
	messages: T[],
	budget: number = budgetFrom(process.env),
): T[] {
	let total = messages.reduce((sum, message) => sum + messageBytes(message), 0);
	if (total <= budget) return messages;

	const shaped = [...messages];
	const changed = new Set<number>();

	// Oldest first, across the whole history: only tool results can give their images up.
	const images: { message: number; block: number }[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role !== "toolResult") continue;
		for (const [block, value] of blocksOf(message).entries()) {
			if (value?.type === "image") images.push({ message: index, block });
		}
	}
	const drop = new Map<number, Set<number>>();
	for (const { message, block } of images.slice(0, -1)) {
		if (total <= budget) break;
		const source = messages[message];
		if (!source) continue;
		total -= blockBytes(blocksOf(source)[block]);
		const dropped = drop.get(message) ?? new Set<number>();
		dropped.add(block);
		drop.set(message, dropped);
	}
	for (const [index, blocks] of drop) {
		const message = messages[index];
		if (!message) continue;
		shaped[index] = withoutImages(message, blocks) as T;
		changed.add(index);
	}

	// Still over: the oldest large tool outputs, in order, as little as it takes.
	const truncated = new Set<string>();
	for (let index = 0; index < shaped.length && total > budget; index++) {
		const message = shaped[index];
		if (message?.role !== "toolResult") continue;
		const content = [...blocksOf(message)];
		let rewritten = false;
		for (const [block, value] of content.entries()) {
			if (total <= budget) break;
			if (typeof value?.text !== "string" || value.text.length < LARGE_TEXT) continue;
			if (truncated.has(`${index}:${block}`)) continue;
			const text = truncateText(value.text);
			total -= Buffer.byteLength(value.text) - Buffer.byteLength(text);
			content[block] = { ...value, text };
			truncated.add(`${index}:${block}`);
			rewritten = true;
		}
		if (!rewritten) continue;
		shaped[index] = { ...message, content } as T;
		changed.add(index);
	}

	return changed.size > 0 ? shaped : messages;
}

/**
 * The messages for one model call: every computer screenshot but the last is replaced by a log
 * line, keeping the action's own text. Returns the input array itself when nothing changes.
 */
export function pruneScreenshots<T extends Message>(messages: T[]): T[] {
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && isScreenshotResult(message)) {
			last = i;
			break;
		}
	}
	if (last < 0 || !messages.slice(0, last).some(isScreenshotResult)) return messages;
	return messages.map((message, i) => {
		if (i === last || !isScreenshotResult(message)) return message;
		const content = message.content as Block[];
		const kept = content.filter((block) => block.type !== "image" && !isMetadata(block));
		return { ...message, content: [...kept, logLine(message.toolName, content)] };
	});
}
