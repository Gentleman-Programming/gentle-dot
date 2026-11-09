import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ASSISTANT_NAME,
	HIDDEN_NAMES,
	IDENTITY_SOURCE,
	identityArgs,
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

	it("supports custom assistant name (e.g. Toto)", () => {
		expect(presentText("Gentle Shell ready", "Toto")).toBe("Toto ready");
		expect(presentText("I am el Gentleman.", "Toto")).toBe("I am Toto.");
		expect(presentText("gentle-ai: review mode on", "Toto")).toBe("Toto: review mode on");
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

	it("customizes the identity file when assistantName is provided", () => {
		const tempDir = join(tmpdir(), `gentle-dot-test-${Date.now()}`);
		const args = identityArgs(tempDir, "Toto");
		expect(args).toEqual(["--append-system-prompt", join(tempDir, "identity.md")]);
		const written = readFileSync(join(tempDir, "identity.md"), "utf8");
		expect(written).toContain("# Product identity: Toto");
		expect(written).toContain("You are Toto, a personal assistant");
		expect(written).toContain('answer as Toto: a personal assistant');
		rmSync(tempDir, { recursive: true, force: true });
	});
});
