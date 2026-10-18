import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyRequestBudget,
	DEFAULT_REQUEST_BUDGET,
	pruneScreenshots,
	REQUEST_BUDGET_ENV,
} from "../src/extensions/screenshot-context.ts";

const image = (data: string) => ({ type: "image", data, mimeType: "image/jpeg" });
const meta = (frontApp: string) => ({
	type: "text",
	text: JSON.stringify({ frontApp, imageHeight: 720, imageWidth: 1280, scale: 0.5 }),
});
const result = (tool: string, content: object[]) => ({
	role: "toolResult",
	toolCallId: `${tool}-${content.length}`,
	toolName: `mcp__computer__${tool}`,
	content,
	isError: false,
});

describe("pruneScreenshots (S24.10)", () => {
	it("keeps only the last screenshot as an image and logs each earlier one as a line", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "open Safari" }] },
			result("screenshot", [image("AAA"), meta("Finder")]),
			result("click", [
				{ type: "text", text: "Click at (412, 230) in Safari: done." },
				image("BBB"),
				meta("Safari"),
			]),
			result("screenshot", [image("CCC"), meta("Safari")]),
		];
		const pruned = pruneScreenshots(messages);

		expect(pruned[1]).toEqual({
			...messages[1],
			content: [{ type: "text", text: "[earlier screenshot omitted: screenshot in Finder]" }],
		});
		expect(pruned[2]).toEqual({
			...messages[2],
			content: [
				{ type: "text", text: "Click at (412, 230) in Safari: done." },
				{ type: "text", text: "[earlier screenshot omitted: click in Safari]" },
			],
		});
		expect(pruned[3]).toBe(messages[3]);
		expect(pruned[0]).toBe(messages[0]);
	});

	it("leaves the history it was given untouched", () => {
		const first = result("screenshot", [image("AAA"), meta("Finder")]);
		const messages = [first, result("screenshot", [image("BBB"), meta("Mail")])];
		const before = JSON.stringify(messages);
		pruneScreenshots(messages);
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("never touches images that are not computer screenshots", () => {
		const pasted = { role: "user", content: [{ type: "text", text: "look" }, image("USER")] };
		const other = {
			role: "toolResult",
			toolName: "read",
			toolCallId: "r",
			content: [image("FILE")],
			isError: false,
		};
		const messages = [pasted, other, result("screenshot", [image("AAA"), meta("Finder")])];
		const pruned = pruneScreenshots(messages);
		expect(pruned[0]).toBe(pasted);
		expect(pruned[1]).toBe(other);
		expect(pruned[2]).toBe(messages[2]);
	});

	it("returns the same array when there is at most one screenshot", () => {
		const messages = [{ role: "user", content: "hi" }, result("screenshot", [image("AAA"), meta("Finder")])];
		expect(pruneScreenshots(messages)).toBe(messages);
	});
});

const fill = (size: number) => "A".repeat(size);
const toolText = (text: string) => ({ type: "text", text });
const toolResult = (toolName: string, content: object[]) => ({
	role: "toolResult",
	toolCallId: `${toolName}-${content.length}`,
	toolName,
	content,
	isError: false,
});
const shot = (data: string, frontApp: string) =>
	toolResult("mcp__computer__screenshot", [image(data), meta(frontApp)]);

/** An environment budget for one case: the numbers stay small so the fixtures read as what they are. */
const budgetOf = (bytes: number) => vi.stubEnv(REQUEST_BUDGET_ENV, String(bytes));

const truncated = (removed: number) =>
	`[truncated: ${removed} characters removed to keep the request under its size budget]`;

describe("applyRequestBudget (S1, S2)", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("drops the oldest image first and keeps the newest one", () => {
		budgetOf(6000);
		const messages = [
			{ role: "user", content: "compare these" },
			shot(fill(4000), "Finder"),
			shot(fill(4000), "Mail"),
		];
		const shaped = applyRequestBudget(messages);

		expect(shaped).not.toBe(messages);
		expect(shaped[1]).toEqual({
			...messages[1],
			content: [{ type: "text", text: "[earlier screenshot omitted: screenshot in Finder]" }],
		});
		expect(shaped[2]).toBe(messages[2]);
		expect(shaped[0]).toBe(messages[0]);
	});

	it("drops an image from a tool that is not the computer", () => {
		budgetOf(6000);
		const messages = [
			toolResult("read", [toolText("file contents"), image(fill(4000))]),
			shot(fill(4000), "Mail"),
		];
		const shaped = applyRequestBudget(messages);

		expect(shaped[0]).toEqual({
			...messages[0],
			content: [toolText("file contents"), toolText("[earlier screenshot omitted: read]")],
		});
		expect(shaped[1]).toBe(messages[1]);
	});

	it("names the tool the dropped image came from", () => {
		budgetOf(6000);
		const messages = [
			toolResult("mcp__playwright__screenshot", [image(fill(4000)), toolText("shot ok")]),
			shot(fill(4000), "Mail"),
		];
		const shaped = applyRequestBudget(messages);

		expect(shaped[0]).toEqual({
			...messages[0],
			content: [toolText("shot ok"), toolText("[earlier screenshot omitted: mcp__playwright__screenshot]")],
		});
	});

	it("leaves everything untouched when the request is under budget", () => {
		budgetOf(100_000);
		const messages = [
			{ role: "user", content: "compare these" },
			shot(fill(4000), "Finder"),
			shot(fill(4000), "Mail"),
			toolResult("bash", [toolText("y".repeat(5000))]),
		];

		expect(applyRequestBudget(messages)).toBe(messages);
	});

	it("never drops the newest image, even when that leaves the request over budget", () => {
		budgetOf(3000);
		const messages = [shot(fill(4000), "Finder"), shot(fill(4000), "Mail")];
		const shaped = applyRequestBudget(messages);

		expect(shaped[0]).toEqual({
			...messages[0],
			content: [{ type: "text", text: "[earlier screenshot omitted: screenshot in Finder]" }],
		});
		expect(shaped[1]).toBe(messages[1]);
		expect(shaped[1]).toEqual(messages[1]);
	});

	it("leaves tool text alone when dropping images is enough", () => {
		budgetOf(6000);
		const messages = [
			toolResult("bash", [toolText("y".repeat(1500))]),
			shot(fill(4000), "Finder"),
			shot(fill(4000), "Mail"),
		];
		const shaped = applyRequestBudget(messages);

		expect(shaped[1]).toEqual({
			...messages[1],
			content: [{ type: "text", text: "[earlier screenshot omitted: screenshot in Finder]" }],
		});
		expect(shaped[0]).toBe(messages[0]);
		expect(shaped[2]).toBe(messages[2]);
	});

	it("truncates the oldest large tool text, with a marker, when images alone are not enough", () => {
		budgetOf(4000);
		const messages = [
			toolResult("bash", [toolText("O".repeat(6000))]),
			toolResult("read", [toolText("z"), image(fill(1000))]),
		];
		const shaped = applyRequestBudget(messages);

		expect(shaped[0]).toEqual({
			...messages[0],
			content: [toolText("O".repeat(500) + truncated(5500))],
		});
		expect(shaped[1]).toBe(messages[1]);
	});

	it("never modifies user or assistant messages, even over budget", () => {
		budgetOf(1000);
		const messages = [
			{ role: "user", content: [toolText("U".repeat(5000))] },
			{ role: "assistant", content: [toolText("A".repeat(5000))] },
			toolResult("read", [toolText("z"), image(fill(2000))]),
		];

		expect(applyRequestBudget(messages)).toBe(messages);
	});

	it("reads the budget from the environment", () => {
		const messages = [shot(fill(4000), "Finder"), shot(fill(4000), "Mail")];

		budgetOf(6_000_000);
		expect(applyRequestBudget(messages)).toBe(messages);

		budgetOf(6000);
		expect(applyRequestBudget(messages)).not.toBe(messages);
	});

	it("falls back to the documented default when the environment value is not a size", () => {
		const half = Math.ceil(DEFAULT_REQUEST_BUDGET / 2) + 1;
		const messages = [shot(fill(half), "Finder"), shot(fill(half), "Mail")];

		for (const value of ["", "not a size", "0", "-1"]) {
			vi.stubEnv(REQUEST_BUDGET_ENV, value);
			expect(applyRequestBudget(messages)).not.toBe(messages);
		}
	});

	it("starts from a default well below the request size that failed", () => {
		expect(DEFAULT_REQUEST_BUDGET).toBeGreaterThan(0);
		expect(DEFAULT_REQUEST_BUDGET).toBeLessThan(16 * 1024 * 1024);
	});
});
