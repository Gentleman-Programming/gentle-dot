import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionInfo } from "../src/client.ts";
import { type DotState, initialState } from "../src/store.ts";

/**
 * A window the app refused recovers without a reopen (S35.2): once the app reports its assistant
 * ready (`dot://assistant-ready`, after Restart assistant or a slow start), the panel and the Dot
 * ask again and connect. Through the mocked Tauri commands and desktop events.
 */
const h = vi.hoisted(() => ({
	connection: undefined as unknown as () => Promise<unknown>,
	invoke: vi.fn(),
	listeners: new Map<string, () => void>(),
	infos: [] as (ConnectionInfo | undefined)[],
	state: undefined as unknown as DotState,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => true,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async () => () => {},
}));

vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async (name: string, handler: () => void) => {
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: (info: ConnectionInfo | undefined) => {
		h.infos.push(info);
		return { state: h.state, send: () => {}, dismiss: () => {}, dispatch: () => {} };
	},
}));

const REFUSAL =
	"Another Gentle Dot assistant is already running on port 4317. Stop it, then choose Restart assistant.";
const INFO: ConnectionInfo = { url: "ws://127.0.0.1:4317/ws", token: "abc" };

async function renderApp(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

const READY = "dot://assistant-ready";

async function reportReady() {
	await waitFor(() => expect(h.listeners.has(READY)).toBe(true));
	await act(async () => h.listeners.get(READY)?.());
}

beforeEach(() => {
	h.listeners.clear();
	h.infos = [];
	h.state = { ...initialState, connection: "closed", agentState: "idle" };
	h.connection = async () => {
		throw REFUSAL;
	};
	h.invoke = vi.fn(async (command: string) => {
		if (command === "connection_info") return h.connection();
		if (command === "computer_status") return { active: false };
		return null;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("after the app refused its assistant (S35.2)", () => {
	it("the panel connects once the app reports the assistant ready", async () => {
		await renderApp("?surface=panel");
		expect(await screen.findByText(REFUSAL)).toHaveAttribute("role", "status");
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		expect(screen.queryByText(REFUSAL)).toBeNull();
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});

	it("the Dot connects once the app reports the assistant ready", async () => {
		await renderApp("?surface=dot");
		await waitFor(() => expect(h.invoke.mock.calls.some(([c]) => c === "connection_info")).toBe(true));
		expect(h.infos.at(-1)).toBeUndefined();
		h.connection = async () => INFO;
		await reportReady();
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
	});

	it("a panel already connected keeps its connection when the app reports ready again", async () => {
		h.connection = async () => ({ ...INFO });
		await renderApp("?surface=panel");
		await waitFor(() => expect(h.infos.at(-1)).toEqual(INFO));
		const first = h.infos.at(-1);
		await reportReady();
		await waitFor(() => expect(h.invoke.mock.calls.filter(([c]) => c === "connection_info")).toHaveLength(2));
		expect(h.infos.at(-1)).toBe(first);
	});
});
