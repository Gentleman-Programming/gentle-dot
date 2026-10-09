import { describe, expect, it } from "vitest";
import { pruneScreenshots } from "../src/extensions/screenshot-context.ts";

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
