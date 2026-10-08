#!/usr/bin/env node
// A deterministic stand-in for `gentle-shell --mode rpc`. It speaks the same JSONL
// records the daemon relies on, persists messages per session file, and has
// scripted prompts for tests:
//   "tool:<name>"  runs one fake tool call
//   "ask:select"   asks a select dialog and echoes the answer
//   "ask:confirm"  asks a confirm dialog and echoes the answer
//   "hang"         starts a run that only ends on abort (an aborted answer), or on a
//                  session switch (Pi then ends it with an error: "This operation was aborted")
//   "fail"         the provider fails: an answer that ends with stopReason "error"
//   "slow"         answers after 1.5 s, leaving time to queue messages
//   "crash"        starts a run and exits with code 1
//   "burst"        answers and finishes the run in a single stdout write
// The "noreply" command is never answered.
// A prompt sent while busy (with streamingBehavior), steer, and follow_up are
// queued like Pi does: a queue_update with both complete queues, then each one
// is taken when the run would end (queue_update, user message_start, echo).
// Environment:
//   FAKE_AGENT_ARGS_FILE  write argv as JSON to this file
//   FAKE_AGENT_BRANDING   emit branded startup UI records
//   FAKE_AGENT_ENV_FILE   write selected environment variables as JSON to this file
//   FAKE_AGENT_COMMANDS_FILE  append every model command (set_model, set_thinking_level) as JSONL
//   FAKE_AGENT_NO_MODEL   refuse every prompt, like an engine with no signed-in account
//   FAKE_AGENT_DROP_QUEUE settle without taking or reporting queued messages
//   FAKE_AGENT_IGNORE_ABORT  answer abort but keep running (a session switch still ends the run)
//   FAKE_AGENT_START_DELAY_MS  answer the first get_state only after this delay
// get_available_models lists MODELS; set_model and set_thinking_level change what
// get_state reports, so tests can read the last values back.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Rec = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: string };

const MODELS: Rec[] = [
	{
		id: "fake-model",
		name: "Fake Model",
		provider: "fake",
		reasoning: true,
		// Real models may carry credentials in headers; they must never reach a client.
		headers: { Authorization: "Bearer fake-secret-header" },
		baseUrl: "https://internal.fake.example",
		cost: { input: 1, output: 2 },
	},
	{ id: "fake-fast", name: "Fake Fast", provider: "fake", reasoning: false },
	{ id: "big", name: "Other Big", provider: "other", reasoning: true },
];
let model = MODELS[0] as Rec;
let thinkingLevel = "medium";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGENT_ARGS_FILE) writeFileSync(process.env.FAKE_AGENT_ARGS_FILE, JSON.stringify(argv));
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
				].map((key) => [key, process.env[key]]),
			),
		),
	);
}
const sessionDir = argValue("--session-dir") ?? join(process.cwd(), ".fake-sessions");
mkdirSync(sessionDir, { recursive: true });

let sessionId = "";
let sessionFile = "";
let messages: Message[] = [];
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

function newSession(): void {
	sessionId = randomUUID();
	sessionFile = join(sessionDir, `${sessionId}.jsonl`);
	messages = [];
	writeFileSync(sessionFile, "");
}

function loadSession(path: string): boolean {
	if (!existsSync(path)) return false;
	sessionFile = path;
	sessionId =
		path
			.split("/")
			.pop()
			?.replace(/\.jsonl$/, "") ?? "";
	messages = readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Message);
	return true;
}

function remember(message: Message): void {
	messages.push(message);
	appendFileSync(sessionFile, `${JSON.stringify(message)}\n`);
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

function userMessage(text: string): void {
	remember({ role: "user", content: text });
	out({ type: "message_start", message: { role: "user", content: text } });
	out({ type: "message_end", message: { role: "user", content: text } });
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

async function run(text: string) {
	busy = true;
	let ended: () => void = () => {};
	runEnded = new Promise((resolve) => {
		ended = resolve;
	});
	try {
		await runPrompt(text);
	} finally {
		ended();
	}
}

async function runPrompt(text: string) {
	out({ type: "agent_start" });
	userMessage(text);
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
				model: { id: model.id, name: model.name, provider: model.provider },
				thinkingLevel,
				isStreaming: busy,
				sessionFile,
				sessionId,
				messageCount: messages.length,
			});
		}
		case "get_messages":
			return respond(id, "get_messages", {
				messages: messages.map((m) =>
					m.role === "user"
						? { role: "user", content: m.content }
						: { role: "assistant", content: [{ type: "text", text: m.content }] },
				),
			});
		case "get_commands":
			return respond(id, "get_commands", { commands: [{ name: "gentle:status" }, { name: "history" }] });
		case "prompt": {
			if (busy && !rec.streamingBehavior) return respond(id, "prompt", undefined, "Agent is streaming");
			if (busy) {
				enqueue(String(rec.message), rec.streamingBehavior);
				return respond(id, "prompt", { disposition: "queued" });
			}
			if (process.env.FAKE_AGENT_NO_MODEL) return respond(id, "prompt", undefined, "No model selected");
			if (rec.message === "burst") batch = [];
			respond(id, "prompt", { disposition: "started" });
			void run(String(rec.message));
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
		newSession();
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
		if (line) handle(JSON.parse(line) as Rec);
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
