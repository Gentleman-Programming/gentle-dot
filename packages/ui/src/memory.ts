import { invoke } from "@tauri-apps/api/core";

/**
 * The assistant's memory mode (SW9): the user's own Engram (`shared`, the default) or a private
 * store of the assistant's own (`private`), kept under `<dataDir>/home/.engram` on port 7438.
 */
export type MemoryMode = "shared" | "private";

/**
 * The memory mode as the desktop app reports it (SW9). A `memory` in `config.json` that is neither
 * `shared` nor `private` comes as `memory: null` with the daemon's own `error`; it is never a mode.
 */
export type MemoryInfo = { memory: MemoryMode; error?: undefined } | { memory: null; error: string };

export function loadMemory(): Promise<MemoryInfo> {
	return invoke<MemoryInfo>("memory_get");
}

/** Saves the mode and restarts the assistant; resolves with the saved value or rejects with its reason. */
export async function saveMemory(memory: MemoryMode): Promise<MemoryMode> {
	const result = await invoke<MemoryInfo>("memory_set", { memory });
	if (result.memory === null) throw new Error(result.error);
	return result.memory;
}
