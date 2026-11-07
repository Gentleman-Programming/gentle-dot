import { invoke } from "@tauri-apps/api/core";

/**
 * The assistant's memory mode (SW9): the user's own Engram (`shared`, the default) or a private
 * store of the assistant's own (`private`), kept under `<dataDir>/home/.engram` on port 7438.
 */
export type MemoryMode = "shared" | "private";

/** The memory mode as the desktop app reports it (SW9). */
export interface MemoryInfo {
	memory: MemoryMode;
}

export function loadMemory(): Promise<MemoryInfo> {
	return invoke<MemoryInfo>("memory_get");
}

/** Saves the mode and restarts the assistant; resolves with the saved value or rejects with its reason. */
export async function saveMemory(memory: MemoryMode): Promise<MemoryMode> {
	const result = await invoke<MemoryInfo>("memory_set", { memory });
	return result.memory;
}
