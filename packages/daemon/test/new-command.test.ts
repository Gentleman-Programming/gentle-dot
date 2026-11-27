import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor, waitFor } from "./helpers.ts";

const supervisors: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

async function setup(conversations: boolean) {
	const { supervisor, dataDir } = fakeSupervisor();
	supervisors.push(supervisor);
	const bridge = new DotBridge(supervisor, { dataDir, features: { conversations } });
	const received: ServerPayload[] = [];
	const client = { send: (payload: ServerPayload) => received.push(payload) };
	bridge.attach(client);
	await supervisor.start();
	return { supervisor, bridge, client, received };
}

function of<T extends ServerPayload["type"]>(
	received: ServerPayload[],
	type: T,
): Extract<ServerPayload, { type: T }>[] {
	return received.filter((p): p is Extract<ServerPayload, { type: T }> => p.type === type);
}

/** Sends `/new` and waits until the engine opened another session and settled. */
async function newChat(ctx: Awaited<ReturnType<typeof setup>>, text = "/new") {
	const first = ctx.supervisor.sessionFile as string;
	await ctx.bridge.handle(ctx.client, { type: "send", text });
	await waitFor(() => ctx.supervisor.sessionFile !== first && ctx.supervisor.sessionFile);
	await waitFor(() => ctx.bridge.agentState === "idle");
	return of(ctx.received, "history").at(-1);
}

describe("/new", () => {
	it("starts a fresh conversation while the conversations list is off, without asking the assistant", async () => {
		const ctx = await setup(false);
		expect(ctx.received[0]).toMatchObject({ type: "ready", features: { conversations: false } });
		await ctx.bridge.handle(ctx.client, { type: "send", text: "plan the trip" });
		await waitFor(() => ctx.bridge.agentState === "idle");

		const page = await newChat(ctx);
		expect(page).toMatchObject({ messages: [], hasEarlier: false });
		expect(of(ctx.received, "user_message").map((m) => m.text)).toEqual(["plan the trip"]);
		expect(of(ctx.received, "error")).toEqual([]);
		expect(of(ctx.received, "toast")).toEqual([
			{ type: "toast", level: "info", message: "Started a new conversation." },
		]);
	});

	it("starts a fresh conversation with the list on too", async () => {
		const ctx = await setup(true);
		expect(ctx.received[0]).toMatchObject({ type: "ready", features: { conversations: true } });
		expect(await newChat(ctx)).toMatchObject({ messages: [], hasEarlier: false });
		expect(of(ctx.received, "error")).toEqual([]);
	});

	it("accepts surrounding spaces and any letter case", async () => {
		const ctx = await setup(false);
		expect(await newChat(ctx, "  /NEW  ")).toMatchObject({ messages: [], hasEarlier: false });
	});

	it("stops the answer in progress before switching", async () => {
		const ctx = await setup(false);
		await ctx.bridge.handle(ctx.client, { type: "send", text: "hang" });
		await waitFor(() => of(ctx.received, "agent_state").some((m) => m.state === "thinking"));

		expect(await newChat(ctx)).toMatchObject({ messages: [], hasEarlier: false });
		expect(of(ctx.received, "message_done")).toEqual([expect.objectContaining({ stopped: true })]);
		expect(of(ctx.received, "user_message").map((m) => m.text)).toEqual(["hang"]);
	});
});
