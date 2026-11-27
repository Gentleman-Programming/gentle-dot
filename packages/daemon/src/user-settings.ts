import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./private-file.ts";

/** Daemon-owned preferences, separate from the desktop's config.json writer. */
export class UserSettings {
	private readonly file: string;

	constructor(dataDir: string) {
		this.file = join(dataDir, "user-settings.json");
	}

	private read(): Record<string, unknown> {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("user-settings.json must contain an object.");
		const settings = value as Record<string, unknown>;
		if (settings.conversations !== undefined && typeof settings.conversations !== "boolean")
			throw new Error("conversations in user-settings.json must be a boolean.");
		return settings;
	}

	conversations(environment?: string): boolean {
		return (this.read().conversations as boolean | undefined) ?? environment === "1";
	}

	/** Synchronous read-modify-write: unknown keys survive and calls cannot interleave. */
	setConversations(enabled: boolean): void {
		if (typeof enabled !== "boolean") throw new Error("conversations must be a boolean.");
		const settings = this.read();
		writePrivateFile(this.file, `${JSON.stringify({ ...settings, conversations: enabled }, null, 2)}\n`);
	}
}
