/** Internal names that must never reach the user (docs/design.md §5). */
export declare const HIDDEN_NAMES: RegExp[];
/** Rewrites internal names in harness-generated text shown to the user. */
export declare function presentText(text: string): string;
/** Informational notifications are harness chatter; warnings and errors still reach the user. */
export declare function shouldShowToast(level: "info" | "warning" | "error"): boolean;
/** Internal slash commands are not part of the product. */
export declare function isBlockedInput(text: string): boolean;
/** Writes the identity prompt to `<dataDir>/identity.md` and returns the agent arguments that load it. */
export declare function identityArgs(dataDir: string): string[];
