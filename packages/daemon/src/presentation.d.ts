import type { ActivityKind } from "@gentle-dot/protocol";
/**
 * Turns an internal tool call into a neutral activity. Tool names never reach
 * the user; only the kind and a short human title do.
 */
export declare function describeTool(
	toolName: string,
	args: unknown,
): {
	kind: ActivityKind;
	title: string;
};
/** Plain text of a user or assistant message whose content is a string or content blocks. */
export declare function textOf(message: unknown): string;
