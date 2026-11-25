import type { AgentState, ClientMessage } from "@gentle-dot/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ConnectionInfo } from "./client.ts";

/** Bridge to the Tauri shell (docs/design.md §9). Every call is a no-op in the browser. */
export const inDesktop = (): boolean => isTauri();

export function connectionInfo(): Promise<ConnectionInfo> {
	return invoke<ConnectionInfo>("connection_info");
}

const runtimeStates = ["present", "missing", "unknown"] as const;
const profileStates = ["no-conflict-found", "new", "owner-mismatch", "unsafe", "unknown"] as const;
const serviceStates = ["starting", "ready", "blocked", "failed", "unknown"] as const;

export interface StartupReadiness {
	runtime: (typeof runtimeStates)[number];
	profile: (typeof profileStates)[number];
	service: (typeof serviceStates)[number];
}

function isState<T extends string>(value: unknown, states: readonly T[]): value is T {
	return states.some((state) => state === value);
}

/** Panel-only metadata check. Never pass through arbitrary native strings. */
export async function startupReadiness(): Promise<StartupReadiness | null | "unavailable"> {
	try {
		const value = await invoke<unknown>("startup_readiness");
		if (value === null) return null;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const { runtime, profile, service } = value as Record<string, unknown>;
			if (isState(runtime, runtimeStates) && isState(profile, profileStates) && isState(service, serviceStates)) {
				return { runtime, profile, service };
			}
		}
	} catch {
		// A missing command or IPC refusal is not evidence that the service itself failed.
	}
	return "unavailable";
}

/**
 * A connector change from the panel (S25.2): the app sends it to the daemon over its private
 * channel, on behalf of this window (`clientId`, from `ready`). Rejects with the app's reason.
 */
export function connectorCommand(clientId: string, message: ClientMessage): Promise<void> {
	return invoke<void>("connector_command", { clientId, message });
}

export function togglePanel(): void {
	void invoke("toggle_panel");
}

export function hidePanel(): void {
	if (inDesktop()) void invoke("hide_panel");
}

export function setDotState(state: AgentState, conversationsEnabled?: boolean): void {
	if (inDesktop())
		void invoke("set_dot_state", {
			state,
			...(conversationsEnabled === undefined ? {} : { conversationsEnabled }),
		});
}

/** Opens a web page (sign-in) in the user's browser. Only http and https. */
export function openUrl(url: string): void {
	if (!/^https?:\/\//i.test(url)) return;
	if (inDesktop()) {
		void import("@tauri-apps/plugin-opener").then(({ openUrl: open }) => open(url));
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

export async function startDragging(): Promise<void> {
	const { getCurrentWindow } = await import("@tauri-apps/api/window");
	await getCurrentWindow().startDragging();
}

/**
 * `dot://assistant-ready`: the app's assistant just started answering (at launch or after Restart
 * assistant), so a window it refused can ask `connection_info` again (S35.2).
 */
export async function onDesktopEvent(
	name: "dot://new-conversation" | "dot://panel-shown" | "dot://assistant-ready",
	handler: () => void,
) {
	if (!inDesktop()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	return listen(name, handler);
}
