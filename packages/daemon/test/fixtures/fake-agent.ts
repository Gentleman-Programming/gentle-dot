#!/usr/bin/env node
// A deterministic stand-in for `gentle-shell --mode rpc`. It speaks the same JSONL
// records the daemon relies on, persists messages per session file, and has
// scripted prompts for tests:
//   "tool:<name>"  runs one fake tool call
//   "ask:select"   asks a select dialog and echoes the answer
//   "ask:confirm"  asks a confirm dialog and echoes the answer
//   "hang"         starts a run that only ends on abort
//   "crash"        starts a run and exits with code 1
// The "noreply" command is never answered.
// Environment:
//   FAKE_AGENT_ARGS_FILE  write argv as JSON to this file
//   FAKE_AGENT_BRANDING   emit branded startup UI records
//   FAKE_AGENT_ENV_FILE   write selected environment variables as JSON to this file
//   FAKE_AGENT_COMMANDS_FILE  append every model command (set_model, set_thinking_level) as JSONL
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
		JSON.stringify({ GENTLE_PI_CONFIG_HOME: process.env.GENTLE_PI_CONFIG_HOME }),
	);
}
const sessionDir = argValue("--session-dir") ?? join(process.cwd(), ".fake-sessions");
mkdirSync(sessionDir, { recursive: true });

let sessionId = "";
let sessionFile = "";
let messages: Message[] = [];
let busy = false;
let hanging: (() => void) | undefined;
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
	process.stdout.write(`${JSON.stringify(rec)}\n`);
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

function endRun(): void {
	out({ type: "agent_end", messages: [], willRetry: false });
	busy = false;
	out({ type: "agent_settled" });
}

async function run(text: string) {
	busy = true;
	remember({ role: "user", content: text });
	out({ type: "agent_start" });
	out({ type: "message_start", message: { role: "user", content: text } });
	out({ type: "message_end", message: { role: "user", content: text } });
	if (text === "crash") {
		// Give the pipe time to flush; macOS pipes are asynchronous.
		setTimeout(() => process.exit(1), 50);
		return;
	}
	if (text === "hang") {
		await new Promise<void>((resolve) => {
			hanging = resolve;
		});
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
		case "get_state":
			return respond(id, "get_state", {
				model: { id: model.id, name: model.name, provider: model.provider },
				thinkingLevel,
				isStreaming: busy,
				sessionFile,
				sessionId,
				messageCount: messages.length,
			});
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
			if (busy) return respond(id, "prompt", { disposition: "queued" });
			respond(id, "prompt", { disposition: "started" });
			void run(String(rec.message));
			return;
		}
		case "steer":
		case "follow_up":
			return respond(id, type, { disposition: "queued" });
		case "abort":
			hanging?.();
			hanging = undefined;
			return respond(id, "abort");
		case "new_session":
			newSession();
			return respond(id, "new_session", { cancelled: false });
		case "switch_session":
			if (!loadSession(String(rec.sessionPath))) {
				return respond(id, "switch_session", undefined, "Session not found");
			}
			return respond(id, "switch_session", { cancelled: false });
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
