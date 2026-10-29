import type { ActivitySource, ServerPayload } from "@gentle-dot/protocol";
import { parseClientMessage } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { redactPreview } from "../src/activity-preview.ts";
import { DotBridge } from "../src/bridge.ts";
import { historyFromMessages } from "../src/conversations.ts";
import { sourceOf } from "../src/presentation.ts";
import type { AgentSupervisor, SupervisorEvent } from "../src/supervisor.ts";
import { presentText } from "../src/white-label.ts";

function setup(secrets: string[] = []) {
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
	const bridge = new DotBridge(supervisor, { dataDir: "/unused", previewSecrets: () => secrets });
	const legacy: ServerPayload[] = [];
	const capable: ServerPayload[] = [];
	bridge.attach({ send: (p) => legacy.push(p) });
	bridge.attach({ send: (p) => capable.push(p) }, ["reasoning"]);
	return { emit: (event: SupervisorEvent) => emit(event), legacy, capable };
}

const queryKeys = [
	"key",
	"token",
	"access_token",
	"api_key",
	"apikey",
	"sig",
	"signature",
	"secret",
	"password",
	"auth",
	"code",
];
const previewCases = [
	...queryKeys.map((key) => `https://host/?${key}=opaque-secret&safe=yes`),
	"https://user:opaque-secret@host/path",
	"mysql --password opaque-secret database",
	"mysql --password=opaque-secret database",
	"mysql -p opaque-secret database",
	"mysql -popaque-secret database",
	"curl --user user:opaque-secret https://host/path",
	"curl --user=user:opaque-secret https://host/path",
	"curl -u user:opaque-secret https://host/path",
	"curl -uuser:opaque-secret https://host/path",
	"tool --token opaque-secret",
	"tool --token=opaque-secret",
	"Cookie: first=safe; other=opaque-secret; last=second-secret",
	"Set-Cookie: first=safe; other=opaque-secret; last=second-secret; HttpOnly",
	`AIza${"A".repeat(35)}`,
	`AIza${"A".repeat(34)}-`,
	JSON.stringify({ subject: "Your login code", body: "Your code is 123456.", path: "notes.md" }),
	JSON.stringify({
		subject: "Your magic link",
		body: "Click https://host/magic/opaque-secret",
		path: "notes.md",
	}),
	JSON.stringify({
		subject: "Password reset",
		body: "Reset: https://host/reset/opaque-secret",
		path: "notes.md",
	}),
];

describe("S13.5 security regressions", () => {
	it.each(previewCases)("masks live and history previews for %s", (input) => {
		const { emit, capable } = setup();
		emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: input } });
		emit({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "bash",
			result: { content: [{ type: "text", text: input }] },
			isError: false,
		});
		const history = historyFromMessages([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: input } }],
			},
			{ role: "toolResult", toolCallId: "a", content: [{ type: "text", text: input }] },
		]);
		const activities = capable.flatMap((p) => (p.type === "activity" ? [p.activity] : []));
		expect(activities).toHaveLength(2);
		expect(history[0]?.activities[0]).toEqual(activities[1]);
		for (const activity of [...activities, ...(history[0]?.activities ?? [])]) {
			const json = JSON.stringify(activity);
			expect(json).not.toContain("opaque-secret");
			expect(json).not.toContain("second-secret");
			expect(json).not.toContain(`AIza${"A".repeat(35)}`);
			expect(json).not.toContain(`AIza${"A".repeat(34)}-`);
			expect(json).not.toContain("123456");
			expect(json).toContain("[REDACTED]");
		}
	});

	it.each([
		{ subject: "Your login code", body: "Your code is 123456. Expires in ten minutes." },
		{ subject: "Your magic link", body: "Click https://host/magic/opaque-secret to sign in." },
		{ subject: "Password reset", body: "Reset here: https://host/reset/opaque-secret" },
	])("redacts auth email values without destroying the record: $subject", (mail) => {
		const input = { ...mail, path: "notes.md" };
		const shown = JSON.parse(redactPreview(input, 2000));
		expect(shown.subject).toBe(mail.subject);
		expect(shown.path).toBe("notes.md");
		expect(shown.body).toContain("[REDACTED]");
		expect(shown.body).not.toMatch(/123456|opaque-secret/);
	});

	it("preserves benign sibling fields when prose mentions password reset", () => {
		const args = { text: "Document the password reset workflow", path: "notes.md" };
		expect(JSON.parse(redactPreview(args, 2000))).toEqual(args);
	});

	it("redacts full and split reasoning for capable clients; legacy clients receive none", () => {
		const token = "daemon-opaque-value-123456789";
		const connector = "connector-opaque-value-123456789";
		const { emit, capable, legacy } = setup([token, connector]);
		const thinking = `Engram considers ${token} and ${connector}; https://host/?key=opaque-secret`;
		emit({ type: "message_start", message: { role: "assistant" } });
		const split = thinking.indexOf(token) + 11;
		for (const delta of [thinking.slice(0, split), thinking.slice(split)]) {
			emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
			const wire = JSON.stringify(capable);
			expect(wire).not.toContain(token.slice(0, 11));
			expect(wire).not.toContain(token.slice(11));
		}
		const content = [
			{ type: "thinking", thinking },
			{ type: "text", text: "hello" },
		];
		emit({ type: "message_end", message: { role: "assistant", content } });
		const streamed = capable.flatMap((p) => (p.type === "reasoning_delta" ? [p.delta] : [])).join("");
		expect(streamed).toContain("memory considers");
		expect(streamed).toContain("[REDACTED]");
		const done = capable.find((p) => p.type === "message_done");
		const history = historyFromMessages([{ role: "assistant", content }], [token, connector]);
		expect(done?.reasoning).toBe(streamed);
		expect(history[0]?.reasoning).toBe(streamed);
		expect(JSON.stringify(capable)).not.toMatch(/daemon-opaque|connector-opaque|opaque-secret/);
		expect(legacy.some((p) => p.type === "reasoning_delta")).toBe(false);
		expect(legacy.find((p) => p.type === "message_done")).toEqual({
			type: "message_done",
			messageId: "m1",
			text: "hello",
		});
	});

	it("buffers unknown pattern credentials across deltas, not just known tokens", () => {
		const { emit, capable } = setup();
		emit({ type: "message_start", message: { role: "assistant" } });
		for (const delta of ["Reasoning token=split-", "opaque-value\nDone"])
			emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
		emit({ type: "message_end", message: { role: "assistant", content: [] } });
		const reasoning = capable.flatMap((p) => (p.type === "reasoning_delta" ? [p.delta] : [])).join("");
		expect(reasoning).toBe("Reasoning token=[REDACTED]\nDone");
	});

	it("parses opt-in capabilities while leaving legacy hello unchanged", () => {
		expect(parseClientMessage('{"type":"hello","token":"t","protocol":1}')).toEqual({
			type: "hello",
			token: "t",
			protocol: 1,
		});
		expect(
			parseClientMessage('{"type":"hello","token":"t","protocol":1,"capabilities":["reasoning"]}'),
		).toEqual({ type: "hello", token: "t", protocol: 1, capabilities: ["reasoning"] });
		for (const capabilities of ["reasoning", [1], null]) {
			expect(
				parseClientMessage(JSON.stringify({ type: "hello", token: "t", protocol: 1, capabilities })),
			).toEqual({ type: "hello", token: "t", protocol: 1 });
		}
	});

	it.each([
		"> ~~~ts\n>     const name = 'Engram';\n>       // ODD\n> ~~~",
		"- Example:\n    ~~~ts\n      const name = 'Engram';\n        // ODD\n    ~~~",
		"> ```ts\n>     const name = 'Engram';\n>       // ODD\n> ```",
		"- Example:\n    ```ts\n      const name = 'Engram';\n        // ODD\n    ```",
	])("preserves nested Markdown code bytes: %s", (code) => {
		expect(presentText(`Engram follows ODD.\n${code}\nGentle Shell.`)).toBe(
			`memory follows workflow.\n${code}\nGentle Dot.`,
		);
	});

	it.each<[string, ActivitySource]>([
		["bash_background", "shell"],
		["job_list", "shell"],
		["job_stop", "shell"],
		["monitor", "shell"],
		...["run", "continue", "result", "status", "cancel", "send_message", "list", "list_active"].map(
			(suffix) => [`subagent_${suffix}`, "subagent"] as [string, ActivitySource],
		),
	])("classifies %s as %s", (tool, source) => expect(sourceOf(tool)).toBe(source));
});
