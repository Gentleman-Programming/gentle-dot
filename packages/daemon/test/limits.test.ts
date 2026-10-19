import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST_BUDGET } from "../src/extensions/screenshot-context.ts";
import {
	CEILING_MARGIN,
	effectiveBudget,
	LIMITS_FILE_NAME,
	learnedCeiling,
	limitsFile,
	noteModel,
	readLimits,
	recordCeiling,
} from "../src/limits.ts";
import { tempDir } from "./helpers.ts";

describe("the learned ceiling store (S1)", () => {
	it("lives in the daemon's state folder, under a name of its own", () => {
		expect(LIMITS_FILE_NAME).toBe("provider-limits.json");
		expect(limitsFile("/state")).toBe(join("/state", "provider-limits.json"));
	});

	it("records the ceiling of one model a margin below the size that was refused", () => {
		const file = limitsFile(tempDir());

		const ceiling = recordCeiling(file, "model-a", 1_000_000);

		expect(ceiling).toBe(Math.floor(1_000_000 * CEILING_MARGIN));
		expect(ceiling).toBe(750_000);
		expect(ceiling).toBeLessThan(1_000_000);
		expect(CEILING_MARGIN).toBeGreaterThan(0);
		expect(CEILING_MARGIN).toBeLessThan(1);
		expect(readLimits(file).ceilings).toEqual({ "model-a": 750_000 });
	});

	it("only ever tightens: a bigger refusal later does not raise what was learned", () => {
		const file = limitsFile(tempDir());

		recordCeiling(file, "model-a", 1_000_000);
		// A bigger refusal says the provider answers larger requests; it is not news to store.
		expect(recordCeiling(file, "model-a", 2_000_000)).toBe(750_000);
		expect(learnedCeiling(readLimits(file), "model-a")).toBe(750_000);

		expect(recordCeiling(file, "model-a", 500_000)).toBe(375_000);
		expect(learnedCeiling(readLimits(file), "model-a")).toBe(375_000);
	});

	it("publishes the model the engine is on, so the extension knows which ceiling to read", () => {
		const file = limitsFile(tempDir());

		noteModel(file, "model-a");
		expect(readLimits(file).model).toBe("model-a");

		noteModel(file, "model-b");
		expect(readLimits(file).model).toBe("model-b");
	});

	it("applies the ceiling of one model to that model alone", () => {
		const limits = { ceilings: { "model-a": 3_000, "model-b": 7_000 } };

		expect(learnedCeiling(limits, "model-a")).toBe(3_000);
		expect(learnedCeiling(limits, "model-b")).toBe(7_000);
		expect(learnedCeiling(limits, "model-c")).toBeUndefined();
		expect(effectiveBudget(10_000, limits, "model-a")).toBe(3_000);
		expect(effectiveBudget(10_000, limits, "model-b")).toBe(7_000);
		expect(effectiveBudget(10_000, limits, "model-c")).toBe(10_000);
	});

	it("may only lower the configured budget, never raise it", () => {
		expect(effectiveBudget(6_000, { ceilings: { m: 100_000 } }, "m")).toBe(6_000);
		expect(effectiveBudget(6_000, { ceilings: { m: 6_000 } }, "m")).toBe(6_000);
		expect(effectiveBudget(6_000, { ceilings: { m: 5_999 } }, "m")).toBe(5_999);
		expect(effectiveBudget(6_000, {}, "m")).toBe(6_000);
		expect(effectiveBudget(6_000, { model: "m" })).toBe(6_000);
	});

	it("leaves the configured budget in force when the file is missing, corrupt, or unreadable", () => {
		const dir = tempDir();
		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{not json");
		// A folder in the file's place fails to read the same way on every platform, even as root.
		const unreadable = join(dir, "a-directory");
		mkdirSync(unreadable);

		for (const file of [undefined, join(dir, "missing.json"), corrupt, unreadable]) {
			const limits = readLimits(file);
			expect(limits, String(file)).toEqual({});
			expect(effectiveBudget(DEFAULT_REQUEST_BUDGET, limits), String(file)).toBe(DEFAULT_REQUEST_BUDGET);
		}
	});

	it("drops entries it cannot trust instead of reading a nonsense ceiling", () => {
		const file = limitsFile(tempDir());
		writeFileSync(file, JSON.stringify({ model: 7, ceilings: { good: 4_000, text: "big", zero: 0, "": 9 } }));

		expect(readLimits(file)).toEqual({ ceilings: { good: 4_000 } });
	});

	it("never throws when it cannot write, so the daemon and the engine keep running", () => {
		const dir = tempDir();
		const blocker = join(dir, "a-file");
		writeFileSync(blocker, "x");
		const impossible = join(blocker, "provider-limits.json");

		expect(() => recordCeiling(impossible, "model-a", 1_000)).not.toThrow();
		expect(() => noteModel(impossible, "model-a")).not.toThrow();
		expect(readLimits(impossible)).toEqual({});
	});
});
