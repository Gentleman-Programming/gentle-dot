import { statSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createModelAuthRuntime, resolveAgentHome } from "../src/auth.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function setup(env: NodeJS.ProcessEnv = process.env) {
	const fake = fakeAuthRuntime();
	const logs: string[] = [];
	const dataDir = tempDir();
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: dataDir,
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		backoffMs: [50],
		agentEnv: env,
		authRuntime: async () => fake.runtime,
		log: (line) => logs.push(line),
	});
	daemons.push(d);
	return { d, fake, logs, ...(await connect(d)), connect: () => connect(d) };
}

async function connect(d: DotDaemon) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (m: object) => ws.send(JSON.stringify(m));
	function find<T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
	) {
		return waitFor(() =>
			messages.find(
				(m): m is Extract<ServerMessage, { type: T }> =>
					m.type === type && where(m as Extract<ServerMessage, { type: T }>),
			),
		);
	}
	return { ws, messages, send, find };
}

describe("sign-in", () => {
	it("lists the providers that support sign-in with their status", async () => {
		const { send, find } = await setup();
		send({ type: "auth_list" });
		const list = await find("auth_providers");
		expect(list.providers).toEqual([
			// A Claude subscription is not offered: Anthropic signs in with an API key only.
			{ id: "anthropic", name: "Anthropic", methods: ["api_key"], configured: false },
			{ id: "openai", name: "OpenAI", methods: ["api_key"], configured: false },
			{
				id: "github-copilot",
				name: "GitHub Copilot",
				methods: ["oauth"],
				oauthName: "GitHub Copilot",
				configured: false,
			},
		]);
		expect(list.open).toBeUndefined();
	});

	it("refuses a Claude subscription sign-in without starting it", async () => {
		const { send, find, fake } = await setup();
		send({ type: "auth_login", providerId: "anthropic", method: "oauth" });
		const error = await find("error");
		expect(error).toMatchObject({
			code: "auth_unsupported",
			message: "Signing in with a Claude subscription is not supported. Use an Anthropic API key instead.",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fake.state.logins).toEqual([]);
		// The refusal does not hold the single sign-in slot.
		send({ type: "auth_login", providerId: "anthropic", method: "api_key" });
		expect((await find("auth_prompt")).prompt.kind).toBe("secret");
		expect(fake.state.logins).toEqual(["anthropic:api_key"]);
	});

	it("opens the accounts screen when the user types /login", async () => {
		const { send, find, messages } = await setup();
		send({ type: "send", text: "/login" });
		const list = await find("auth_providers");
		expect(list.open).toBe(true);
		expect(messages.some((m) => m.type === "user_message")).toBe(false);
	});

	it("runs a subscription sign-in: link, code prompt, success, refreshed status, and an agent restart", async () => {
		const { d, send, find } = await setup();
		const pid = d.supervisor.pid;
		send({ type: "auth_login", providerId: "github-copilot", method: "oauth" });
		const link = await find("auth_event", (m) => m.event.kind === "auth_url");
		expect(link.event).toEqual({
			kind: "auth_url",
			url: "https://example.com/authorize?x=1",
			instructions: "Sign in",
		});
		await find("auth_event", (m) => m.event.kind === "progress");
		const prompt = await find("auth_prompt");
		expect(prompt.prompt).toMatchObject({
			kind: "manual_code",
			message: "Paste the code",
			flowId: link.flowId,
		});
		send({ type: "auth_reply", flowId: link.flowId, value: "good-code" });
		const done = await find("auth_done");
		expect(done).toMatchObject({ ok: true, providerId: "github-copilot", flowId: link.flowId });
		const refreshed = await find("auth_providers", (m) =>
			m.providers.some((p) => p.id === "github-copilot" && p.configured),
		);
		expect(refreshed.providers.find((p) => p.id === "github-copilot")?.source).toBe("stored");
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
	});

	it("saves an API key without ever logging it", async () => {
		const { send, find, logs, messages } = await setup();
		send({ type: "auth_login", providerId: "openai", method: "api_key" });
		const prompt = await find("auth_prompt");
		expect(prompt.prompt.kind).toBe("secret");
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: "sk-very-secret-value" });
		expect((await find("auth_done")).ok).toBe(true);
		expect(logs.join("\n")).not.toContain("sk-very-secret-value");
		expect(JSON.stringify(messages)).not.toContain("sk-very-secret-value");
	});

	it("reports a failed sign-in in plain words", async () => {
		const { send, find } = await setup();
		send({ type: "auth_login", providerId: "github-copilot", method: "oauth" });
		const prompt = await find("auth_prompt");
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: "wrong" });
		const done = await find("auth_done");
		expect(done.ok).toBe(false);
		expect(done.message).toBe("Sign-in did not finish. Please try again.");
	});

	it("cancels a sign-in and aborts the provider flow", async () => {
		const { send, find, fake } = await setup();
		send({ type: "auth_login", providerId: "github-copilot", method: "oauth" });
		const prompt = await find("auth_prompt");
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, cancelled: true });
		const done = await find("auth_done");
		expect(done).toMatchObject({ ok: false, message: "Sign-in cancelled." });
		expect(fake.state.aborted).toBe(true);
	});

	it("runs one sign-in at a time", async () => {
		const { send, find } = await setup();
		send({ type: "auth_login", providerId: "github-copilot", method: "oauth" });
		await find("auth_prompt");
		send({ type: "auth_login", providerId: "openai", method: "api_key" });
		expect((await find("error")).code).toBe("auth_busy");
	});

	it("cancels the sign-in when its window disconnects", async () => {
		const { ws, find, fake } = await setup();
		ws.send(JSON.stringify({ type: "auth_login", providerId: "github-copilot", method: "oauth" }));
		await find("auth_prompt");
		ws.close();
		await waitFor(() => fake.state.aborted);
	});

	it("only answers a sign-in prompt from the window that started it", async () => {
		const { send, find, connect } = await setup();
		send({ type: "auth_login", providerId: "github-copilot", method: "oauth" });
		const prompt = await find("auth_prompt");
		const other = await connect();
		other.send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: "good-code" });
		expect((await other.find("error")).code).toBe("auth_flow_not_found");
		other.send({ type: "auth_reply", flowId: prompt.prompt.flowId, cancelled: true });
		await waitFor(() => other.messages.filter((m) => m.type === "error").length === 2);
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: "good-code" });
		expect(await find("auth_done")).toMatchObject({ ok: true, providerId: "github-copilot" });
	});

	it("refuses to sign out of an account that is not in the list", async () => {
		const { d, send, find, logs } = await setup();
		const pid = d.supervisor.pid;
		send({ type: "auth_logout", providerId: "../../etc" });
		expect(await find("error")).toMatchObject({
			code: "unknown_provider",
			message: "That account is not available.",
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(d.supervisor.pid).toBe(pid);
		expect(logs.join("\n")).not.toContain("../../etc");
	});

	it("asks to connect an account when a message fails and none is connected", async () => {
		const { send, find, messages, fake } = await setup({ ...process.env, FAKE_AGENT_NO_MODEL: "1" });
		send({ type: "send", text: "hello" });
		expect(await find("error")).toMatchObject({
			code: "no_account",
			message: "Connect an AI account first: open Accounts or type /login.",
		});
		fake.configured.add("openai");
		send({ type: "send", text: "hello again" });
		await waitFor(() => messages.filter((m) => m.type === "error").length === 2);
		expect(messages.filter((m) => m.type === "error").at(-1)).toMatchObject({
			code: "command_failed",
			message: "That did not work. Please try again.",
		});
	});

	it("signs out", async () => {
		const { send, find, fake } = await setup();
		fake.configured.add("openai");
		send({ type: "auth_logout", providerId: "openai" });
		const list = await find("auth_providers", (m) =>
			m.providers.some((p) => p.id === "openai" && !p.configured),
		);
		expect(list.providers.find((p) => p.id === "openai")?.configured).toBe(false);
	});

	it("waits for the current run to finish before restarting the agent", async () => {
		const { d, send, find } = await setup();
		send({ type: "send", text: "hang" });
		await find("agent_state", (m) => m.state === "thinking");
		const pid = d.supervisor.pid;
		send({ type: "auth_login", providerId: "openai", method: "api_key" });
		const prompt = await find("auth_prompt");
		send({ type: "auth_reply", flowId: prompt.prompt.flowId, value: "sk-ok" });
		await find("auth_done");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(d.supervisor.pid).toBe(pid);
		send({ type: "abort" });
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
	});
});

describe("createModelAuthRuntime (Pi's runtime, offline)", () => {
	it("stores an API key in the assistant's home and a fresh runtime sees it", async () => {
		const home = tempDir();
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const first = await createModelAuthRuntime(home, home);
			await first.login("openai", "api_key", { prompt: async () => "sk-test-not-real", notify: () => {} });
			const fresh = await createModelAuthRuntime(home, home);
			expect(fresh.getProviderAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
			await fresh.logout("openai");
			expect((await createModelAuthRuntime(home, home)).getProviderAuthStatus("openai").configured).toBe(
				false,
			);
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
		}
	});

	it("lists NaN, the provider the engine's own extension registers, with its API key sign-in", async () => {
		const home = tempDir();
		const runtime = await createModelAuthRuntime(home, home);
		const nan = runtime.getProviders().find((provider) => provider.name === "NaN");
		expect(nan?.auth.apiKey?.name).toBe("NaN API key");
		expect(runtime.getProviderAuthStatus(nan?.id ?? "").configured).toBe(false);
	});
});

describe("resolveAgentHome", () => {
	it("belongs to the assistant: <dataDir>/agent unless overridden, never the user's Gentle Shell home", () => {
		const dataDir = tempDir();
		expect(resolveAgentHome({}, dataDir)).toBe(`${dataDir}/agent`);
		expect(resolveAgentHome({ GENTLE_SHELL_HOME: "/x", PI_CODING_AGENT_DIR: "/z" }, dataDir)).toBe(
			`${dataDir}/agent`,
		);
		expect(resolveAgentHome({ GENTLE_DOT_AGENT_HOME: "/y" }, dataDir)).toBe("/y");
	});
});
