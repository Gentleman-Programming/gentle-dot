import type { AgentState } from "@gentle-dot/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ConnectionInfo } from "./client.ts";

/** Bridge to the Tauri shell (docs/design.md §9). Every call is a no-op in the browser. */
export const inDesktop = (): boolean => isTauri();

export function connectionInfo(): Promise<ConnectionInfo> {
	return invoke<ConnectionInfo>("connection_info");
}

export function togglePanel(): void {
	void invoke("toggle_panel");
}

export function hidePanel(): void {
	if (inDesktop()) void invoke("hide_panel");
}

export function setDotState(state: AgentState): void {
	if (inDesktop()) void invoke("set_dot_state", { state });
}

export async function startDragging(): Promise<void> {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await getCurrentWindow().startDragging();
}

export async function onDesktopEvent(
	name: "dot://new-conversation" | "dot://panel-shown",
	handler: () => void,
) {
	if (!inDesktop()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	return listen(name, handler);
}
