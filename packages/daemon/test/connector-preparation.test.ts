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

/** Discord connected before preparation existed: its token is kept and it is turned on. */
async function connectedBefore() {
	const dataDir = tempDir();
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		secrets: new MemorySecretSource(),
	});
	await store.checkIntegrity();
	await store.keepValues("discord", { token: "synthetic-discord-token" });
	const earlier = new ConnectorManager({ store });
	earlier.connect({}, "discord", () => {});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(store.state().connectors.discord?.enabled).toBe(true);
	return store;
}

it("lists an enabled Discord that is not prepared as needing preparation, and only Discord", async () => {
	const store = await connectedBefore();
	try {
		let prepared = false;
		const asked = new Set<string>();
		const manager = new ConnectorManager({
			store,
			prepareConnector: async () => {},
			connectorPrepared: (id) => {
				asked.add(id);
				return prepared;
			},
		});
		const status = (id: string) => manager.list().find((c) => c.id === id)?.status;
		expect(status("discord")).toBe("needs_preparation");
		expect(manager.list().filter((c) => c.status === "needs_preparation")).toHaveLength(1);
		expect([...asked]).toEqual(["discord"]);
		prepared = true;
		expect(status("discord")).toBe("connected");
		// Where nothing is prepared (macOS, Linux), the connector runs as before.
		expect(new ConnectorManager({ store }).list().find((c) => c.id === "discord")?.status).toBe("connected");
		manager.disconnect("discord");
		prepared = false;
		expect(status("discord")).toBe("off");
	} finally {
		store.close();
	}
});

it("prepares an enabled Discord on connect with the token it already has", async () => {
	const store = await connectedBefore();
	const sent: ServerPayload[] = [];
	let prepared = false;
	let calls = 0;
	const manager = new ConnectorManager({
		store,
		prepareConnector: async () => {
			calls++;
			prepared = true;
		},
		connectorPrepared: () => prepared,
	});
	try {
		expect(manager.connect({}, "discord", (m) => sent.push(m))).toBeUndefined();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(calls).toBe(1);
		expect(sent.some((m) => m.type === "auth_prompt")).toBe(false);
		expect(sent.filter((m) => m.type === "auth_done")).toMatchObject([{ ok: true }]);
		expect(manager.list().find((c) => c.id === "discord")?.status).toBe("connected");
		expect(await store.credentials("discord")).toMatchObject({
			env: { DISCORD_TOKEN: "synthetic-discord-token" },
		});
	} finally {
		manager.cancelAll();
		store.close();
	}
});

it("does not prepare or say it is preparing when Discord is already prepared", async () => {
	const store = await connectedBefore();
	const sent: ServerPayload[] = [];
	let calls = 0;
	const manager = new ConnectorManager({
		store,
		prepareConnector: async () => {
			calls++;
		},
		connectorPrepared: () => true,
	});
	try {
		manager.setup({}, "discord", (m) => sent.push(m));
		expect(calls).toBe(0);
		expect(sent.some((m) => m.type === "auth_event")).toBe(false);
		expect(sent.find((m) => m.type === "auth_prompt")).toBeDefined();
	} finally {
		manager.cancelAll();
		store.close();
	}
});

it("logs nothing when a preparation is cancelled", async () => {
	const store = await connectedBefore();
	const logs: string[] = [];
	const sent: ServerPayload[] = [];
	const manager = new ConnectorManager({
		store,
		prepareConnector: (_id, signal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () =>
					reject(new Error("Discord package preparation did not finish (stopped)")),
				);
			}),
		connectorPrepared: () => false,
		log: (line) => logs.push(line),
	});
	try {
		manager.connect({}, "discord", (m) => sent.push(m));
		await Promise.resolve();
		manager.cancelAll();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(sent.filter((m) => m.type === "auth_done")).toMatchObject([
			{ ok: false, message: "Preparation cancelled." },
		]);
		expect(logs.some((line) => line.includes("could not prepare connector discord"))).toBe(false);
	} finally {
		manager.cancelAll();
		store.close();
	}
});

it("logs why a preparation failed", async () => {
	const store = await connectedBefore();
	const logs: string[] = [];
	const sent: ServerPayload[] = [];
	const manager = new ConnectorManager({
		store,
		prepareConnector: async () => {
			throw new Error("Discord package preparation did not finish (exit code 1): npm error code E404");
		},
		connectorPrepared: () => false,
		log: (line) => logs.push(line),
	});
	try {
		manager.connect({}, "discord", (m) => sent.push(m));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(logs).toContain(
			"could not prepare connector discord: Discord package preparation did not finish (exit code 1): npm error code E404",
		);
		expect(sent.filter((m) => m.type === "auth_done")).toMatchObject([
			{ ok: false, message: "Could not prepare Discord. Try connecting again." },
		]);
	} finally {
		manager.cancelAll();
		store.close();
	}
});
