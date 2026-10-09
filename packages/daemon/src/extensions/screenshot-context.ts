/**
 * Keeps computer-control screenshots from piling up in every model call (S24.10).
 *
 * The engine resends the whole history on each call, so a long control session carried every
 * screenshot it ever took. Only the last one is sent as an image; each earlier one becomes a
 * one-line entry in its place, built from what the tool already returned (no extra model calls).
 * The saved session keeps every image: this only shapes what one request carries.
 */

const COMPUTER_TOOL = "mcp__computer__";

interface Block {
	type: string;
	text?: string;
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

function logLine(message: Message, content: Block[]): Block {
	const tool = (message.toolName ?? "").slice(COMPUTER_TOOL.length) || "action";
	const app = frontApp(content);
	return { type: "text", text: `[earlier screenshot omitted: ${tool}${app ? ` in ${app}` : ""}]` };
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
		return { ...message, content: [...kept, logLine(message, content)] };
	});
}
