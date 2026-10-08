import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConversation } from "../src/conversations.ts";
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
