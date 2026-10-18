import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { DotBridge, isSizeLimitError } from "../src/bridge.ts";
import { DEFAULT_ROTATION } from "../src/rotation.ts";
import type {
	AgentRecord,
	AgentSupervisor,
	RpcResponse,
	SupervisorEvent,
	SupervisorState,
} from "../src/supervisor.ts";
import { UploadStore } from "../src/uploads.ts";
import { fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const ANSWER_FAILED = "Something went wrong while answering. Please try again.";

type Prompt = { message: string; images?: { type: "image"; mimeType: string; data: string }[] };
/** What one attempt of a prompt does: steps run in order, the last one ends the run. */
type Step = "ask" | "tool" | "result" | "answer" | "size" | "error" | "abort";

/**
 * The engine as the bridge sees it, with the parts this feature needs under the test's control:
 * real session files on disk, scripted attempts, and a chosen provider message per attempt.
 * Stands in for the fixture agent, which cannot fail with an oversized-request signature.
 */
class FakeEngine {
	state: SupervisorState = "ready";
	busy = false;
	sessionFile: string | undefined;
	sessionId = "fake";
	model = "fake-model";
	modelImages = true;
	/** Every prompt that reached the engine, in order. */
	readonly prompts: Prompt[] = [];
	/** The steps of each attempt of a user message, keyed by a prefix of its text. */
	readonly plan: Record<string, Step[][]> = {};
	/** The provider's message for a "size" step, and for a plain "error" step. */
	sizeError = "opencode-go API error (500): request entity too large";
	plainError = "opencode-go API error (500): 500 status code (no body)";
	/** Answer in one synchronous burst, like an engine writing a whole run in one write. */
	burst = false;
	/** Runs that finished, whether they answered or failed. */
	runs = 0;

	private readonly dir: string;
	private readonly attempts = new Map<string, number>();
	private readonly listeners = new Set<(event: SupervisorEvent) => void>();
	private readonly chains: Record<string, string[]> = {};

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(join(dir, "sessions"), { recursive: true });
		this.open(this.newFile());
	}

	get previousSessions(): string[] {
		const file = this.sessionFile;
		return (file ? this.chains[file] : undefined) ?? [];
	}

	onEvent(listener: (event: SupervisorEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	linkSessions(sessionFile: string, previous: string[]): void {
		this.chains[sessionFile] = previous;
	}

	send(): void {}

	async request(command: AgentRecord): Promise<RpcResponse> {
		const type = String(command.type);
		if (type === "prompt") {
			const prompt: Prompt = {
				message: String(command.message),
				...(Array.isArray(command.images) ? { images: command.images as Prompt["images"] } : {}),
			};
			this.prompts.push(prompt);
			this.append({ type: "message", message: { role: "user", content: contentOf(prompt) } });
			this.busy = true;
			if (this.burst) this.run(prompt);
			else setTimeout(() => this.run(prompt), 0);
			return this.response(type, { disposition: "started" });
		}
		return this.response(type, this.command(type, command));
	}

	private command(type: string, command: AgentRecord): unknown {
		switch (type) {
			case "get_state":
				return {
					sessionFile: this.sessionFile,
					sessionId: this.sessionId,
					model: { id: this.model, name: this.model, provider: "fake", input: ["text", "image"] },
					isStreaming: this.busy,
					isCompacting: false,
				};
			case "get_messages":
				return { messages: this.messages() };
			case "switch_session": {
				const path = String(command.sessionPath);
				if (!existsSync(path)) throw new Error("Session not found");
				this.open(path);
				return { cancelled: false };
			}
			case "new_session":
				this.open(
					this.newFile(typeof command.parentSession === "string" ? command.parentSession : undefined),
				);
				return { cancelled: false };
			default:
				return {};
		}
	}

	private run(prompt: Prompt): void {
		this.runs += 1;
		const content = contentOf(prompt);
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: { role: "user", content } });
		this.emit({ type: "message_end", message: { role: "user", content } });
		const attempt = (this.attempts.get(prompt.message) ?? 0) + 1;
		this.attempts.set(prompt.message, attempt);
		const script = scriptsFor(this.plan, prompt.message);
		for (const step of script[Math.min(attempt - 1, script.length - 1)] ?? ["answer"]) {
			if (step === "ask") {
				this.emit({
					type: "extension_ui_request",
					id: `ask-${randomUUID()}`,
					method: "select",
					title: "Pick a color",
					options: ["Red"],
				});
				continue;
			}
			if (step === "tool") {
				const toolCallId = `t${attempt}`;
				this.emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } });
				this.emit({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: false });
				continue;
			}
			if (step === "result") {
				// A tool result the engine reports as a message of its own, without an execution event.
				const result = { role: "toolResult", toolCallId: `r${attempt}`, toolName: "bash", content: [] };
				this.emit({ type: "message_start", message: result });
				this.emit({ type: "message_end", message: result });
				continue;
			}
			if (step === "answer") {
				const text = `Echo: ${prompt.message}`;
				const answer = { role: "assistant", content: [{ type: "text", text }] };
				this.emit({ type: "message_start", message: answer });
				this.emit({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
				});
				this.emit({ type: "message_end", message: answer });
				this.append({ type: "message", message: answer });
				break;
			}
			const stopReason = step === "abort" ? "aborted" : "error";
			const errorMessage =
				step === "abort" ? "This operation was aborted" : step === "size" ? this.sizeError : this.plainError;
			const failed = { role: "assistant", content: [], stopReason, errorMessage };
			this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
			this.emit({ type: "message_end", message: failed });
			this.append({ type: "message", message: failed });
			break;
		}
		this.emit({ type: "agent_end", messages: [], willRetry: false });
		this.busy = false;
		this.emit({ type: "agent_settled" });
	}

	private messages(): Record<string, unknown>[] {
		if (!this.sessionFile) return [];
		return this.entries(this.sessionFile).flatMap((entry) => {
			if (entry.type === "message") return [entry.message as Record<string, unknown>];
			if (entry.type === "custom_message") {
				return [{ role: "custom", customType: entry.customType, content: entry.content, display: false }];
			}
			return [];
		});
	}

	private entries(file: string): Record<string, unknown>[] {
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	private append(entry: Record<string, unknown>): void {
		const full = {
			...entry,
			id: randomUUID().slice(0, 8),
			parentId: null,
			timestamp: new Date().toISOString(),
		};
		appendFileSync(this.sessionFile as string, `${JSON.stringify(full)}\n`);
	}

	private newFile(parentSession?: string): string {
		const file = join(this.dir, "sessions", `${randomUUID()}.jsonl`);
		const header: Record<string, unknown> = {
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: this.dir,
		};
		if (parentSession) header.parentSession = parentSession;
		writeFileSync(file, `${JSON.stringify(header)}\n`);
		return file;
	}

	private open(file: string): void {
		this.sessionFile = file;
		this.sessionId = file;
	}

	private response(command: string, data?: unknown): RpcResponse {
		return { type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
	}

	private emit(event: SupervisorEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

const contentOf = (prompt: Prompt) =>
	prompt.images && prompt.images.length > 0
		? [{ type: "text", text: prompt.message }, ...prompt.images]
		: prompt.message;

const scriptsFor = (plan: Record<string, Step[][]>, message: string): Step[][] => {
	for (const [prefix, script] of Object.entries(plan)) if (message.startsWith(prefix)) return script;
	return [["answer"]];
};

function setup() {
	const dir = tempDir();
	const engine = new FakeEngine(dir);
	const logs: string[] = [];
	const uploads = new UploadStore({
		workspace: join(dir, "workspace"),
		limits: { fileBytes: 4_000_000, messageBytes: 8_000_000, files: 10 },
	});
	const bridge = new DotBridge(engine as unknown as AgentSupervisor, {
		dataDir: dir,
		log: (line) => logs.push(line),
		rotation: DEFAULT_ROTATION,
		uploads,
	});
	const received: ServerPayload[] = [];
	const client = { send: (payload: ServerPayload) => received.push(payload) };
	bridge.attach(client);
	return { dir, engine, logs, uploads, bridge, client, received };
}

type Setup = ReturnType<typeof setup>;

const errors = (received: ServerPayload[]) =>
	received.flatMap((p) =>
		p.type === "message_done" && p.error !== undefined ? [{ id: p.messageId, error: p.error }] : [],
	);

const userMessages = (received: ServerPayload[]) =>
	received.flatMap((p) => (p.type === "user_message" ? [p.text] : []));

/** The chat a window holds after applying the payloads it received, like the app's store does. */
function windowMessages(received: ServerPayload[]): { role: string; text: string; error?: string }[] {
	let shown: { role: string; text: string; error?: string }[] = [];
	for (const payload of received) {
		if (payload.type === "history") shown = payload.messages.map((m) => ({ role: m.role, text: m.text }));
		else if (payload.type === "user_message") shown.push({ role: "user", text: payload.text });
		else if (payload.type === "message_done") {
			shown.push({
				role: "assistant",
				text: payload.text,
				...(payload.error !== undefined ? { error: payload.error } : {}),
			});
		}
	}
	return shown;
}

/** Sends one message and waits until its turn (and anything the daemon did about it) finished. */
async function send({ bridge, client, engine, received }: Setup, text: string) {
	const runs = engine.runs;
	const done = received.filter((p) => p.type === "message_done").length;
	await bridge.handle(client, { type: "send", text });
	await waitFor(() => engine.runs > runs);
	await waitFor(() => received.filter((p) => p.type === "message_done").length > done);
	await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("size signature", () => {
	it("recognises the ways a provider says the request itself was too large", () => {
		for (const message of [
			"opencode-go API error (413): request entity too large",
			"Request Entity Too Large",
			"413 status code (no body)",
			"API error (500): payload too large",
			"API error (422): the request body is too large",
			"Invalid request: the prompt is too large",
			"maximum context length is 128000 tokens",
			"prompt is too long: 250000 tokens > 200000 maximum",
			"context_length_exceeded",
			"input token count exceeds the maximum",
			"Error 500: request size (12582912 bytes) exceeds the maximum",
			"too many tokens in the conversation",
		]) {
			expect(isSizeLimitError(message), message).toBe(true);
		}
	});

	it("never fires on a network, auth, rate limit, or plain provider failure", () => {
		for (const message of [
			"opencode-go API error (500): 500 status code (no body)",
			"500 Internal Server Error",
			"503 Service Unavailable",
			"fetch failed: ECONNRESET",
			"getaddrinfo ENOTFOUND api.example.com",
			"401 Unauthorized: invalid API key",
			"429 Too Many Requests: rate limit exceeded",
			"context deadline exceeded",
			"This operation was aborted",
			"",
		]) {
			expect(isSizeLimitError(message), message).toBe(false);
		}
		expect(isSizeLimitError(undefined)).toBe(false);
	});
});

describe("recovering from a refused request", () => {
	it("rotates once and re-sends the same message and images, and the window never sees the failure", async () => {
		const test = setup();
		const { engine, bridge, client, received, uploads } = test;
		engine.plan.big = [["size"], ["answer"]];
		const stored = await uploads.receive(Readable.from([PNG]), { name: "shot.png" });
		if (!stored.ok) throw new Error(stored.message);
		const first = engine.sessionFile as string;

		await bridge.handle(client, {
			type: "send",
			text: "big",
			attachments: [{ uploadId: stored.file.uploadId, name: stored.file.name }],
		});
		await waitFor(() => engine.prompts.length === 2);
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: big")));

		// The same prompt went out again, images included.
		expect(engine.prompts[0]?.images?.[0]).toEqual({
			type: "image",
			mimeType: "image/png",
			data: PNG.toString("base64"),
		});
		expect(engine.prompts[1]).toEqual(engine.prompts[0]);
		// One rotation, and the previous session stays in the chain.
		expect(engine.previousSessions).toEqual([first]);
		expect(engine.sessionFile).not.toBe(first);
		// The window never heard about the failure, while the daemon logged it.
		expect(errors(received)).toEqual([]);
		expect(received.filter((p) => p.type === "error")).toEqual([]);
		expect(test.logs.filter((line) => line.includes("assistant error:"))).toHaveLength(1);
		expect(test.logs.some((line) => line.includes("rotation:"))).toBe(true);
		// One user message, then the answer.
		expect(userMessages(received)).toEqual(["big"]);
		const shown = windowMessages(received);
		expect(shown.filter((m) => m.role === "user" && m.text === "big")).toHaveLength(1);
		expect(shown.at(-1)).toMatchObject({ role: "assistant", text: expect.stringContaining("Echo: big") });
	});

	it("recovers the same way when the whole run arrives in one burst", async () => {
		const { engine, bridge, client, received } = setup();
		engine.burst = true;
		engine.plan.big = [["size"], ["answer"]];

		await bridge.handle(client, { type: "send", text: "big" });
		await waitFor(() => engine.prompts.length === 2);
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: big")));
		expect(errors(received)).toEqual([]);
		expect(userMessages(received)).toEqual(["big"]);
		expect(engine.previousSessions).toHaveLength(1);
	});

	it("shows the real error without retrying when a tool ran in the failed turn", async () => {
		for (const tool of ["tool", "result"] as Step[]) {
			const { engine, bridge, client, received } = setup();
			engine.plan["run a tool"] = [[tool, "size"]];
			const first = engine.sessionFile as string;

			await bridge.handle(client, { type: "send", text: "run a tool" });
			await waitFor(() => errors(received).length > 0);
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(errors(received), tool).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
			expect(engine.prompts, tool).toHaveLength(1);
			expect(engine.sessionFile, tool).toBe(first);
			expect(engine.previousSessions, tool).toEqual([]);
		}
	});

	it("shows the real error without retrying when the failure is not about size", async () => {
		for (const plainError of [
			"opencode-go API error (500): 500 status code (no body)",
			"fetch failed: ECONNRESET",
			"401 Unauthorized: invalid API key",
		]) {
			const { engine, bridge, client, received } = setup();
			engine.plainError = plainError;
			engine.plan.plain = [["error"]];
			const first = engine.sessionFile as string;

			await bridge.handle(client, { type: "send", text: "plain" });
			await waitFor(() => errors(received).length > 0);
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(errors(received), plainError).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
			expect(engine.prompts, plainError).toHaveLength(1);
			expect(engine.sessionFile, plainError).toBe(first);
		}
	});

	it("shows the real error when the re-sent attempt fails too, and never retries twice", async () => {
		const { engine, bridge, client, received } = setup();
		engine.plan.big = [["size"], ["size"]];

		await bridge.handle(client, { type: "send", text: "big" });
		await waitFor(() => errors(received).length > 0);
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(errors(received)).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
		expect(engine.prompts).toHaveLength(2);
		expect(engine.runs).toBe(2);
		expect(engine.previousSessions).toHaveLength(1);
	});

	it("shows the real error instead of waiting when the chat cannot rotate", async () => {
		const { engine, bridge, client, received } = setup();
		engine.plan["asks first"] = [["ask", "size"]];

		await bridge.handle(client, { type: "send", text: "asks first" });
		await waitFor(() => errors(received).length > 0);
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(errors(received)).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
		expect(engine.prompts).toHaveLength(1);
		expect(engine.previousSessions).toEqual([]);
		// The question stays open; nothing was stalled behind it.
		const ask = received.find((p): p is Extract<ServerPayload, { type: "ask" }> => p.type === "ask");
		expect(ask).toBeDefined();
		await bridge.handle(client, {
			type: "ui_response",
			requestId: ask?.ask.requestId as string,
			cancelled: true,
		});
	});

	it("allows one recovery per user message, and a new message gets its own", async () => {
		const test = setup();
		const { engine, received } = test;
		engine.plan.first = [["size"], ["answer"]];
		engine.plan.second = [["size"], ["answer"]];
		engine.plan.third = [["size"], ["size"]];

		await send(test, "first");
		expect(errors(received)).toEqual([]);
		expect(engine.previousSessions).toHaveLength(1);

		await send(test, "second");
		expect(errors(received)).toEqual([]);
		expect(engine.previousSessions).toHaveLength(2);

		await send(test, "third");
		expect(errors(received)).toHaveLength(1);
		expect(engine.previousSessions).toHaveLength(3);
		expect(engine.runs).toBe(6);
		expect(userMessages(received)).toEqual(["first", "second", "third"]);
	});

	it("leaves a stopped answer untouched", async () => {
		const { engine, bridge, client, received } = setup();
		engine.plan.hang = [["abort"]];

		await bridge.handle(client, { type: "send", text: "hang" });
		await waitFor(() => received.some((p) => p.type === "message_done" && p.stopped === true));
		expect(received.filter((p) => p.type === "message_done" && p.error !== undefined)).toEqual([]);
		expect(engine.prompts).toHaveLength(1);
		expect(engine.previousSessions).toEqual([]);
	});
});

describe("the real engine, unchanged", () => {
	it("still shows the window's error for a provider failure that is not about size", async () => {
		const dataDir = tempDir();
		const prompts = join(dataDir, "prompts.jsonl");
		const { supervisor } = fakeSupervisor({
			dataDir,
			env: { ...process.env, FAKE_AGENT_PROMPTS_FILE: prompts },
		});
		const bridge = new DotBridge(supervisor, { dataDir, log: () => {}, rotation: DEFAULT_ROTATION });
		const received: ServerPayload[] = [];
		const client = { send: (payload: ServerPayload) => received.push(payload) };
		bridge.attach(client);
		await supervisor.start();
		try {
			await bridge.handle(client, { type: "send", text: "fail" });
			const failed = await waitFor(() =>
				received.find(
					(p): p is Extract<ServerPayload, { type: "message_done" }> =>
						p.type === "message_done" && p.error !== undefined,
				),
			);
			expect(failed.error).toBe(ANSWER_FAILED);
			const session = supervisor.sessionFile as string;
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(supervisor.sessionFile).toBe(session);
			expect(readFileSync(prompts, "utf8").trim().split("\n")).toHaveLength(1);
		} finally {
			await supervisor.stop();
		}
	});
});
