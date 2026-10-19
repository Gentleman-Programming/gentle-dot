import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pageHistory, resolveConversation } from "../src/conversations.ts";
import { tempDir } from "./helpers.ts";

describe("resolveConversation", () => {
	it("resolves a session file inside the sessions folder", () => {
		const sessions = join(tempDir(), "sessions");
		mkdirSync(join(sessions, "nested"), { recursive: true });
		writeFileSync(join(sessions, "nested", "a.jsonl"), "");
		expect(resolveConversation(sessions, "nested/a.jsonl")).toBe(join(sessions, "nested", "a.jsonl"));
		expect(resolveConversation(sessions, "../a.jsonl")).toBeUndefined();
	});

	it("refuses a symlink that leads outside the sessions folder", () => {
		const root = tempDir();
		const sessions = join(root, "sessions");
		mkdirSync(join(root, "elsewhere"), { recursive: true });
		mkdirSync(sessions);
		writeFileSync(join(root, "elsewhere", "secret.jsonl"), "");
		symlinkSync(join(root, "elsewhere", "secret.jsonl"), join(sessions, "link.jsonl"));
		symlinkSync(join(root, "elsewhere"), join(sessions, "dir"));
		expect(resolveConversation(sessions, "link.jsonl")).toBeUndefined();
		expect(resolveConversation(sessions, "dir/secret.jsonl")).toBeUndefined();
	});
});

function writeSession(file: string, messages: Record<string, unknown>[]): void {
	const lines = [
		{ type: "session", version: 3, id: file, timestamp: new Date().toISOString(), cwd: "/" },
		...messages.map((message) => ({ type: "message", message })),
	];
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const shown = (messages: { role: string; text: string }[]) => messages.map((m) => `${m.role}:${m.text}`);

describe("pageHistory and a recovered turn", () => {
	it("shows the refused question once when the next session re-sends it", () => {
		const dir = tempDir();
		const previous = join(dir, "previous.jsonl");
		const next = join(dir, "next.jsonl");
		writeSession(previous, [
			{ role: "user", content: "keep" },
			{ role: "assistant", content: [{ type: "text", text: "Echo: keep" }] },
			{ role: "user", content: "big" },
			{ role: "assistant", content: [], stopReason: "error" },
		]);
		writeSession(next, [
			{ role: "user", content: "big" },
			{ role: "assistant", content: [{ type: "text", text: "Echo: big" }] },
		]);
		expect(shown(pageHistory([previous, next], 100).messages)).toEqual([
			"user:keep",
			"assistant:Echo: keep",
			"user:big",
			"assistant:Echo: big",
		]);
	});

	it("keeps the previous answer when the trailing turn is real, not the empty one a failure leaves", () => {
		const dir = tempDir();
		const previous = join(dir, "previous.jsonl");
		const next = join(dir, "next.jsonl");
		writeSession(previous, [
			{ role: "user", content: "big" },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		writeSession(next, [
			{ role: "user", content: "big" },
			{ role: "assistant", content: [{ type: "text", text: "again" }] },
		]);
		expect(shown(pageHistory([previous, next], 100).messages)).toEqual([
			"user:big",
			"assistant:answer",
			"user:big",
			"assistant:again",
		]);
	});

	it("keeps a turn where a tool ran, even when the next session opens with the same message", () => {
		const dir = tempDir();
		const previous = join(dir, "previous.jsonl");
		const next = join(dir, "next.jsonl");
		writeSession(previous, [
			{ role: "user", content: "big" },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
		]);
		writeSession(next, [
			{ role: "user", content: "big" },
			{ role: "assistant", content: [{ type: "text", text: "again" }] },
		]);
		expect(shown(pageHistory([previous, next], 100).messages)).toEqual([
			"user:big",
			"assistant:",
			"user:big",
			"assistant:again",
		]);
	});
});
