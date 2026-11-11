import { join } from "node:path";
import type { ServerPayload } from "@gentle-dot/protocol";
import { expect, it } from "vitest";
import { ConnectorManager, ConnectorStore } from "../src/connectors.ts";
import { MemorySecretSource } from "../src/secret-source.ts";
import { tempDir } from "./helpers.ts";

it("keeps the preparation, credential prompt and completion in the same configuration flow", async () => {
	const dataDir = tempDir();
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		secrets: new MemorySecretSource(),
	});
	await store.checkIntegrity();
	const sent: ServerPayload[] = [];
	const manager = new ConnectorManager({ store, prepareConnector: async () => {} });
	const owner = {};
	try {
		manager.connect(owner, "discord", (m) => sent.push(m));
		await new Promise<void>((r) => setImmediate(r));
		const progress = sent.find((m) => m.type === "auth_event");
		const prompt = sent.find((m) => m.type === "auth_prompt");
		expect(progress?.type).toBe("auth_event");
		expect(prompt?.type).toBe("auth_prompt");
		if (progress?.type !== "auth_event" || prompt?.type !== "auth_prompt")
			throw new Error("Missing setup events");
		expect(prompt.prompt.flowId).toBe(progress.flowId);
		manager.reply(owner, prompt.prompt.flowId, { value: "synthetic-token" });
		await new Promise<void>((r) => setImmediate(r));
		expect(sent.find((m) => m.type === "auth_done")).toMatchObject({ flowId: progress.flowId, ok: true });
	} finally {
		manager.cancelAll();
		store.close();
	}
});

it("waits for aborted preparation cleanup before manager shutdown completes", async () => {
	const dataDir = tempDir();
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		secrets: new MemorySecretSource(),
	});
	await store.checkIntegrity();
	let release!: () => void;
	let signal!: AbortSignal;
	let cleaned = false;
	const sent: ServerPayload[] = [];
	const manager = new ConnectorManager({
		store,
		prepareConnector: async (_id, s) => {
			signal = s;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			cleaned = true;
		},
	});
	try {
		manager.connect({}, "discord", (m) => sent.push(m));
		let closed = false;
		const closing = manager.close().then(() => {
			closed = true;
		});
		expect(signal.aborted).toBe(true);
		await Promise.resolve();
		expect(closed).toBe(false);
		expect(cleaned).toBe(false);
		release();
		await closing;
		expect(cleaned).toBe(true);
		expect(closed).toBe(true);
		expect(store.state().connectors.discord).toBeUndefined();
		expect(sent.filter((m) => m.type === "auth_done")).toMatchObject([
			{ ok: false, message: "Preparation cancelled." },
		]);
		expect(sent.some((m) => m.type === "auth_prompt")).toBe(false);
	} finally {
		release();
		manager.cancelAll();
		store.close();
	}
});

it("cancels preparation without asking for credentials, enabling Discord or restarting the engine", async () => {
	const dataDir = tempDir();
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		secrets: new MemorySecretSource(),
	});
	await store.checkIntegrity();
	const sent: ServerPayload[] = [];
	const restarts: boolean[] = [];
	let release!: () => void;
	let signal!: AbortSignal;
	const manager = new ConnectorManager({
		store,
		prepareConnector: async (_id, s) => {
			signal = s;
			await new Promise<void>((r) => {
				release = r;
			});
		},
	});
	const owner = {};
	manager.onChanged = (restart) => restarts.push(restart);
	try {
		manager.connect(owner, "discord", (m) => sent.push(m));
		const progress = sent.find((m) => m.type === "auth_event");
		if (progress?.type !== "auth_event") throw new Error("Missing progress");
		expect(manager.reply({}, progress.flowId, { cancelled: true })).toBe(false);
		expect(signal.aborted).toBe(false);
		expect(manager.reply(owner, progress.flowId, { cancelled: true })).toBe(true);
		expect(signal.aborted).toBe(true);
		release();
		await new Promise<void>((r) => setImmediate(r));
		expect(sent.filter((m) => m.type === "auth_done")).toMatchObject([
			{ ok: false, message: "Preparation cancelled." },
		]);
		expect(sent.some((m) => m.type === "auth_prompt")).toBe(false);
		expect(store.state().connectors.discord).toBeUndefined();
		expect(restarts).toEqual([]);
	} finally {
		release();
		manager.cancelAll();
		store.close();
	}
});
