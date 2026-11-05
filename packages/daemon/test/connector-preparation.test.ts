import { join } from "node:path";
import type { ServerPayload } from "@gentle-dot/protocol";
import { expect, it } from "vitest";
import { ConnectorManager, ConnectorStore } from "../src/connectors.ts";
import { MemorySecretSource } from "../src/secret-source.ts";
import { tempDir } from "./helpers.ts";

it("waits for Discord preparation during configuration before enabling or reporting success", async () => {
	const dataDir = tempDir();
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		secrets: new MemorySecretSource(),
	});
	await store.checkIntegrity();
	await store.keepValues("discord", { token: "synthetic-discord-token" });
	const messages: ServerPayload[] = [];
	const restarts: boolean[] = [];
	let started = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const options = {
		store,
		prepareConnector: async (id: string, _signal: AbortSignal) => {
			expect(id).toBe("discord");
			started = true;
			await gate;
		},
	};
	const manager = new ConnectorManager(options);
	manager.onChanged = (restart) => restarts.push(restart);
	try {
		expect(manager.connect({}, "discord", (message) => messages.push(message))).toBeUndefined();
		await Promise.resolve();
		expect(started).toBe(true);
		expect(store.state().connectors.discord?.enabled).not.toBe(true);
		expect(restarts).not.toContain(true);
		expect(messages.some((message) => message.type === "auth_done")).toBe(false);
		expect(
			messages.some((message) => message.type === "auth_event" && message.event.kind === "progress"),
		).toBe(true);
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(store.state().connectors.discord?.enabled).toBe(true);
		expect(restarts.filter(Boolean)).toHaveLength(1);
		expect(messages.filter((message) => message.type === "auth_done")).toMatchObject([{ ok: true }]);
	} finally {
		release();
		manager.cancelAll();
		store.close();
	}
});
