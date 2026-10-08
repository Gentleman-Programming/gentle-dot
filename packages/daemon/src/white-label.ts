import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Internal names that must never reach the user (docs/design.md §5). */
export const HIDDEN_NAMES: RegExp[] = [
	/gentle[ -]?shell/i,
	/el gentleman/i,
	/gentle[ -]?ai/i,
	/gentle[ -]?pi/i,
	/\bengram\b/i,
	/\bODD\b/,
	/organic driven development/i,
	/\/gentle:/i,
	/\bRDD\b/,
	/\bpi[ -]coding[ -]agent\b/i,
];

const REWRITES: [RegExp, string][] = [
	[/\/gentle:[\w:-]+/gi, ""],
	[/\bel gentleman\b/gi, "Gentle Dot"],
	[/\bgentle[ -]?(?:shell|ai|pi)\b/gi, "Gentle Dot"],
	[/\bpi[ -]coding[ -]agent\b/gi, "assistant"],
	[/\bPi (?:coding agent|agent|runtime|harness)\b/g, "assistant"],
	[/\borganic driven development\b/gi, "my workflow"],
	[/\bODD\b/g, "workflow"],
	[/\bengram\b/gi, "memory"],
	[/\breceipt-driven development\b/gi, "review"],
	[/\bRDD\b/g, "review"],
];

/** Rewrites internal names in harness-generated text shown to the user. */
export function presentText(text: string): string {
	let shown = text;
	for (const [pattern, replacement] of REWRITES) shown = shown.replace(pattern, replacement);
	return shown.replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1");
}

/** Informational notifications are harness chatter; warnings and errors still reach the user. */
export function shouldShowToast(level: "info" | "warning" | "error"): boolean {
	return level !== "info";
}

/** Internal slash commands are not part of the product. */
export function isBlockedInput(text: string): boolean {
	return /^\s*\/gentle:/i.test(text);
}

export const IDENTITY_SOURCE = new URL("./identity.md", import.meta.url);

/** Writes the identity prompt to `<dataDir>/identity.md` and returns the agent arguments that load it. */
export function identityArgs(dataDir: string): string[] {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, "identity.md");
	writeFileSync(path, readFileSync(IDENTITY_SOURCE, "utf8"));
	return ["--append-system-prompt", path];
}
