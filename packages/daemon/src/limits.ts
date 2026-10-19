/**
 * The request ceiling each model was observed to answer under (S1).
 *
 * The provider's real limit cannot be known: the failure carries no body and the number differs by
 * model. So nothing here is a claim about the provider. A ceiling is learned from one observation —
 * a chat the provider refused and, sent again after the chat was rotated, answered — and it is kept
 * a margin *below* the size that was refused, never at it.
 *
 * The daemon writes this file in its state folder and the engine's extension reads it from there
 * (`extensions/screenshot-context.ts`), because the extension runs in the engine's own process and
 * can share state with the daemon only through a file. Reads are cheap and fail closed: anything
 * missing, torn, or unreadable leaves the configured budget in force.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFile } from "./private-file.ts";

/** The daemon's file for the learned ceilings, under its state folder. */
export const LIMITS_FILE_NAME = "provider-limits.json";

/** Set by the supervisor for the engine it starts: where the extension finds the file. */
export const LIMITS_FILE_ENV = "GENTLE_DOT_PROVIDER_LIMITS_FILE";

/**
 * How far below the refused size a learned ceiling sits. The refused size is the live session file's,
 * which carries the request plus entry ids, timestamps, and JSON framing, so it is larger than the
 * request itself; a quarter below it stays under the refused request even with that overhead, and
 * leaves room for the reply and provider-side accounting the shaper does not count. Not the
 * provider's limit: only where the next requests are kept.
 */
export const CEILING_MARGIN = 0.75;

export interface LearnedLimits {
	/** The model the daemon last saw the engine select: which ceiling the extension reads. */
	model?: string;
	/** An observed ceiling in bytes, by model. */
	ceilings?: Record<string, number>;
}

export function limitsFile(dataDir: string): string {
	return join(dataDir, LIMITS_FILE_NAME);
}

/** A size read from the file, or nothing when it is not one a request could be held under. */
function sizeOf(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

/**
 * The store as it is on disk. A missing file, a torn write, or anything that is not the shape
 * written here reads as empty, so nothing learned is ever guessed.
 */
export function readLimits(file: string | undefined): LearnedLimits {
	if (!file) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	const { model, ceilings } = parsed as { model?: unknown; ceilings?: unknown };
	const limits: LearnedLimits = {};
	if (typeof model === "string" && model) limits.model = model;
	if (typeof ceilings === "object" && ceilings !== null) {
		const sizes: Record<string, number> = {};
		for (const [name, value] of Object.entries(ceilings)) {
			const size = sizeOf(value);
			if (name && size !== undefined) sizes[name] = size;
		}
		if (Object.keys(sizes).length > 0) limits.ceilings = sizes;
	}
	return limits;
}

/** The ceiling learned for `model`, or nothing when none was ever observed for it. */
export function learnedCeiling(limits: LearnedLimits, model: string | undefined): number | undefined {
	return model ? limits.ceilings?.[model] : undefined;
}

/**
 * The budget one request is shaped under: the configured one, lowered by the ceiling learned for the
 * model in use. The ceiling may never raise it: a provider that answered under a smaller budget is
 * not evidence that it would answer under a larger one.
 */
export function effectiveBudget(configured: number, limits: LearnedLimits, model?: string): number {
	const ceiling = learnedCeiling(limits, model ?? limits.model);
	return ceiling !== undefined && ceiling < configured ? ceiling : configured;
}

/** The ceiling a refused request of `refusedBytes` teaches: a margin under it, never at it. */
export function ceilingBelow(refusedBytes: number): number | undefined {
	const ceiling = Math.floor(refusedBytes * CEILING_MARGIN);
	return ceiling > 0 ? ceiling : undefined;
}

/** Reads the store, applies `change`, and writes it whole; a failure leaves the file as it was. */
function update(file: string, change: (current: LearnedLimits) => LearnedLimits): void {
	mkdirSync(dirname(file), { recursive: true });
	writePrivateFile(file, `${JSON.stringify(change(readLimits(file)))}\n`);
}

/**
 * Records the model the engine selected, so the extension resolves the ceiling of the model it is
 * shaping for. Best effort: a file that cannot be written leaves the configured budget in force.
 */
export function noteModel(file: string, model: string | undefined): void {
	if (!model || readLimits(file).model === model) return;
	try {
		update(file, (current) => ({ ...current, model }));
	} catch {
		// The daemon's own file could not be written: nothing learned, nothing broken.
	}
}

/**
 * Records what one refused chat taught about `model`. A ceiling only ever tightens: a larger refusal
 * later says the provider answers bigger requests, not that an earlier, smaller answer is wrong, and
 * re-raising one would undo the learning that keeps requests under it. Returns the ceiling the store
 * now holds, or undefined when nothing could be written.
 */
export function recordCeiling(
	file: string | undefined,
	model: string | undefined,
	refusedBytes: number,
): number | undefined {
	const ceiling = ceilingBelow(refusedBytes);
	if (!file || !model || ceiling === undefined) return undefined;
	let kept = ceiling;
	try {
		update(file, (current) => {
			const previous = current.ceilings?.[model];
			if (previous !== undefined && previous <= ceiling) {
				kept = previous;
				return current;
			}
			return { ...current, ceilings: { ...current.ceilings, [model]: ceiling } };
		});
	} catch {
		return undefined;
	}
	return kept;
}
