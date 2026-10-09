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

/** Yolo mode (S24.9): risky actions run without asking; `endsAt` in milliseconds since the epoch. */
export interface ComputerYolo {
	endsAt?: number;
}

/** The session while one is active, and yolo mode while it is on; they come and go separately. */
export interface ComputerState {
	session?: ComputerSession;
	yolo?: ComputerYolo;
}

/** What the app reports on `computer://state` and from `computer_status`. */
interface ComputerStateEvent {
	active?: unknown;
	endsAt?: unknown;
	yolo?: unknown;
	yoloEndsAt?: unknown;
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

/**
 * Asks the app to turn yolo mode on or off. Turning it on shows the app's own confirmation, and
 * the answer arrives on `computer://state`; nothing here assumes it.
 */
export function setComputerYolo(enabled: boolean): Promise<unknown> {
	if (!isTauri()) return Promise.resolve();
	return invoke("computer_set_yolo", { enabled });
}

export async function computerStatus(): Promise<ComputerState> {
	if (!isTauri()) return {};
	return stateOf(await invoke<ComputerStateEvent>("computer_status"));
}

/** The event API, imported once: the glow overlay subscribes to two events at the same time. */
let eventApi: Promise<typeof import("@tauri-apps/api/event")> | undefined;
function events() {
	eventApi ??= import("@tauri-apps/api/event");
	return eventApi;
}

export async function onComputerState(handler: (state: ComputerState) => void) {
	if (!isTauri()) return () => {};
	const { listen } = await events();
	return listen<ComputerStateEvent>("computer://state", (event) => handler(stateOf(event.payload)));
}

/**
 * Where the agent just acted (S28), in points from the top-left corner of the glow overlay. A drag
 * runs from `x, y` to `toX, toY`; a keyboard action outlines the focused element (`width × height`).
 */
export type ComputerGlow =
	| { kind: "click" | "move" | "scroll"; x: number; y: number }
	| { kind: "drag"; x: number; y: number; toX: number; toY: number }
	| { kind: "key"; x: number; y: number; width: number; height: number };

/** The overlay window's `computer://glow` events; anything it cannot place is dropped. */
export async function onComputerGlow(handler: (glow: ComputerGlow) => void) {
	if (!isTauri()) return () => {};
	const { listen } = await events();
	return listen<unknown>("computer://glow", (event) => {
		const glow = glowOf(event.payload);
		if (glow) handler(glow);
	});
}

function glowOf(payload: unknown): ComputerGlow | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const event = payload as Record<string, unknown>;
	const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
	const { kind, x, y } = event;
	if (!finite(x) || !finite(y)) return undefined;
	switch (kind) {
		case "click":
		case "move":
		case "scroll":
			return { kind, x, y };
		case "drag":
			return finite(event.toX) && finite(event.toY)
				? { kind, x, y, toX: event.toX, toY: event.toY }
				: undefined;
		case "key":
			return finite(event.width) && finite(event.height) && event.width > 0 && event.height > 0
				? { kind, x, y, width: event.width, height: event.height }
				: undefined;
		default:
			return undefined;
	}
}

function stateOf(state: ComputerStateEvent | null | undefined): ComputerState {
	const session = state?.active === true ? { ...timeOf(state.endsAt) } : undefined;
	const yolo = state?.yolo === true ? { ...timeOf(state.yoloEndsAt) } : undefined;
	return { ...(session ? { session } : {}), ...(yolo ? { yolo } : {}) };
}

/** `{endsAt}` in milliseconds when the app sent a time; one in seconds is read as such. */
function timeOf(endsAt: unknown): { endsAt?: number } {
	if (typeof endsAt !== "number" || !Number.isFinite(endsAt)) return {};
	return { endsAt: endsAt < 1e12 ? endsAt * 1000 : endsAt };
}

/** `mm:ss` left until `endsAt`, never below zero. */
export function timeLeft(endsAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
