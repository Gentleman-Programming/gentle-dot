import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HistoryMessage, ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import {
	DEFAULT_ROTATION,
	HANDOFF_TYPE,
	type RotationLimits,
	rotationLimits,
	SessionRotator,
	writeHandoffSession,
} from "../src/rotation.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { FAKE_AGENT, fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

const supervisors: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

type History = Extract<ServerPayload, { type: "history" }>;
type Earlier = Extract<ServerPayload, { type: "earlier" }>;

async function setup(options: {
	limits?: Partial<RotationLimits>;
	env?: NodeJS.ProcessEnv;
	historyPage?: number;
}) {
	const { supervisor, dataDir } = fakeSupervisor({ env: { ...process.env, ...options.env } });
	supervisors.push(supervisor);
	const logs: string[] = [];
	const bridge = new DotBridge(supervisor, {
		dataDir,
		log: (line) => logs.push(line),
		rotation: { ...DEFAULT_ROTATION, ...options.limits },
		...(options.historyPage ? { historyPage: options.historyPage } : {}),
	});
	const received: ServerPayload[] = [];
	const client = { send: (payload: ServerPayload) => received.push(payload) };
	bridge.attach(client);
	await supervisor.start();
	/** Sends one message and waits until its answer is done and the agent is idle again. */
	const say = async (text: string) => {
		const done = received.filter((p) => p.type === "message_done").length;
		await bridge.handle(client, { type: "send", text });
		await waitFor(() => received.filter((p) => p.type === "message_done").length > done);
		await waitFor(() => bridge.agentState === "idle");
	};
	const answers = () => received.flatMap((p) => (p.type === "message_done" ? [p.text] : []));
	return { supervisor, bridge, client, received, logs, dataDir, say, answers };
}

const texts = (messages: HistoryMessage[]) => messages.map((m) => m.text);
const headerOf = (file: string) => JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "{}");

describe("transparent rotation", () => {
	it("starts a fresh session after enough compactions, seeded with the latest summary and no user message", async () => {
		const { supervisor, received, dataDir, say, answers } = await setup({ limits: { compactions: 2 } });
		const first = supervisor.sessionFile as string;
		await say("plan the trip");
		await say("compact");
		// One compaction is below the limit.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(supervisor.sessionFile).toBe(first);

		await say("compact");
		const second = await waitFor(() => supervisor.sessionFile !== first && supervisor.sessionFile);
		expect(supervisor.previousSessions).toEqual([first]);
		expect(headerOf(second)).toMatchObject({ type: "session", parentSession: first });
		const state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
		expect(state).toMatchObject({ sessionFile: second, chains: { [second]: [first] } });

		// The chat shows the same messages, now marked as earlier ones.
		const history = await waitFor(() =>
			received.find((p): p is History => p.type === "history" && p.messages.some((m) => m.earlier)),
		);
		expect(texts(history.messages).slice(-2)).toEqual(["compact", "Compacted."]);
		expect(history.messages.every((m) => m.earlier)).toBe(true);

		await say("recall");
		expect(answers().at(-1)).toContain("Summary: plan the trip, compact, compact");
		const userMessages = received.flatMap((p) => (p.type === "user_message" ? [p.text] : []));
		expect(userMessages).toEqual(["plan the trip", "compact", "compact", "recall"]);
	});

	it("rotates by size, handing off the last messages when nothing was compacted yet", async () => {
		const { supervisor, say, answers } = await setup({ limits: { bytes: 3000 } });
		const first = supervisor.sessionFile as string;
		await say("keep this in mind: blue");
		await say("pad:4000");
		await waitFor(() => supervisor.sessionFile !== first);
		await say("recall");
		expect(answers().at(-1)).toContain("keep this in mind: blue");
	});

	it("keeps the chain of session files across a restart of the daemon", async () => {
		const { supervisor, dataDir, say } = await setup({ limits: { compactions: 1 } });
		const first = supervisor.sessionFile as string;
		await say("compact");
		const second = await waitFor(() => supervisor.sessionFile !== first && supervisor.sessionFile);
		await supervisor.stop();
		const again = new AgentSupervisor({
			command: process.execPath,
			args: [FAKE_AGENT],
			cwd: dataDir,
			dataDir,
		});
		expect(again.sessionFile).toBe(second);
		expect(again.previousSessions).toEqual([first]);
	});

	it("leaves the current session working when the handoff cannot be written", async () => {
		const { supervisor, logs, say, answers } = await setup({ limits: { compactions: 1 } });
		const first = supervisor.sessionFile as string;
		await say("hello");
		chmodSync(dirname(first), 0o500);
		try {
			await say("compact");
			await waitFor(() => logs.some((line) => line.includes("rotation")));
		} finally {
			chmodSync(dirname(first), 0o700);
		}
		expect(supervisor.sessionFile).toBe(first);
		expect(supervisor.previousSessions).toEqual([]);
		await say("still here");
		expect(answers().at(-1)).toBe("Echo: still here");
	});

	it("falls back to a fresh session, deleting nothing, when the engine does not load the handoff", async () => {
		const { supervisor, logs, say, answers } = await setup({
			limits: { compactions: 1 },
			env: { FAKE_AGENT_DROP_CUSTOM: "1" },
		});
		const first = supervisor.sessionFile as string;
		await say("compact");
		await waitFor(() => logs.some((line) => line.includes("fresh session")));
		const current = supervisor.sessionFile as string;
		expect(current).not.toBe(first);
		expect(headerOf(current)).toMatchObject({ parentSession: first });
		expect(supervisor.previousSessions).toEqual([first]);
		// The handoff file the engine could not use stays on disk.
		const seed = logs.join("\n").match(/handoff session (\S+\.jsonl)/)?.[1];
		expect(seed && seed !== current && existsSync(seed)).toBe(true);
		await say("after");
		expect(answers().at(-1)).toBe("Echo: after");
	});
});

describe("rotation guards", () => {
	function compactedFile(compactions: number): string {
		const file = join(tempDir(), "s.jsonl");
		const lines = [{ type: "session", version: 3, id: "x", timestamp: new Date().toISOString(), cwd: "/" }];
		for (let i = 0; i < compactions; i++) lines.push({ type: "compaction", summary: `s${i}` } as never);
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return file;
	}

	function stub(sessionFile: string, state: { isStreaming?: boolean; isCompacting?: boolean } = {}) {
		const requests: string[] = [];
		const supervisor = {
			state: "ready",
			busy: false,
			sessionFile,
			previousSessions: [],
			linkSessions: () => {},
			request: async (command: { type: string }) => {
				requests.push(command.type);
				return { type: "response", command: command.type, success: true, data: state };
			},
		} as unknown as AgentSupervisor;
		return { supervisor, requests };
	}

	it("does nothing while the bridge says the chat is not idle", async () => {
		const { supervisor, requests } = stub(compactedFile(3));
		const rotator = new SessionRotator(supervisor, {
			limits: { ...DEFAULT_ROTATION, compactions: 1 },
			canRotate: () => false,
		});
		expect(await rotator.maybeRotate()).toBe(false);
		expect(requests).toEqual([]);
	});

	it("does nothing while the engine still streams or compacts", async () => {
		for (const state of [{ isStreaming: true }, { isCompacting: true }]) {
			const { supervisor, requests } = stub(compactedFile(3), state);
			const rotator = new SessionRotator(supervisor, {
				limits: { ...DEFAULT_ROTATION, compactions: 1 },
				canRotate: () => true,
			});
			expect(await rotator.maybeRotate()).toBe(false);
			expect(requests).toEqual(["get_state"]);
		}
	});

	it("does nothing below the limits", async () => {
		const { supervisor, requests } = stub(compactedFile(2));
		const rotator = new SessionRotator(supervisor, { limits: DEFAULT_ROTATION, canRotate: () => true });
		expect(await rotator.maybeRotate()).toBe(false);
		expect(requests).toEqual([]);
	});

	it("reads its limits from the environment, defaulting to 20 MB or 10 compactions", () => {
		expect(DEFAULT_ROTATION).toEqual({ bytes: 20 * 1024 * 1024, compactions: 10 });
		expect(rotationLimits({})).toEqual(DEFAULT_ROTATION);
		expect(rotationLimits({ GENTLE_DOT_ROTATE_BYTES: "4096", GENTLE_DOT_ROTATE_COMPACTIONS: "3" })).toEqual({
			bytes: 4096,
			compactions: 3,
		});
		expect(rotationLimits({ GENTLE_DOT_ROTATE_BYTES: "lots", GENTLE_DOT_ROTATE_COMPACTIONS: "0" })).toEqual(
			DEFAULT_ROTATION,
		);
	});
});

describe("handoff session file", () => {
	it("is a session the engine's own SessionManager opens and keeps writing to", async () => {
		const dir = join(tempDir(), "sessions");
		mkdirSync(dir);
		const previous = join(dir, "previous.jsonl");
		writeFileSync(
			previous,
			`${JSON.stringify({ type: "session", version: 3, id: "p", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		const file = await writeHandoffSession(previous, "Summary: the user plans a trip.");
		expect(dirname(file)).toBe(dir);
		// Pi's own naming: `<ISO timestamp with : and . as ->_<uuidv7>.jsonl`.
		expect(basename(file)).toMatch(
			/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/,
		);

		const { SessionManager, CURRENT_SESSION_VERSION } = await import("@earendil-works/pi-coding-agent");
		const manager = SessionManager.open(file);
		expect(manager.getHeader()).toMatchObject({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			cwd: dir,
			parentSession: previous,
		});
		const [entry] = manager.getEntries();
		expect(entry).toMatchObject({
			type: "custom_message",
			customType: HANDOFF_TYPE,
			display: false,
			parentId: null,
		});
		expect(entry?.id).toMatch(/^[0-9a-f]{8}$/);
		const context = manager.buildSessionContext().messages;
		expect(context).toHaveLength(1);
		expect(context[0]).toMatchObject({ role: "custom", customType: HANDOFF_TYPE, display: false });
		expect(JSON.stringify(context[0])).toContain("Summary: the user plans a trip.");

		// The engine appends the next messages to the same file.
		manager.appendMessage({ role: "user", content: "hello again", timestamp: Date.now() });
		const reopened = SessionManager.open(file).buildSessionContext().messages;
		expect(reopened.map((m) => m.role)).toEqual(["custom", "user"]);
	});
});

describe("recent history", () => {
	it("sends only the latest page and pages back across the rotation boundary", async () => {
		const { bridge, client, received, say } = await setup({ limits: { compactions: 2 }, historyPage: 3 });
		await say("one");
		await say("compact");
		await say("compact");
		await waitFor(() => received.some((p) => p.type === "history" && p.messages.some((m) => m.earlier)));
		await say("two");

		const count = received.length;
		await bridge.handle(client, { type: "get_history" });
		const history = received.slice(count).find((p): p is History => p.type === "history") as History;
		expect(texts(history.messages)).toEqual(["Compacted.", "two", "Echo: two"]);
		expect(history.messages.map((m) => m.earlier === true)).toEqual([true, false, false]);
		expect(history.hasEarlier).toBe(true);

		const page = async (before: string) => {
			const start = received.length;
			await bridge.handle(client, { type: "get_earlier", before });
			return received.slice(start).find((p): p is Earlier => p.type === "earlier") as Earlier;
		};
		const second = await page(history.messages[0]?.id as string);
		expect(second.before).toBe(history.messages[0]?.id);
		expect(texts(second.messages)).toEqual(["compact", "Compacted.", "compact"]);
		expect(second.messages.every((m) => m.earlier)).toBe(true);
		expect(second.hasEarlier).toBe(true);

		const third = await page(second.messages[0]?.id as string);
		expect(texts(third.messages)).toEqual(["one", "Echo: one"]);
		expect(third.hasEarlier).toBe(false);

		const unknown = await page("nope");
		expect(unknown).toMatchObject({ messages: [], hasEarlier: false });
		const ids = [...history.messages, ...second.messages, ...third.messages].map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("single chat", () => {
	it("tells clients the conversations list is off by default and refuses to start another chat", async () => {
		const { supervisor, bridge, client, received } = await setup({});
		expect(received[0]).toMatchObject({ type: "ready", features: { conversations: false } });
		const first = supervisor.sessionFile;
		await bridge.handle(client, { type: "new_conversation" });
		expect(received.at(-1)).toMatchObject({ type: "error", code: "conversations_off" });
		expect(supervisor.sessionFile).toBe(first);
	});

	it("offers the conversations list when the flag is on", async () => {
		const { supervisor, dataDir } = fakeSupervisor();
		supervisors.push(supervisor);
		const bridge = new DotBridge(supervisor, { dataDir, features: { conversations: true } });
		const received: ServerPayload[] = [];
		bridge.attach({ send: (payload) => received.push(payload) });
		expect(received[0]).toMatchObject({ type: "ready", features: { conversations: true } });
	});
});
