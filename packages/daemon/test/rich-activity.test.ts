import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivitySource, ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { redactPreview } from "../src/activity-preview.ts";
import { DotBridge } from "../src/bridge.ts";
import { ConnectorStore } from "../src/connectors.ts";
import { historyFromMessages, pageHistory } from "../src/conversations.ts";
import { activityOf, sourceOf } from "../src/presentation.ts";
import { MemorySecretSource } from "../src/secret-source.ts";
import type { AgentSupervisor, SupervisorEvent } from "../src/supervisor.ts";
import { presentText } from "../src/white-label.ts";

const masked = "[REDACTED]";

describe("activity preview redaction", () => {
	it.each([
		"token",
		"secret",
		"password",
		"passwd",
		"api_key",
		"api-key",
		"apikey",
		"Authorization",
		"Cookie",
		"session",
		"private_key",
		"client_secret",
		"access_token",
		"refresh_token",
		"SLACK_TOKEN",
		"clientSecret",
		"sessionId",
	])("masks %s in JSON and text", (key) => {
		for (const input of [
			JSON.stringify({ [key]: "sensitive value" }),
			`${key}='sensitive value'`,
			`${key}: sensitive value`,
			`${key}=opaque`,
		]) {
			const result = redactPreview(input, 2000);
			expect(result).not.toContain("sensitive value");
			expect(result).not.toContain("opaque");
			expect(result).toContain(masked);
		}
	});

	it.each([
		"Bearer opaque-auth-value",
		"Basic dXNlcjpwYXNz",
		"sk-proj-example123456789",
		"ghp_example123456789",
		"gho_example123456789",
		"github_pat_example123456789",
		"xoxa-example123456789",
		"xoxb-example123456789",
		"xoxp-example123456789",
		"AKIAIOSFODNN7EXAMPLE",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
		"-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----",
		"-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
	])("masks secret format %s", (secret) => {
		expect(redactPreview(`before ${secret} after`, 2000)).toBe(`before ${masked} after`);
	});

	it("masks nested structured credentials and escaped strings without mutating arguments", () => {
		const args = { nested: { password: 'one "two"\nthree', token: { nested: "hidden" } }, count: 2 };
		const before = structuredClone(args);
		const preview = activityOf("t", "bash", args, "running").detail;
		expect(preview).not.toMatch(/one|two|three|hidden/);
		expect(preview).toContain('"count":2');
		expect(args).toEqual(before);
	});

	it("masks auth-flow email bodies but preserves ordinary email", () => {
		const auth = JSON.stringify({ subject: "Your verification code", body: "Use 123456 to sign in" });
		expect(redactPreview(auth, 2000)).not.toContain("123456");
		const ordinary = JSON.stringify({ subject: "Lunch", body: "Meet at noon", email: "person@example.test" });
		expect(redactPreview(ordinary, 2000)).toBe(ordinary);
	});

	it("masks available daemon secrets literally, including before truncation", () => {
		const secret = "opaque.*[value]-".repeat(20);
		expect(redactPreview(`prefix ${secret} suffix`, 200, [secret])).toBe(`prefix ${masked} suffix`);
		expect(redactPreview("short secret x", 200, ["x", ""])).toBe(`short secret ${masked}`);
	});

	it("does not let known values erase credential labels before generic masking", () => {
		expect(redactPreview("Bearer unknown-credential", 2000, ["Bearer"])).toBe(masked);
		expect(redactPreview("token=unknown-credential", 2000, ["token"])).not.toContain("unknown-credential");
	});

	it.each([
		'echo {"token":"fragment-secret"}',
		"Authorization: Bearer fragment-secret\nCookie: session=fragment-secret",
		"https://example.test/?api_key=fragment-secret&safe=yes",
		'password="fragment-secret"; echo done',
		"password=fragment-secret, safe=yes",
	])("masks credential fragments in %s", (input) => {
		expect(redactPreview(input, 2000)).not.toContain("fragment-secret");
	});

	it("masks numeric/array credentials and fails closed on cyclic input", () => {
		expect(redactPreview({ token: 123456, private_key: ["private", "key"], ok: true }, 2000)).toBe(
			'{"token":"[REDACTED]","private_key":"[REDACTED]","ok":true}',
		);
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(redactPreview(cycle, 2000)).toBe(masked);
	});

	it("keeps negative cases intact", () => {
		for (const input of [
			"Read tokenization and session notes",
			"a skeleton key",
			"sk-short discussion",
			"github project",
			'{"path":"notes.md","count":3}',
			"https://example.test/path",
			"const passwordLength = 12;",
		]) {
			expect(redactPreview(input, 2000)).toBe(input);
		}
	});

	it("truncates both previews after masking and omits output while running", () => {
		const result = {
			content: [
				{ type: "text", text: `token=secret\n${"y".repeat(3000)}` },
				{ type: "image", data: "NEVER_SEND_IMAGE" },
			],
			details: { token: "NEVER_SEND_DETAILS" },
		};
		const args = { command: "x".repeat(300) };
		const running = activityOf("t", "bash", args, "running", result);
		const done = activityOf("t", "bash", args, "done", result);
		expect(running.detail).toHaveLength(200);
		expect(running).not.toHaveProperty("output");
		expect(done.output).toHaveLength(2000);
		expect(done.output).toContain(masked);
		expect(JSON.stringify(done)).not.toMatch(/NEVER_SEND|"args"/);
	});
});

describe("available instance secrets", () => {
	it("uses cached connector values, OAuth leaves and proxy/helper keys without new reads", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gentle-dot-rich-secrets-"));
		const store = new ConnectorStore({
			dataDir: dir,
			agentHome: join(dir, "agent"),
			secrets: new MemorySecretSource(),
		});
		try {
			await store.keepValues("discord", { token: "opaque-bot-value" });
			await store.saveSignIn("notion", {
				serverUrl: "https://mcp.notion.com/mcp",
				tokens: {
					access_token: "opaque-access-value",
					refresh_token: "opaque-refresh-value",
					token_type: "Bearer",
				},
			});
			store.setProxy({ url: "http://127.0.0.1:1/mcp", key: "opaque-proxy-value" });
			store.setComputer({ url: "http://127.0.0.1:2/mcp", token: "opaque-helper-value" });
			for (const secret of [
				"opaque-bot-value",
				"opaque-access-value",
				"opaque-refresh-value",
				"opaque-proxy-value",
				"opaque-helper-value",
			]) {
				expect(redactPreview(secret, 200, store.previewSecrets())).toBe(masked);
			}
			store.lock();
			expect(store.previewSecrets()).not.toContain("opaque-bot-value");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses current secrets for cached history, before truncation", () => {
		const dir = mkdtempSync(join(tmpdir(), "gentle-dot-rich-history-"));
		try {
			const file = join(dir, "session.jsonl");
			const secret = "opaque-value".repeat(40);
			writeFileSync(
				file,
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "a", name: "mem_save", arguments: { content: secret } }],
					},
				}),
			);
			expect(pageHistory([file], 10).messages[0]?.activities[0]?.detail).toHaveLength(200);
			expect(pageHistory([file], 10, undefined, [secret]).messages[0]?.activities[0]?.detail).toBe(
				'{"content":"[REDACTED]"}',
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("source classification", () => {
	it.each<[string, ActivitySource]>([
		["mem_save", "engram"],
		["mem_search", "engram"],
		...["slack", "linear", "gmail", "notion", "atlassian", "discord"].map(
			(id) => [`mcp__${id}__search`, id] as [string, ActivitySource],
		),
		["mcp__custom__search", "mcp"],
		["mcp__slackish__search", "mcp"],
		["list_mcp_resources", "mcp"],
		["list_mcp_resource_templates", "mcp"],
		["read_mcp_resource", "mcp"],
		["gentle_review", "rdd"],
		["gentle_review_status", "rdd"],
		...["web_search", "fetch_content", "get_search_content", "source_check", "web_enable"].map(
			(tool) => [tool, "web"] as [string, ActivitySource],
		),
		...["read", "write", "edit", "grep", "find", "ls", "codegraph_query"].map(
			(tool) => [tool, "files"] as [string, ActivitySource],
		),
		["bash", "shell"],
		["subagent_run", "subagent"],
		["unknown", "other"],
	])("classifies %s as %s", (tool, source) => expect(sourceOf(tool)).toBe(source));
});

const code =
	"```ts\n    const name = 'Engram';\n      // Gentle Shell\n```\n~~~text\n    ODD  RDD\n~~~\n`Engram  ODD` and ``Gentle Shell `code` ``";
const finalText = `Engram uses Gentle Shell.\n${code}`;
const reasoning = "Engram follows ODD";
const toolCall = (id: string, name: string) => ({
	type: "toolCall",
	id,
	name,
	arguments: { token: "hidden", query: "hello" },
});
const result = { content: [{ type: "text", text: "password=hidden result" }] };

describe("rich history and live events", () => {
	it("correlates interleaved results by id, preserves code and rewrites reasoning", () => {
		const messages = historyFromMessages([
			{
				role: "assistant",
				content: [
					toolCall("a", "mcp__slack__slack_search_public"),
					toolCall("b", "mem_save"),
					{ type: "thinking", thinking: reasoning },
					{ type: "text", text: finalText },
				],
			},
			{ role: "toolResult", toolCallId: "b", isError: true, ...result },
			{ role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "token=hidden slack result" }] },
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			text: `memory uses Gentle Dot.\n${code}`,
			reasoning: "memory follows workflow",
		});
		expect(messages[0]?.activities).toEqual([
			{
				id: "a",
				tool: "mcp__slack__slack_search_public",
				source: "slack",
				kind: "other",
				title: "Finished",
				status: "done",
				detail: '{"token":"[REDACTED]","query":"hello"}',
				output: "token=[REDACTED]",
			},
			{
				id: "b",
				tool: "mem_save",
				source: "engram",
				kind: "memory",
				title: "Could not save a note",
				status: "failed",
				detail: '{"token":"[REDACTED]","query":"hello"}',
				output: "password=[REDACTED]",
			},
		]);
		for (const activity of messages[0]?.activities ?? [])
			console.log("activity example", JSON.stringify(activity));
	});

	it("streams reasoning, keeps start args at end, and matches live/history sanitization", () => {
		let emit: (event: SupervisorEvent) => void = () => {};
		const supervisor = {
			state: "stopped",
			launched: false,
			busy: false,
			onEvent: (listener: (event: SupervisorEvent) => void) => {
				emit = listener;
				return () => {};
			},
		} as unknown as AgentSupervisor;
		const received: ServerPayload[] = [];
		const bridge = new DotBridge(supervisor, {
			dataDir: "/unused",
			previewSecrets: () => ["instance-value"],
		});
		bridge.attach({ send: (payload) => received.push(payload) }, ["reasoning"]);
		emit({ type: "message_start", message: { role: "assistant" } });
		emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: reasoning } });
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ordinary text" } });
		emit({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "mem_save",
			args: { content: "instance-value" },
		});
		emit({ type: "tool_execution_end", toolCallId: "a", toolName: "mem_save", result, isError: false });
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: finalText },
					{ type: "thinking", thinking: reasoning },
				],
			},
		});
		expect(received.find((p) => p.type === "reasoning_delta")).toEqual({
			type: "reasoning_delta",
			messageId: "m1",
			delta: "memory follows workflow",
		});
		expect(received.find((p) => p.type === "message_delta")).toEqual({
			type: "message_delta",
			messageId: "m1",
			delta: "ordinary text",
		});
		expect(received.find((p) => p.type === "message_done")).toEqual({
			type: "message_done",
			messageId: "m1",
			text: `memory uses Gentle Dot.\n${code}`,
			reasoning: "memory follows workflow",
			at: expect.any(Number),
		});
		const activities = received.flatMap((p) => (p.type === "activity" ? [p.activity] : []));
		expect(activities).toHaveLength(2);
		expect(activities[0]).not.toHaveProperty("output");
		expect(activities[1]).toMatchObject({
			detail: '{"content":"[REDACTED]"}',
			output: "password=[REDACTED]",
			status: "done",
			source: "engram",
			tool: "mem_save",
		});
		expect(JSON.stringify(received)).not.toContain("instance-value");
	});

	it("preserves old history text and empty activities, and hides opaque thinking signatures", () => {
		expect(
			historyFromMessages([
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "Engram ready" },
			]),
		).toEqual([
			{ id: "h1", role: "user", text: "hello", activities: [] },
			{ id: "h2", role: "assistant", text: "memory ready", activities: [] },
		]);
		const history = historyFromMessages([
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true }],
			},
		]);
		expect(JSON.stringify(history)).not.toMatch(/opaque|reasoning/);
	});
});

describe("code-safe presentation", () => {
	it("keeps fenced and inline code byte-for-byte while rewriting prose", () => {
		expect(presentText(finalText)).toBe(`memory uses Gentle Dot.\n${code}`);
	});
	it("handles longer fences, unmatched fences and multi-backtick spans", () => {
		for (const text of ["````ts\n  Engram\n```\n  ODD\n````", "~~~\n    Engram", "`` Engram ` ODD ``"])
			expect(presentText(text)).toBe(text);
	});
});
