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

export const DEFAULT_ASSISTANT_NAME = "Gentle Dot";

export function rewritesFor(assistantName: string = DEFAULT_ASSISTANT_NAME): [RegExp, string][] {
	return [
		[/\/gentle:[\w:-]+/gi, ""],
		[/\bel gentleman\b/gi, assistantName],
		[/\bgentle[ -]?(?:shell|ai|pi)\b/gi, assistantName],
		[/\bpi[ -]coding[ -]agent\b/gi, "assistant"],
		[/\bPi (?:coding agent|agent|runtime|harness)\b/g, "assistant"],
		[/\borganic driven development\b/gi, "my workflow"],
		[/\bODD\b/g, "workflow"],
		[/\bengram\b/gi, "memory"],
		[/\breceipt-driven development\b/gi, "review"],
		[/\bRDD\b/g, "review"],
	];
}

const DEFAULT_REWRITES = rewritesFor(DEFAULT_ASSISTANT_NAME);

/** Rewrites internal names in harness-generated text shown to the user. */
export function presentText(text: string, assistantName?: string): string {
	let shown = text;
	const rewrites = assistantName ? rewritesFor(assistantName) : DEFAULT_REWRITES;
	for (const [pattern, replacement] of rewrites) shown = shown.replace(pattern, replacement);
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
export function identityArgs(dataDir: string, assistantName: string = DEFAULT_ASSISTANT_NAME): string[] {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, "identity.md");
	let content = readFileSync(IDENTITY_SOURCE, "utf8");
	if (assistantName !== DEFAULT_ASSISTANT_NAME) {
		content = content.replaceAll("Gentle Dot", assistantName);
	}
	writeFileSync(path, content);
	return ["--append-system-prompt", path];
}
