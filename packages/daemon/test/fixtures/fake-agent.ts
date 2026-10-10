#!/usr/bin/env node
// A deterministic stand-in for `gentle-shell --mode rpc`. It speaks the same JSONL
// records the daemon relies on, persists messages per session file in Pi's format
// (a `session` header, then `message`, `compaction`, and `custom_message` entries;
// custom messages are hidden context the model sees), and has scripted prompts for tests:
//   "tool:<name>"  runs one fake tool call
//   "ask:select"   asks a select dialog and echoes the answer
//   "ask:confirm"  asks a confirm dialog and echoes the answer
//   "ask:approval" asks the approval guard's real confirm for a Notion page, and echoes the answer
//   "propose:<json>" runs the approval guard's real propose_connector with <json> as its arguments
//   "hang"         starts a run that only ends on abort (an aborted answer), or on a
//                  session switch (Pi then ends it with an error: "This operation was aborted")
//   "fail"         the provider fails: an answer that ends with stopReason "error"
//   "slow"         answers after 1.5 s, leaving time to queue messages
//   "crash"        starts a run and exits with code 1
//   "burst"        answers and finishes the run in a single stdout write
//   "burst:<text>" runs <text> the same way: the prompt's response and the whole run in one write
//   "compact"      records a compaction entry (its summary lists the user's messages so far)
//   "pad:<n>"      grows the session file by about n bytes (an entry outside the context)
//   "recall"       answers with the hidden context messages it was given
//   "tamper"       does what an agent with a shell in <data>/workspace could (L47 B1): turns Notion on
//                  in ../connectors.json and ../agent/mcp.json, adds .pi/mcp.json, then ends itself
//                  like `kill $PPID`; "tamper:stay" changes the files and keeps running
// The "noreply" command is never answered.
// A prompt sent while busy (with streamingBehavior), steer, and follow_up are
// queued like Pi does: a queue_update with both complete queues, then each one
// is taken when the run would end (queue_update, user message_start, echo).
// Environment:
//   FAKE_AGENT_ARGS_FILE  write argv as JSON to this file
//   FAKE_AGENT_BRANDING   emit branded startup UI records
//   FAKE_AGENT_ENV_FILE   write selected environment variables as JSON to this file
//   FAKE_AGENT_CWD_FILE   write the working directory to this file
//   FAKE_AGENT_COMMANDS_FILE  append every model command (set_model, set_thinking_level) as JSONL
//   FAKE_AGENT_NO_MODEL   refuse every prompt, like an engine with no signed-in account
//   FAKE_AGENT_DROP_QUEUE settle without taking or reporting queued messages
//   FAKE_AGENT_IGNORE_ABORT  answer abort but keep running (a session switch still ends the run)
//   FAKE_AGENT_START_DELAY_MS  answer the first get_state only after this delay
//   FAKE_AGENT_DROP_CUSTOM  load session files without their custom messages (a format drift)
//   FAKE_AGENT_PROMPTS_FILE  append every prompt command (message, images, streamingBehavior) as JSONL
//   FAKE_AGENT_MARKER_FILE  write whether the `--home` folder held gentle-shell's `.gentle-shell-home` at launch
//   FAKE_AGENT_PROCESS_FILE  write the whole environment, argv, and the process's uid and gid as JSON
//   FAKE_AGENT_STDIN_FILE  append every line the daemon writes to the agent's stdin
// get_available_models lists MODELS; set_model and set_thinking_level change what
// get_state reports, so tests can read the last values back. A model's `input` says whether it
// accepts images, like the engine's models.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Rec = Record<string, unknown>;
type Message = {
	role: "user" | "assistant" | "custom";
	content: string;
	customType?: string;
	images?: Rec[];
};

const MODELS: Rec[] = [
	{
		id: "fake-model",
		name: "Fake Model",
		provider: "fake",
		reasoning: true,
		input: ["text", "image"],
		// Real models may carry credentials in headers; they must never reach a client.
		headers: { Authorization: "Bearer fake-secret-header" },
		baseUrl: "https://internal.fake.example",
		cost: { input: 1, output: 2 },
	},
	{ id: "fake-fast", name: "Fake Fast", provider: "fake", reasoning: false, input: ["text"] },
	{ id: "big", name: "Other Big", provider: "other", reasoning: true },
];
let model = MODELS[0] as Rec;
let thinkingLevel = "medium";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGENT_ARGS_FILE) writeFileSync(process.env.FAKE_AGENT_ARGS_FILE, JSON.stringify(argv));
if (process.env.FAKE_AGENT_CWD_FILE) writeFileSync(process.env.FAKE_AGENT_CWD_FILE, process.cwd());
if (process.env.FAKE_AGENT_MARKER_FILE) {
	const home = argv[argv.indexOf("--home") + 1];
	const marked =
		argv.includes("--home") && home !== undefined && existsSync(join(home, ".gentle-shell-home"));
	writeFileSync(process.env.FAKE_AGENT_MARKER_FILE, JSON.stringify(marked));
}
if (process.env.FAKE_AGENT_ENV_FILE) {
	writeFileSync(
		process.env.FAKE_AGENT_ENV_FILE,
		JSON.stringify(
			Object.fromEntries(
				[
					"GENTLE_PI_CONFIG_HOME",
					"HOME",
					"XDG_CONFIG_HOME",
					"XDG_DATA_HOME",
					"XDG_CACHE_HOME",
					"XDG_STATE_HOME",
					"GIT_CONFIG_GLOBAL",
					"PATH",
					"PI_CODING_AGENT_DIR",
					"GENTLE_SHELL_CONFIG",
					"ENGRAM_PORT",
					"ENGRAM_URL",
					"ENGRAM_DATA_DIR",
					"GENTLE_DOT_CONNECTOR_POLICY",
					"GENTLE_PI_AGENTS",
				].map((key) => [key, process.env[key]]),
			),
		),
	);
}
if (process.env.FAKE_AGENT_PROCESS_FILE) {
	writeFileSync(
		process.env.FAKE_AGENT_PROCESS_FILE,
		JSON.stringify({ env: process.env, argv, uid: process.getuid?.(), gid: process.getgid?.() }),
	);
}
const sessionDir = argValue("--session-dir") ?? join(process.cwd(), ".fake-sessions");
mkdirSync(sessionDir, { recursive: true });

let sessionId = "";
let sessionFile = "";
let messages: Message[] = [];
let lastEntryId: string | null = null;
let busy = false;
let hanging: ((stopReason: "aborted" | "error") => void) | undefined;
/** Resolves when the current run has ended. */
let runEnded: Promise<void> = Promise.resolve();
let started = false;
const queue = { steering: [] as string[], followUp: [] as string[] };
/** Records collected for one stdout write while a "burst" prompt runs. */
let batch: string[] | undefined;
const pendingUi = new Map<string, (rec: Rec) => void>();
newSession();

function argValue(name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function recordCommand(rec: Rec): void {
	const file = process.env.FAKE_AGENT_COMMANDS_FILE;
	if (!file) return;
	const { id: _id, ...command } = rec;
	appendFileSync(file, `${JSON.stringify({ ...command, busy })}\n`);
}

function out(rec: Rec): void {
	if (batch) batch.push(`${JSON.stringify(rec)}\n`);
	else process.stdout.write(`${JSON.stringify(rec)}\n`);
}

function newSession(parentSession?: unknown): void {
	sessionId = randomUUID();
	sessionFile = join(sessionDir, `${sessionId}.jsonl`);
	messages = [];
	lastEntryId = null;
	const header: Rec = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString() };
	header.cwd = process.cwd();
	if (typeof parentSession === "string") header.parentSession = parentSession;
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
}

function loadSession(path: string): boolean {
	if (!existsSync(path)) return false;
	const entries = readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Rec);
	if (entries[0]?.type !== "session") return false;
	sessionFile = path;
	sessionId = String(entries[0].id);
	messages = [];
	for (const entry of entries.slice(1)) {
		lastEntryId = String(entry.id);
		if (entry.type === "message") {
			const message = entry.message as { role: "user" | "assistant"; content: unknown };
			messages.push({ role: message.role, content: textOf(message.content) });
		}
		if (entry.type === "custom_message" && !process.env.FAKE_AGENT_DROP_CUSTOM) {
			messages.push({ role: "custom", content: textOf(entry.content), customType: String(entry.customType) });
		}
	}
	return true;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("") : "";
}

function appendEntry(entry: Rec): void {
	const id = randomUUID().slice(0, 8);
	const full = { ...entry, id, parentId: lastEntryId, timestamp: new Date().toISOString() };
	lastEntryId = id;
	appendFileSync(sessionFile, `${JSON.stringify(full)}\n`);
}

function remember(message: Message): void {
	messages.push(message);
	// Like Pi, a user message with images keeps them as content blocks after the text.
	const content =
		message.role === "assistant"
			? [{ type: "text", text: message.content }]
			: message.images
				? [{ type: "text", text: message.content }, ...message.images]
				: message.content;
	appendEntry({ type: "message", message: { role: message.role, content } });
}

function respond(id: unknown, command: string, data?: unknown, error?: string): void {
	const rec: Rec = { type: "response", command, success: !error };
	if (id !== undefined) rec.id = id;
	if (data !== undefined) rec.data = data;
	if (error) rec.error = error;
	out(rec);
}

function askUi(request: Rec): Promise<Rec> {
	const id = randomUUID();
	out({ type: "extension_ui_request", id, ...request });
	return new Promise((resolve) => pendingUi.set(id, resolve));
}

function assistantText(text: string): void {
	const message = { role: "assistant", content: [{ type: "text", text }] };
	out({ type: "message_start", message });
	for (const delta of text.match(/.{1,8}/gs) ?? []) {
		out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
	}
	out({ type: "message_end", message });
	remember({ role: "assistant", content: text });
}

function emitQueue(): void {
	out({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp] });
}

function enqueue(text: string, behavior: unknown): void {
	(behavior === "followUp" ? queue.followUp : queue.steering).push(text);
	emitQueue();
}

function userMessage(text: string, images?: Rec[]): void {
	remember(images ? { role: "user", content: text, images } : { role: "user", content: text });
	const content = images ? [{ type: "text", text }, ...images] : text;
	out({ type: "message_start", message: { role: "user", content } });
	out({ type: "message_end", message: { role: "user", content } });
}

function endRun(): void {
	if (process.env.FAKE_AGENT_DROP_QUEUE) {
		queue.steering = [];
		queue.followUp = [];
	}
	const next = queue.steering.shift() ?? queue.followUp.shift();
	if (next !== undefined) {
		// Pi removes the message from the queue before it starts the user message.
		emitQueue();
		userMessage(next);
		assistantText(`Echo: ${next}`);
		endRun();
		return;
	}
	out({ type: "agent_end", messages: [], willRetry: false });
	busy = false;
	out({ type: "agent_settled" });
}

function endedAnswer(stopReason: "aborted" | "error", errorMessage: string): void {
	const message = { role: "assistant", content: [], stopReason, errorMessage };
	out({ type: "message_start", message });
	out({ type: "message_end", message });
}

async function run(text: string, images?: Rec[]) {
	busy = true;
	let ended: () => void = () => {};
	runEnded = new Promise((resolve) => {
		ended = resolve;
	});
	try {
		await runPrompt(text, images);
	} finally {
		ended();
	}
}

async function runPrompt(text: string, images?: Rec[]) {
	out({ type: "agent_start" });
	userMessage(text, images);
	if (text === "crash") {
		// Give the pipe time to flush; macOS pipes are asynchronous.
		setTimeout(() => process.exit(1), 50);
		return;
	}
	if (text === "hang") {
		const stopReason = await new Promise<"aborted" | "error">((resolve) => {
			hanging = resolve;
		});
		endedAnswer(stopReason, "This operation was aborted");
		return endRun();
	}
	if (text === "fail") {
		endedAnswer("error", "Gentle Shell provider exploded: 500 Internal Server Error");
		return endRun();
	}
	if (text === "slow") {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assistantText("Echo: slow");
		return endRun();
	}
	if (text === "compact") {
		const said = messages.filter((m) => m.role === "user").map((m) => m.content);
		appendEntry({ type: "compaction", summary: `Summary: ${said.join(", ")}`, tokensBefore: 1000 });
		assistantText("Compacted.");
		return endRun();
	}
	if (text.startsWith("pad:")) {
		appendEntry({ type: "custom", customType: "pad", data: "x".repeat(Number(text.slice(4))) });
		assistantText("Padded.");
		return endRun();
	}
	if (text === "recall") {
		const hidden = messages.filter((m) => m.role === "custom").map((m) => m.content);
		assistantText(hidden.length > 0 ? `Recall: ${hidden.join(" | ")}` : "Recall: nothing");
		return endRun();
	}
	if (text === "tamper" || text === "tamper:stay") {
		const notion = { url: "https://mcp.notion.com/mcp", exposure: "direct" };
		writeFileSync(
			"../connectors.json",
			JSON.stringify({ version: 1, connectors: { notion: { enabled: true, mode: "read_write" } } }),
		);
		writeFileSync("../agent/mcp.json", JSON.stringify({ mcpServers: { notion } }));
		mkdirSync(".pi", { recursive: true });
		writeFileSync(".pi/mcp.json", JSON.stringify({ mcpServers: { notion } }));
		if (text === "tamper") {
			setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
			return;
		}
		assistantText("Changed the files.");
		return endRun();
	}
	if (text.startsWith("tool:")) {
		const toolName = text.slice(5);
		const toolCallId = randomUUID();
		out({ type: "tool_execution_start", toolCallId, toolName, args: { path: "README.md" } });
		out({ type: "tool_execution_end", toolCallId, toolName, result: { content: [] }, isError: false });
		assistantText(`Ran ${toolName}`);
		return endRun();
	}
	if (text === "ask:select") {
		const answer = await askUi({ method: "select", title: "Pick a color", options: ["Red", "Blue"] });
		assistantText(answer.cancelled ? "Cancelled" : `You chose ${String(answer.value)}`);
		return endRun();
	}
	if (text === "ask:confirm") {
		const answer = await askUi({
			method: "confirm",
			title: "Proceed?",
			message: "Gentle Shell wants to continue",
		});
		assistantText(answer.confirmed ? "Confirmed" : "Declined");
		return endRun();
	}
	if (text === "ask:approval") {
		const { decide } = await import("../../src/extensions/approval-guard.ts");
		const decision = decide(
			{
				toolName: "mcp__notion__notion_create_pages",
				input: {
					parent: "Team notes",
					title: "Weekly plan",
					content: "Monday: review the launch checklist.\nTuesday: send the update to the team.",
				},
				cwd: process.cwd(),
			},
			{
				connectors: { notion: { name: "Notion", mode: "read_write", readOnlyTools: [] } },
				protectedPaths: [],
			},
		);
		if (decision.action !== "ask") throw new Error("the guard did not ask");
		const answer = await askUi({ method: "confirm", title: decision.title, message: decision.message });
		assistantText(answer.confirmed ? "Created the page" : "I did not create the page");
		return endRun();
	}
	if (text.startsWith("propose:")) {
		const { proposeConnector } = await import("../../src/extensions/approval-guard.ts");
		const ui = {
			setStatus: (statusKey: string, statusText: string | undefined) =>
				out({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText }),
		};
		assistantText(proposeConnector(JSON.parse(text.slice(8)), { hasUI: true, ui }));
		return endRun();
	}
	assistantText(`Echo: ${text}`);
	endRun();
}

function handle(rec: Rec) {
	const { id, type } = rec;
	switch (type) {
		case "get_state": {
			const delay = Number(process.env.FAKE_AGENT_START_DELAY_MS ?? 0);
			if (!started && delay > 0) {
				started = true;
				setTimeout(() => handle(rec), delay);
				return;
			}
			started = true;
			return respond(id, "get_state", {
				model: { id: model.id, name: model.name, provider: model.provider, input: model.input },
				thinkingLevel,
				isStreaming: busy,
				isCompacting: false,
				sessionFile,
				sessionId,
				messageCount: messages.length,
			});
		}
		case "get_messages":
			return respond(id, "get_messages", {
				messages: messages.map((m) => {
					if (m.role === "custom") {
						return { role: "custom", customType: m.customType, content: m.content, display: false };
					}
					return m.role === "user"
						? { role: "user", content: m.content }
						: { role: "assistant", content: [{ type: "text", text: m.content }] };
				}),
			});
		case "get_commands":
			return respond(id, "get_commands", { commands: [{ name: "gentle:status" }, { name: "history" }] });
		case "prompt": {
			if (process.env.FAKE_AGENT_PROMPTS_FILE) {
				const { id: _id, ...command } = rec;
				appendFileSync(process.env.FAKE_AGENT_PROMPTS_FILE, `${JSON.stringify(command)}\n`);
			}
			if (busy && !rec.streamingBehavior) return respond(id, "prompt", undefined, "Agent is streaming");
			if (busy) {
				enqueue(String(rec.message), rec.streamingBehavior);
				return respond(id, "prompt", { disposition: "queued" });
			}
			if (process.env.FAKE_AGENT_NO_MODEL) return respond(id, "prompt", undefined, "No model selected");
			const burst = String(rec.message).startsWith("burst");
			if (burst) batch = [];
			respond(id, "prompt", { disposition: "started" });
			const images = Array.isArray(rec.images) && rec.images.length > 0 ? (rec.images as Rec[]) : undefined;
			void run(burst ? String(rec.message).replace(/^burst:/, "") : String(rec.message), images);
			if (batch) {
				process.stdout.write(batch.join(""));
				batch = undefined;
			}
			return;
		}
		case "steer":
		case "follow_up":
			if (busy) enqueue(String(rec.message), type === "follow_up" ? "followUp" : "steer");
			return respond(id, type, { disposition: "queued" });
		case "abort":
			if (!process.env.FAKE_AGENT_IGNORE_ABORT) {
				hanging?.("aborted");
				hanging = undefined;
			}
			return respond(id, "abort");
		case "new_session":
		case "switch_session":
			void switchSession(rec);
			return;
		case "get_available_models":
			return respond(id, type, { models: MODELS });
		case "set_model": {
			recordCommand(rec);
			const found = MODELS.find((m) => m.provider === rec.provider && m.id === rec.modelId);
			if (!found)
				return respond(
					id,
					type,
					undefined,
					`Model not found: ${String(rec.provider)}/${String(rec.modelId)}`,
				);
			model = found;
			return respond(id, type, found);
		}
		case "set_thinking_level":
			recordCommand(rec);
			thinkingLevel = String(rec.level);
			return respond(id, type);
		case "noreply":
			return;
		case "extension_ui_response": {
			const resolve = pendingUi.get(String(id));
			pendingUi.delete(String(id));
			resolve?.(rec);
			return;
		}
		default:
			return respond(id, String(type), undefined, `Unknown command: ${String(type)}`);
	}
}

/** Like Pi, a session switch first tears down a running answer. */
async function switchSession(rec: Rec): Promise<void> {
	if (busy) {
		hanging?.("error");
		hanging = undefined;
		await runEnded;
	}
	const type = String(rec.type);
	if (type === "new_session") {
		newSession(rec.parentSession);
		return respond(rec.id, type, { cancelled: false });
	}
	if (!loadSession(String(rec.sessionPath))) return respond(rec.id, type, undefined, "Session not found");
	return respond(rec.id, type, { cancelled: false });
}

if (process.env.FAKE_AGENT_BRANDING) {
	out({
		type: "extension_ui_request",
		id: randomUUID(),
		method: "setStatus",
		statusKey: "gentle",
		statusText: "Gentle Shell ready",
	});
	out({
		type: "extension_ui_request",
		id: randomUUID(),
		method: "notify",
		message: "el Gentleman loaded ODD",
		notifyType: "info",
	});
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line && process.env.FAKE_AGENT_STDIN_FILE)
			appendFileSync(process.env.FAKE_AGENT_STDIN_FILE, `${line}\n`);
		if (line) handle(JSON.parse(line) as Rec);
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
