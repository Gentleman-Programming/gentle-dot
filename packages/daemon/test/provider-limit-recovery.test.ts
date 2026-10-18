import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DotBridge,
	isSizeLimitError,
	pendingRecoveryFile,
	readPendingRecovery,
	recoveryFloorBytes,
} from "../src/bridge.ts";
import { DEFAULT_REQUEST_BUDGET, REQUEST_BUDGET_ENV } from "../src/extensions/screenshot-context.ts";
import { CEILING_MARGIN, LIMITS_FILE_ENV, limitsFile, readLimits } from "../src/limits.ts";
import { DEFAULT_ROTATION } from "../src/rotation.ts";
import type {
	AgentRecord,
	AgentSupervisor,
	RpcResponse,
	SupervisorEvent,
	SupervisorState,
} from "../src/supervisor.ts";
import { MAX_IMAGE_BYTES, UploadStore } from "../src/uploads.ts";
import { fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const ANSWER_FAILED = "Something went wrong while answering. Please try again.";
/** The wording the incident that motivated this feature carried: no size anywhere in it. */
const INCIDENT = "opencode-go API error (500): 500 status code (no body)";
afterEach(() => vi.unstubAllEnvs());

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

/**
 * Grows the live session the way a long chat with images does, without adding a message to it:
 * only `type: "message"` entries become turns, so the pad changes the file's size and nothing else.
 */
function grow(engine: FakeEngine, bytes: number): void {
	appendFileSync(
		engine.sessionFile as string,
		`${JSON.stringify({ type: "pad", data: "x".repeat(bytes) })}\n`,
	);
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
		for (const plainError of ["fetch failed: ECONNRESET", "401 Unauthorized: invalid API key"]) {
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

	it("shows the re-sent question once when the whole chain is read again", async () => {
		const test = setup();
		const { engine, bridge, client, received } = test;
		engine.plan.keep = [["answer"]];
		engine.plan.big = [["size"], ["answer"]];
		await send(test, "keep");
		const first = engine.sessionFile as string;

		await send(test, "big");

		// The window saw the question once and never the failure; the previous session stays in the chain.
		expect(userMessages(received)).toEqual(["keep", "big"]);
		expect(errors(received)).toEqual([]);
		expect(engine.previousSessions).toEqual([first]);

		// A cold reload pages the whole chain: the refused turn shows once, and every other turn stays.
		const start = received.length;
		await bridge.handle(client, { type: "get_history" });
		const history = received
			.slice(start)
			.find((p): p is Extract<ServerPayload, { type: "history" }> => p.type === "history");
		expect(history?.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
			"user:keep",
			"assistant:Echo: keep",
			"user:big",
			"assistant:Echo: big",
		]);
		expect(history?.messages.filter((m) => m.role === "user" && m.text === "big")).toHaveLength(1);
	});
});

describe("the recovery floor", () => {
	it("is half the request budget, read from the setting the request rewriter uses", () => {
		expect(recoveryFloorBytes({})).toBe(DEFAULT_REQUEST_BUDGET / 2);
		expect(recoveryFloorBytes({ [REQUEST_BUDGET_ENV]: "20000" })).toBe(10_000);
		for (const bad of ["", "0", "-5", "lots"]) {
			expect(recoveryFloorBytes({ [REQUEST_BUDGET_ENV]: bad })).toBe(DEFAULT_REQUEST_BUDGET / 2);
		}
	});
});

describe("a refusal the provider does not name", () => {
	it("recovers the observed incident on a large conversation", async () => {
		// A small budget keeps the test's session small; the floor is half of it, as in production.
		vi.stubEnv(REQUEST_BUDGET_ENV, "20000");
		const test = setup();
		const { engine, bridge, client, received } = test;
		engine.plainError = INCIDENT;
		engine.plan.keep = [["answer"]];
		engine.plan.big = [["error"], ["answer"]];
		await send(test, "keep");
		grow(engine, 12_000);
		const first = engine.sessionFile as string;

		await send(test, "big");
		const onDisk = readFileSync(first, "utf8");

		// The retry is the discriminator: it answered, so the refusal was size, and the window is clean.
		expect(errors(received)).toEqual([]);
		expect(engine.prompts).toHaveLength(3);
		expect(engine.previousSessions).toEqual([first]);
		expect(userMessages(received)).toEqual(["keep", "big"]);

		const start = received.length;
		await bridge.handle(client, { type: "get_history" });
		const history = received
			.slice(start)
			.find((p): p is Extract<ServerPayload, { type: "history" }> => p.type === "history");
		expect(history?.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
			"user:keep",
			"assistant:Echo: keep",
			"user:big",
			"assistant:Echo: big",
		]);
		// Nothing on disk was deleted or rewritten by the history read.
		expect(readFileSync(first, "utf8")).toBe(onDisk);
	});

	it("shows the real error on a large conversation when the retry fails too", async () => {
		vi.stubEnv(REQUEST_BUDGET_ENV, "20000");
		const test = setup();
		const { engine, received } = test;
		engine.plainError = INCIDENT;
		engine.plan.big = [["error"], ["error"]];
		grow(engine, 12_000);

		await send(test, "big");

		// An outage is never hidden: one extra attempt, then the real failure.
		expect(errors(received)).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
		expect(engine.prompts).toHaveLength(2);
		expect(engine.runs).toBe(2);
		expect(engine.previousSessions).toHaveLength(1);
	});

	it("shows the real error immediately when the conversation is small", async () => {
		const { engine, bridge, client, received } = setup();
		engine.plainError = INCIDENT;
		engine.plan.plain = [["error"]];
		const first = engine.sessionFile as string;

		await bridge.handle(client, { type: "send", text: "plain" });
		await waitFor(() => errors(received).length > 0);
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(errors(received)).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
		expect(engine.prompts).toHaveLength(1);
		expect(engine.sessionFile).toBe(first);
		expect(engine.previousSessions).toEqual([]);
	});

	it("keeps the size signatures: a refusal that names the size recovers however small the chat is", async () => {
		const test = setup();
		const { engine, received } = test;
		engine.sizeError = "opencode-go API error (413): request entity too large";
		engine.plan.big = [["size"], ["answer"]];

		await send(test, "big");

		expect(errors(received)).toEqual([]);
		expect(engine.prompts).toHaveLength(2);
		expect(engine.previousSessions).toHaveLength(1);
	});
});

describe("recovery while another message arrives", () => {
	it("does not re-send a newer message when a stale failure lands during the recovery window", async () => {
		const test = setup();
		const { engine, bridge, client } = test;
		engine.plan.big = [["size"], ["size"]];
		engine.plan.other = [["answer"]];

		const origRequest = engine.request.bind(engine);
		let releaseSwitch: () => void = () => {};
		const switchGate = new Promise<void>((resolve) => {
			releaseSwitch = resolve;
		});
		let switchGated = false;
		let otherRequested = false;
		let releaseOther: () => void = () => {};
		const otherGate = new Promise<void>((resolve) => {
			releaseOther = resolve;
		});

		engine.request = async (command: AgentRecord) => {
			if (String(command.type) === "switch_session" && !switchGated) {
				switchGated = true;
				await switchGate;
			}
			if (String(command.type) === "prompt" && String(command.message) === "other") {
				otherRequested = true;
				await otherGate;
			}
			return origRequest(command);
		};

		void bridge.handle(client, { type: "send", text: "big" });
		await waitFor(() => switchGated);
		const otherSend = bridge.handle(client, { type: "send", text: "other" });
		await waitFor(() => otherRequested);
		releaseSwitch();
		await waitFor(() => engine.prompts.filter((p) => p.message === "big").length >= 2);
		releaseOther();
		await otherSend;
		await new Promise((resolve) => setTimeout(resolve, 250));

		const prompts = engine.prompts.map((p) => p.message);
		expect(
			prompts.filter((m) => m === "other"),
			"the user's newer message must reach the provider once",
		).toHaveLength(1);
	});

	/** Holds the rotation's session switch until released, like a slow rotation. */
	function holdRotation(engine: FakeEngine) {
		const original = engine.request.bind(engine);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		engine.request = async (command: AgentRecord) => {
			if (String(command.type) === "switch_session" && !held) {
				held = true;
				await gate;
			}
			return original(command);
		};
		return { release: () => release(), held: () => held };
	}

	/** Holds the prompt whose text is `text` until released, like a request still on its way. */
	function holdPrompt(engine: FakeEngine, text: string) {
		const original = engine.request.bind(engine);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		engine.request = async (command: AgentRecord) => {
			if (String(command.type) === "prompt" && String(command.message) === text && !held) {
				held = true;
				await gate;
			}
			return original(command);
		};
		return { release: () => release(), held: () => held };
	}

	it("re-sends exactly the refused prompt, images included, never the newer one", async () => {
		const test = setup();
		const { engine, bridge, client, received, uploads } = test;
		engine.plan.big = [["size"], ["answer"]];
		engine.plan.other = [["answer"]];
		const stored = await uploads.receive(Readable.from([PNG]), { name: "shot.png" });
		if (!stored.ok) throw new Error(stored.message);
		const rotation = holdRotation(engine);
		const pendingOther = holdPrompt(engine, "other");

		void bridge.handle(client, {
			type: "send",
			text: "big",
			attachments: [{ uploadId: stored.file.uploadId, name: stored.file.name }],
		});
		await waitFor(() => rotation.held());
		const otherSend = bridge.handle(client, { type: "send", text: "other" });
		await waitFor(() => pendingOther.held());
		rotation.release();
		await waitFor(() => engine.prompts.filter((p) => p.message.startsWith("big")).length === 2);
		pendingOther.release();
		await otherSend;
		await new Promise((resolve) => setTimeout(resolve, 60));

		// The refused prompt went out again exactly as it was; the newer message never did.
		expect(engine.prompts[1]).toEqual(engine.prompts[0]);
		expect(engine.prompts[1]?.message).toBe(engine.prompts[0]?.message);
		expect(engine.prompts[1]?.images?.[0]).toEqual({
			type: "image",
			mimeType: "image/png",
			data: PNG.toString("base64"),
		});
		expect(engine.prompts.filter((p) => p.message === "other")).toHaveLength(1);
		// The re-sent question is not shown twice, and the newer message is its own turn.
		expect(userMessages(received)).toEqual(["big", "other"]);
	});

	it("decides the newer message's own failure instead of inheriting the older recovery", async () => {
		const test = setup();
		const { engine, bridge, client, received } = test;
		engine.plan.big = [["size"], ["size"]];
		engine.plan.other = [["size"], ["answer"]];
		const rotation = holdRotation(engine);
		const pendingOther = holdPrompt(engine, "other");

		void bridge.handle(client, { type: "send", text: "big" });
		await waitFor(() => rotation.held());
		const otherSend = bridge.handle(client, { type: "send", text: "other" });
		await waitFor(() => pendingOther.held());
		rotation.release();
		// The older prompt's second failure is the real one and is shown while the newer one waits.
		await waitFor(() => errors(received).length === 1);
		pendingOther.release();
		await otherSend;
		await waitFor(() => engine.prompts.filter((p) => p.message === "other").length === 2);
		await new Promise((resolve) => setTimeout(resolve, 60));

		// The newer message got its own recovery: it was re-sent once and its answer is shown.
		expect(engine.prompts.map((p) => p.message)).toEqual(["big", "big", "other", "other"]);
		expect(errors(received)).toEqual([{ id: expect.any(String), error: ANSWER_FAILED }]);
		expect(userMessages(received)).toEqual(["big", "other"]);
		expect(received.some((p) => p.type === "message_done" && p.text.includes("Echo: other"))).toBe(true);
	});
});

describe("attachments left out of a message (T8)", () => {
	it("tells the user which attachments were left out and why, and still sends the ones that fit", async () => {
		vi.stubEnv(REQUEST_BUDGET_ENV, "20000"); // Half of it is the message's image budget.
		const test = setup();
		const { engine, bridge, client, received, uploads } = test;
		engine.plan.look = [["answer"]];
		const bytes = Buffer.concat([PNG, Buffer.alloc(7000)]);
		const a = await uploads.receive(Readable.from([bytes]), { name: "a.png" });
		const b = await uploads.receive(Readable.from([bytes]), { name: "b.png" });
		if (!a.ok || !b.ok) throw new Error("the test's upload failed");

		await bridge.handle(client, {
			type: "send",
			text: "look",
			attachments: [
				{ uploadId: a.file.uploadId, name: a.file.name },
				{ uploadId: b.file.uploadId, name: b.file.name },
			],
		});
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: look")));

		// The window is told exactly which attachment was left out and why, in one warning.
		expect(received.filter((p) => p.type === "toast")).toEqual([
			{
				type: "toast",
				level: "warning",
				message: expect.stringContaining("b.png"),
			},
		]);
		// The message itself still went out, carrying the image that fit.
		expect(engine.prompts[0]?.images).toHaveLength(1);
	});

	it("tells the user when one image is larger than a single attachment may be", async () => {
		const test = setup();
		const { engine, bridge, client, received, uploads } = test;
		engine.plan.look = [["answer"]];
		const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
		const stored = await uploads.receive(Readable.from([huge]), { name: "huge.png" });
		if (!stored.ok) throw new Error("the test's upload failed");

		await bridge.handle(client, {
			type: "send",
			text: "look",
			attachments: [{ uploadId: stored.file.uploadId, name: stored.file.name }],
		});
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: look")));

		expect(received.filter((p) => p.type === "toast")).toEqual([
			{
				type: "toast",
				level: "warning",
				message: expect.stringContaining("huge.png"),
			},
		]);
		expect(engine.prompts[0]?.images).toBeUndefined();
	});

	it("says nothing when no attachment was left out", async () => {
		const test = setup();
		const { engine, bridge, client, received, uploads } = test;
		engine.plan.look = [["answer"]];
		const stored = await uploads.receive(Readable.from([PNG]), { name: "a.png" });
		if (!stored.ok) throw new Error("the test's upload failed");

		await bridge.handle(client, { type: "send", text: "plain" });
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: plain")));
		await bridge.handle(client, {
			type: "send",
			text: "look",
			attachments: [{ uploadId: stored.file.uploadId, name: stored.file.name }],
		});
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: look")));

		expect(received.filter((p) => p.type === "toast")).toEqual([]);
		expect(engine.prompts[1]?.images).toHaveLength(1);
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

describe("the learned ceiling (S1)", () => {
	it("records the refused size of the model that answered after the rotation, with a margin", async () => {
		vi.stubEnv(REQUEST_BUDGET_ENV, "20000");
		const test = setup();
		const { engine, received } = test;
		engine.plainError = INCIDENT;
		engine.plan.big = [["error"], ["answer"]];
		grow(engine, 12_000);
		const refusedFile = engine.sessionFile as string;

		await send(test, "big");

		// The retry answered, so the refusal was size: the refused conversation is what was learned from.
		expect(errors(received)).toEqual([]);
		const refused = statSync(refusedFile).size;
		const limits = readLimits(limitsFile(test.dir));
		expect(limits.ceilings).toEqual({ "fake-model": Math.floor(refused * CEILING_MARGIN) });
		expect(limits.model).toBe("fake-model");
		expect(limits.ceilings?.["fake-model"]).toBeLessThan(refused);
		expect(limits.ceilings?.["fake-model"]).toBeLessThan(20_000);
	});

	it("records nothing when the re-sent attempt fails too: that was not size", async () => {
		vi.stubEnv(REQUEST_BUDGET_ENV, "20000");
		const test = setup();
		const { engine, received } = test;
		engine.plainError = INCIDENT;
		engine.plan.big = [["error"], ["error"]];
		grow(engine, 12_000);

		await send(test, "big");

		expect(errors(received)).toHaveLength(1);
		expect(readLimits(limitsFile(test.dir)).ceilings).toBeUndefined();
	});

	it("keeps the ceiling of one model out of another", async () => {
		vi.stubEnv(REQUEST_BUDGET_ENV, "20000");
		const test = setup();
		const { engine, received } = test;
		engine.plainError = INCIDENT;
		engine.plan.first = [["error"], ["answer"]];
		engine.model = "model-a";
		grow(engine, 12_000);
		const firstFile = engine.sessionFile as string;
		await send(test, "first");

		engine.plan.second = [["error"], ["answer"]];
		engine.model = "model-b";
		grow(engine, 16_000);
		const secondFile = engine.sessionFile as string;
		await send(test, "second");

		expect(errors(received)).toEqual([]);
		const limits = readLimits(limitsFile(test.dir));
		expect(limits.ceilings).toEqual({
			"model-a": Math.floor(statSync(firstFile).size * CEILING_MARGIN),
			"model-b": Math.floor(statSync(secondFile).size * CEILING_MARGIN),
		});
		expect(limits.ceilings?.["model-a"]).not.toBe(limits.ceilings?.["model-b"]);
		// The file can only name one model: the one the engine is on now.
		expect(limits.model).toBe("model-b");
	});

	it("tells the engine where the file is and which model is selected", async () => {
		const dataDir = tempDir();
		const processFile = join(dataDir, "process.json");
		const { supervisor } = fakeSupervisor({
			dataDir,
			env: { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile },
		});
		await supervisor.start();
		try {
			await waitFor(() => existsSync(processFile));
			const env = JSON.parse(readFileSync(processFile, "utf8")).env as Record<string, string>;
			expect(env[LIMITS_FILE_ENV]).toBe(limitsFile(dataDir));
			expect(readLimits(limitsFile(dataDir)).model).toBe("Fake Model");
		} finally {
			await supervisor.stop();
		}
	});
});

describe("a recovery the daemon did not survive (T9)", () => {
	/** A bridge on an existing state folder, like the next run after a restart. */
	function restart(engine: FakeEngine, dataDir: string) {
		const bridge = new DotBridge(engine as unknown as AgentSupervisor, {
			dataDir,
			log: () => {},
			rotation: DEFAULT_ROTATION,
		});
		const received: ServerPayload[] = [];
		bridge.attach({ send: (payload: ServerPayload) => received.push(payload) });
		return { bridge, received, toasts: () => received.filter((p) => p.type === "toast") };
	}

	/** Gates the `which`-th prompt with this text, like a request still on its way to the engine. */
	function hold(engine: FakeEngine, text: string, which: number) {
		const original = engine.request.bind(engine);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let seen = 0;
		let held = false;
		engine.request = async (command: AgentRecord) => {
			if (String(command.type) === "prompt" && String(command.message) === text && ++seen === which) {
				held = true;
				await gate;
			}
			return original(command);
		};
		return { release: () => release(), held: () => held };
	}

	it("clears the marker when the recovery completes, and the next startup is silent", async () => {
		const test = setup();
		const { engine, dir, received } = test;
		engine.plan.big = [["size"], ["answer"]];

		await send(test, "big");

		// Answered, so nothing was left pending; a marker still here would warn the user wrongly.
		expect(errors(received)).toEqual([]);
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
		expect(restart(engine, dir).toasts()).toEqual([]);
	});

	it("reports a marker the interrupted recovery left, once, and clears it", async () => {
		const test = setup();
		const { engine, dir } = test;
		engine.plan.big = [["size"], ["answer"]];
		const held = hold(engine, "big", 2);

		void test.bridge.handle(test.client, { type: "send", text: "big" });
		await waitFor(() => held.held());
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(true);

		// The daemon exits here, before the message was sent again: the failure was already hidden.
		const next = restart(engine, dir);
		expect(next.toasts()).toEqual([
			{ type: "toast", level: "warning", message: expect.stringContaining("too large") },
		]);
		const toast = next
			.toasts()
			.find((p): p is Extract<ServerPayload, { type: "toast" }> => p.type === "toast");
		expect(toast?.message).toContain("could not be answered");
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
		// Said once: a further run has nothing left to report.
		expect(restart(engine, dir).toasts()).toEqual([]);

		held.release();
		await waitFor(() => engine.prompts.filter((p) => p.message === "big").length === 2);
	});

	it("ignores a missing or corrupt marker instead of breaking startup", async () => {
		const test = setup();
		const { engine, dir } = test;
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
		for (const garbage of ["not json {", "null", '"too_large"', '{"kind":"something-else"}', "[]"]) {
			writeFileSync(pendingRecoveryFile(dir), garbage);
			expect(restart(engine, dir).toasts(), garbage).toEqual([]);
		}
	});

	it("still reads a marker written before owners existed", () => {
		const test = setup();
		const { engine, dir } = test;
		writeFileSync(pendingRecoveryFile(dir), `${JSON.stringify({ kind: "too_large" })}\n`);

		expect(restart(engine, dir).toasts()).toEqual([
			{ type: "toast", level: "warning", message: expect.stringContaining("too large") },
		]);
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
	});

	it("keeps a second recovery's marker when the first finishes before it is dispatched", async () => {
		const test = setup();
		const { engine, bridge, client, received, dir } = test;
		engine.plan.alpha = [["size"], ["answer"]];
		engine.plan.beta = [["size"], ["answer"]];
		const alpha = hold(engine, "alpha", 2);
		const beta = hold(engine, "beta", 2);
		try {
			void bridge.handle(client, { type: "send", text: "alpha" });
			await waitFor(() => alpha.held());
			void bridge.handle(client, { type: "send", text: "beta" });
			await waitFor(() => beta.held());

			// alpha finishes while beta is still held before dispatch: beta's notice must survive.
			alpha.release();
			await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: alpha")));
			expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(true);

			beta.release();
			await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: beta")));
			expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
			expect(userMessages(received)).toEqual(["alpha", "beta"]);
		} finally {
			alpha.release();
			beta.release();
		}
	});

	it("keeps the first recovery's marker when the later one finishes first", async () => {
		const test = setup();
		const { engine, bridge, client, received, dir } = test;
		engine.plan.alpha = [["size"], ["answer"]];
		engine.plan.beta = [["size"], ["answer"]];
		const alpha = hold(engine, "alpha", 2);
		const beta = hold(engine, "beta", 2);
		try {
			void bridge.handle(client, { type: "send", text: "alpha" });
			await waitFor(() => alpha.held());
			void bridge.handle(client, { type: "send", text: "beta" });
			await waitFor(() => beta.held());

			beta.release();
			await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: beta")));
			expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(true);

			alpha.release();
			await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: alpha")));
			expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
			expect(userMessages(received)).toEqual(["alpha", "beta"]);
		} finally {
			alpha.release();
			beta.release();
		}
	});

	it("does not let a recovery that fails to dispatch clear another's marker", async () => {
		const test = setup();
		const { engine, bridge, client, received, dir } = test;
		engine.plan.alpha = [["size"], ["answer"]];
		engine.plan.beta = [["size"], ["answer"]];
		const alpha = hold(engine, "alpha", 2);
		// beta's re-send never reaches the engine: a failed dispatch, not a held one.
		const original = engine.request.bind(engine);
		let betaPrompts = 0;
		engine.request = async (command: AgentRecord) => {
			if (String(command.type) === "prompt" && String(command.message) === "beta" && ++betaPrompts === 2) {
				throw new Error("engine went away");
			}
			return original(command);
		};
		try {
			void bridge.handle(client, { type: "send", text: "alpha" });
			await waitFor(() => alpha.held());
			await bridge.handle(client, { type: "send", text: "beta" });
			// beta was told the failure; alpha is still in flight, and its notice must still be owed.
			await waitFor(() => errors(received).length === 1);
			expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(true);
		} finally {
			alpha.release();
		}
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: alpha")));
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
	});

	it("a failed re-send leaves no entry that would swallow a later message with the same text", async () => {
		const test = setup();
		const { engine, bridge, client, received, dir } = test;
		engine.plan.alpha = [["size"], ["answer"]];
		engine.plan.beta = [["size"], ["answer"], ["answer"]];
		const alpha = hold(engine, "alpha", 2);
		// beta's re-send never reaches the engine: a failed dispatch, not a held one.
		const original = engine.request.bind(engine);
		let betaPrompts = 0;
		engine.request = async (command: AgentRecord) => {
			if (String(command.type) === "prompt" && String(command.message) === "beta" && ++betaPrompts === 2) {
				throw new Error("engine went away");
			}
			return original(command);
		};
		try {
			void bridge.handle(client, { type: "send", text: "alpha" });
			await waitFor(() => alpha.held());
			await bridge.handle(client, { type: "send", text: "beta" });
			await waitFor(() => errors(received).length === 1);

			// The user types "beta" again: the failed re-send left nothing to claim this message.
			await send(test, "beta");
			expect(userMessages(received).filter((text) => text === "beta")).toHaveLength(2);
		} finally {
			alpha.release();
		}
		await waitFor(() => received.some((p) => p.type === "message_done" && p.text.includes("Echo: alpha")));
		expect(userMessages(received).filter((text) => text === "alpha")).toHaveLength(1);
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
	});

	it("still shows a legitimate message that repeats a recovery's text", async () => {
		const test = setup();
		const { engine, bridge, client, received, dir } = test;
		engine.plan.alpha = [["size"], ["answer"], ["answer"]];
		const alpha = hold(engine, "alpha", 2);
		try {
			void bridge.handle(client, { type: "send", text: "alpha" });
			await waitFor(() => alpha.held());
			// The user types "alpha" again while the recovery's copy is still on its way. The two are
			// indistinguishable, so the registry answers exactly one of them: two typed messages, two shown.
			await send(test, "alpha");
		} finally {
			alpha.release();
		}
		await waitFor(() => userMessages(received).filter((text) => text === "alpha").length === 2);
		expect(errors(received)).toEqual([]);
		expect(readPendingRecovery(pendingRecoveryFile(dir))).toBe(false);
	});
});
