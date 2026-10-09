import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	HIDDEN_NAMES,
	IDENTITY_SOURCE,
	isBlockedInput,
	presentText,
	shouldShowToast,
} from "../src/white-label.ts";

describe("presentText", () => {
	it.each([
		["Gentle Shell ready", "Gentle Dot ready"],
		["gentle-shell is loading", "Gentle Dot is loading"],
		["I am el Gentleman.", "I am Gentle Dot."],
		["Gentle AI review mode is on", "Gentle Dot review mode is on"],
		["Saved to Engram", "Saved to memory"],
		["Following ODD", "Following workflow"],
		["Organic Driven Development keeps it tidy", "my workflow keeps it tidy"],
		["Run /gentle:status to check", "Run to check"],
		["Started the Pi coding agent", "Started the assistant"],
		["RDD is enabled", "review is enabled"],
	])("rewrites %j", (input, expected) => {
		expect(presentText(input)).toBe(expected);
	});

	it("leaves ordinary text alone", () => {
		const text = "Pick a color: Pi is 3.14, odd numbers are fine, and gentle reminders help.";
		expect(presentText(text)).toBe(text);
	});

	it("leaves none of the hidden names in recorded startup events", () => {
		const recorded = [
			"Gentle Shell ready",
			"el Gentleman loaded ODD",
			"gentle-ai: review mode on (decided by global)",
			"Engram connected · project gentle-pi",
		];
		for (const text of recorded) {
			const shown = presentText(text);
			for (const name of HIDDEN_NAMES) expect(shown, shown).not.toMatch(name);
		}
	});
});

describe("shouldShowToast", () => {
	it("hides informational chatter and keeps warnings and errors", () => {
		expect(shouldShowToast("info")).toBe(false);
		expect(shouldShowToast("warning")).toBe(true);
		expect(shouldShowToast("error")).toBe(true);
	});
});

describe("isBlockedInput", () => {
	it("blocks internal slash commands only", () => {
		expect(isBlockedInput("/gentle:yolo")).toBe(true);
		expect(isBlockedInput("  /gentle:status now")).toBe(true);
		expect(isBlockedInput("What does /gentle mean?")).toBe(false);
		expect(isBlockedInput("hello")).toBe(false);
	});
});

describe("memory scope in the identity (S23, L85)", () => {
	const identity = readFileSync(IDENTITY_SOURCE, "utf8");

	it("saves only to the gentle-dot project", () => {
		expect(identity).toMatch(/save[^.\n]*`gentle-dot`/i);
	});

	it("searches the user's whole memory, not only gentle-dot", () => {
		expect(identity).toMatch(/all_projects: true/);
		expect(identity).not.toMatch(/save or search memories, always use that project/);
	});
});
