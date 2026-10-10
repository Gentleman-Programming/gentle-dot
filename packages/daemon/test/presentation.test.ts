import { describe, expect, it } from "vitest";
import { describeTool } from "../src/presentation.ts";

describe("describeTool", () => {
	it("titles a bash call by its status", () => {
		expect(describeTool("bash", {}, "running")).toEqual({ kind: "run", title: "Running a command" });
		expect(describeTool("bash", {}, "done")).toEqual({ kind: "run", title: "Ran a command" });
		expect(describeTool("bash", {}, "failed")).toEqual({ kind: "run", title: "A command failed" });
	});

	it("titles a read call with its file and tense", () => {
		expect(describeTool("read", { path: "/tmp/a.md" }, "running")).toEqual({
			kind: "read",
			title: "Reading a.md",
		});
		expect(describeTool("read", { path: "/tmp/a.md" }, "done")).toEqual({ kind: "read", title: "Read a.md" });
		expect(describeTool("read", { path: "/tmp/a.md" }, "failed")).toEqual({
			kind: "read",
			title: "Could not read a.md",
		});
	});

	it("titles a read call without a file", () => {
		expect(describeTool("read", {}, "done")).toEqual({ kind: "read", title: "Read a file" });
	});

	it("titles an edit call with its file and tense", () => {
		expect(describeTool("edit", { path: "/tmp/a.ts" }, "running")).toEqual({
			kind: "edit",
			title: "Editing a.ts",
		});
		expect(describeTool("write", { path: "/tmp/a.ts" }, "done")).toEqual({
			kind: "edit",
			title: "Edited a.ts",
		});
		expect(describeTool("edit", { path: "/tmp/a.ts" }, "failed")).toEqual({
			kind: "edit",
			title: "Could not edit a.ts",
		});
	});

	it("titles memory, delegate, search, and ask calls by their status", () => {
		expect(describeTool("mem_save", {}, "done").title).toBe("Saved a note");
		expect(describeTool("mem_search", {}, "done").title).toBe("Checked my notes");
		expect(describeTool("mem_save", {}, "failed").title).toBe("Could not save a note");
		expect(describeTool("subagent_run", {}, "done").title).toBe("Asked a helper");
		expect(describeTool("web_search", {}, "done").title).toBe("Looked things up online");
		expect(describeTool("grep", { pattern: "x" }, "done").title).toBe("Searched files");
		expect(describeTool("codegraph_query", {}, "failed").title).toBe("Could not search files");
		expect(describeTool("ask_user_choice", {}, "done").title).toBe("Asked you");
	});

	it("defaults to the running tense for callers that have no status yet", () => {
		expect(describeTool("bash", {})).toEqual({ kind: "run", title: "Running a command" });
	});

	it("titles unknown tools in all three tenses", () => {
		expect(describeTool("mystery", {}, "running").title).toBe("Working");
		expect(describeTool("mystery", {}, "done").title).toBe("Finished");
		expect(describeTool("mystery", {}, "failed").title).toBe("Failed");
	});
});
