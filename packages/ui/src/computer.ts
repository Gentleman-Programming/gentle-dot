import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Computer control on macOS (S24): the desktop app's helper, reached through its Tauri commands.
 * Outside the desktop app (the web page, a VPS) every call is a no-op, so computer control is never offered.
 */

/** The helper's MCP address and its key for this launch of the app. */
export interface ComputerEndpoint {
	url: string;
	token: string;
}

export interface ComputerPermissions {
	accessibility: boolean;
	screenRecording: boolean;
}

export type ComputerPermission = keyof ComputerPermissions;

/** A control session the user allowed; `endsAt` in milliseconds since the epoch. */
export interface ComputerSession {
	endsAt?: number;
}

/** What the app reports on `computer://state` and from `computer_status`. */
interface ComputerStateEvent {
	active?: unknown;
	endsAt?: unknown;
}

/** The helper's endpoint, or null when the app has none (off macOS, or the helper did not start). */
export async function computerEndpoint(): Promise<ComputerEndpoint | null> {
	if (!isTauri()) return null;
	const endpoint = await invoke<Partial<ComputerEndpoint> | null>("computer_endpoint");
	return typeof endpoint?.url === "string" && typeof endpoint.token === "string"
		? { url: endpoint.url, token: endpoint.token }
		: null;
}

export function computerPermissions(): Promise<ComputerPermissions> {
	if (!isTauri()) return Promise.resolve({ accessibility: false, screenRecording: false });
	return invoke<ComputerPermissions>("computer_permissions");
}

/** Prompts for the permission and opens its System Settings pane. */
export function requestComputerPermission(kind: ComputerPermission): Promise<unknown> {
	if (!isTauri()) return Promise.resolve();
	return invoke("computer_request_permission", { kind });
}

/** Ends the session now; queued actions are dropped by the app. */
export function stopComputer(): void {
	if (isTauri()) void invoke("computer_stop");
}

export async function computerStatus(): Promise<ComputerSession | undefined> {
	if (!isTauri()) return undefined;
	return sessionOf(await invoke<ComputerStateEvent>("computer_status"));
}

export async function onComputerState(handler: (session: ComputerSession | undefined) => void) {
	if (!isTauri()) return () => {};
	const { listen } = await import("@tauri-apps/api/event");
	return listen<ComputerStateEvent>("computer://state", (event) => handler(sessionOf(event.payload)));
}

/** The session while it is active; an `endsAt` in seconds is read as such. */
function sessionOf(state: ComputerStateEvent | null | undefined): ComputerSession | undefined {
	if (state?.active !== true) return undefined;
	const endsAt = state.endsAt;
	if (typeof endsAt !== "number" || !Number.isFinite(endsAt)) return {};
	return { endsAt: endsAt < 1e12 ? endsAt * 1000 : endsAt };
}

/** `mm:ss` left until `endsAt`, never below zero. */
export function timeLeft(endsAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
