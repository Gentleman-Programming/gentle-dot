import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConnectorInfo } from "@gentle-dot/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DotState, initialState } from "../src/store.ts";

const HELPER = "http://127.0.0.1:51234/mcp";
const KEY = "s3cr3t-Computer-Key-0123456789abcdef";

const h = vi.hoisted(() => ({
	tauri: true,
	endpoint: null as unknown,
	permissions: { accessibility: false, screenRecording: true },
	status: { active: false } as unknown,
	invoke: vi.fn(),
	send: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
	state: undefined as unknown as DotState,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

// The panel's other desktop events are not under test; concurrent first imports of the mocked
// event module can reach the real one, so only computer.ts imports it here.
vi.mock("../src/desktop.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async () => () => {},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: h.state, send: h.send, dismiss: () => {}, dispatch: () => {} }),
}));

const computerEntry = (overrides: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
	id: "computer",
	name: "Computer",
	reads: "See your screen during a session you allow in the app.",
	sends: "Click, type, and open apps on this Mac during that session.",
	added: true,
	enabled: true,
	mode: "read_write",
	status: "connected",
	noSignIn: true,
	builtin: true,
	...overrides,
});

const notion: ConnectorInfo = {
	id: "notion",
	name: "Notion",
	reads: "Search and read your pages.",
	sends: "Create and edit pages, after you approve each one.",
	added: true,
	enabled: true,
	mode: "read_only",
	status: "connected",
};

const DEBUG_NOTE =
	"Debug builds lose these permissions on every rebuild because macOS ties them to the app's signature; grant them again after updating.";

function connectorsOpen(list: ConnectorInfo[]): DotState {
	return { ...h.state, connectors: { open: true, list } };
}

async function renderApp(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

const registrations = () => h.send.mock.calls.filter(([m]) => m.type === "computer_register");
const invoked = (command: string) => h.invoke.mock.calls.filter(([c]) => c === command);

async function emitState(payload: unknown) {
	await waitFor(() => expect(h.listeners.has("computer://state")).toBe(true));
	await act(async () => h.listeners.get("computer://state")?.({ payload }));
}

beforeEach(() => {
	h.tauri = true;
	h.endpoint = { url: HELPER, token: KEY };
	h.permissions = { accessibility: false, screenRecording: true };
	h.status = { active: false };
	h.listeners.clear();
	h.send = vi.fn();
	h.state = { ...initialState, connection: "open", agentState: "idle" };
	h.invoke = vi.fn(async (command: string) => {
		switch (command) {
			case "connection_info":
				return new Promise(() => {});
			case "computer_endpoint":
				return h.endpoint;
			case "computer_permissions":
				return h.permissions;
			case "computer_status":
				return h.status;
			default:
				return null;
		}
	});
});

afterEach(() => {
	vi.useRealTimers();
	window.history.replaceState(null, "", "/");
	window.sessionStorage.clear();
});

describe("registering the helper (S24.7)", () => {
	it("the desktop panel asks the app for the endpoint once connected and registers it with the daemon", async () => {
		h.state = { ...h.state, connection: "connecting" };
		const view = await renderApp("?surface=panel");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(invoked("computer_endpoint")).toHaveLength(0);

		h.state = { ...h.state, connection: "open" };
		const { App } = await import("../src/App.tsx");
		view.rerender(<App />);
		await waitFor(() => expect(registrations()).toHaveLength(1));
		expect(registrations()[0]?.[0]).toEqual({ type: "computer_register", url: HELPER, token: KEY });
		expect(invoked("computer_endpoint")).toHaveLength(1);
	});

	it("registers nothing when the app has no helper", async () => {
		h.endpoint = null;
		h.state = connectorsOpen([notion]);
		await renderApp("?surface=panel");
		await waitFor(() => expect(invoked("computer_endpoint")).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(registrations()).toHaveLength(0);
		expect(screen.queryByRole("listitem", { name: "Computer" })).toBeNull();
	});

	it("the Dot window does not register it; only the panel does", async () => {
		await renderApp("?surface=dot");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(invoked("computer_endpoint")).toHaveLength(0);
		expect(registrations()).toHaveLength(0);
	});

	it("the web page never offers computer control, even when the daemon lists it", async () => {
		h.tauri = false;
		h.state = connectorsOpen([notion, computerEntry()]);
		await renderApp("?#token=web-key");
		await screen.findByRole("region", { name: "Connectors" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(screen.queryByText("Computer")).toBeNull();
		expect(screen.getByText("Notion")).toBeInTheDocument();
		expect(h.invoke).not.toHaveBeenCalled();
		expect(registrations()).toHaveLength(0);
	});
});

describe("the Computer entry in Connectors (S24.5)", () => {
	it("shows both permissions with grant buttons, a re-check, the debug-build note, and nothing to remove", async () => {
		h.state = connectorsOpen([notion, computerEntry()]);
		await renderApp("?surface=panel");
		const entry = await screen.findByRole("listitem", { name: "Computer" });
		const accessibility = within(entry).getByRole("listitem", { name: "Accessibility" });
		const recording = within(entry).getByRole("listitem", { name: "Screen Recording" });
		await waitFor(() => expect(accessibility).toHaveTextContent("Not allowed"));
		expect(recording).toHaveTextContent("Allowed");
		expect(within(recording).queryByRole("button")).toBeNull();
		expect(within(entry).getByText(DEBUG_NOTE)).toBeInTheDocument();
		expect(within(entry).queryByText(/does not accept images/)).toBeNull();
		for (const name of [/^Connect/, /^Disconnect/, /^Remove/, /^Sign in/]) {
			expect(within(entry).queryByRole("button", { name })).toBeNull();
		}
		expect(within(entry).queryByRole("radio")).toBeNull();
		// The other connectors keep their usual controls.
		expect(screen.getByRole("button", { name: "Remove Notion" })).toBeInTheDocument();

		const checks = invoked("computer_permissions").length;
		await userEvent.click(within(accessibility).getByRole("button", { name: "Grant Accessibility" }));
		expect(h.invoke).toHaveBeenCalledWith("computer_request_permission", { kind: "accessibility" });
		await waitFor(() => expect(invoked("computer_permissions").length).toBe(checks + 1));

		h.permissions = { accessibility: true, screenRecording: true };
		await userEvent.click(within(entry).getByRole("button", { name: "Check again" }));
		await waitFor(() => expect(accessibility).toHaveTextContent("Allowed"));
		expect(accessibility).not.toHaveTextContent("Not allowed");
		expect(within(accessibility).queryByRole("button")).toBeNull();
	});

	it("asks for Screen Recording with its own kind", async () => {
		h.permissions = { accessibility: true, screenRecording: false };
		h.state = connectorsOpen([computerEntry()]);
		await renderApp("?surface=panel");
		const recording = await screen.findByRole("listitem", { name: "Screen Recording" });
		await userEvent.click(await within(recording).findByRole("button", { name: "Grant Screen Recording" }));
		expect(h.invoke).toHaveBeenCalledWith("computer_request_permission", { kind: "screenRecording" });
	});

	it("says when the current model does not accept images", async () => {
		h.state = connectorsOpen([computerEntry({ noImages: true })]);
		await renderApp("?surface=panel");
		const entry = await screen.findByRole("listitem", { name: "Computer" });
		expect(within(entry).getByText(/current model does not accept images/)).toBeInTheDocument();
	});
});

describe("while the assistant controls the Mac (S24.6)", () => {
	it("shows a banner with the time left and a Stop button, until the session ends", async () => {
		await renderApp("?surface=panel");
		await waitFor(() => expect(h.listeners.has("computer://state")).toBe(true));
		expect(screen.queryByRole("region", { name: "Computer control" })).toBeNull();

		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(1_800_000_000_000);
		await emitState({ active: true, endsAt: Date.now() + 90_000, reason: "granted" });
		const banner = screen.getByRole("region", { name: "Computer control" });
		expect(banner).toHaveTextContent("Controlling your Mac · 01:30 left");
		await act(async () => vi.advanceTimersByTime(1000));
		expect(banner).toHaveTextContent("Controlling your Mac · 01:29 left");

		within(banner).getByRole("button", { name: "Stop" }).click();
		expect(invoked("computer_stop")).toHaveLength(1);
		await emitState({ active: false, reason: "stopped" });
		expect(screen.queryByRole("region", { name: "Computer control" })).toBeNull();
	});

	it("shows a session that was already running when the panel opened, with endsAt in seconds too", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(1_800_000_000_000);
		h.status = { active: true, endsAt: 1_800_000_000 + 25 * 60 };
		await renderApp("?surface=panel");
		const banner = await screen.findByRole("region", { name: "Computer control" });
		expect(banner).toHaveTextContent("Controlling your Mac · 25:00 left");
	});

	it("the rose shows the in-control state and goes back when the session ends", async () => {
		await renderApp("?surface=dot");
		const dot = screen.getByRole("button");
		expect(dot.querySelector(".rose")).toHaveClass("rose-idle");

		await emitState({ active: true, endsAt: Date.now() + 60_000, reason: "granted" });
		expect(dot).toHaveAccessibleName("Gentle Dot: controlling your Mac");
		expect(dot).toHaveClass("dot-in_control");
		expect(dot.querySelector(".rose")).toHaveClass("rose-control");

		await emitState({ active: false, reason: "panic" });
		expect(dot).toHaveAccessibleName("Gentle Dot: ready");
		expect(dot).not.toHaveClass("dot-in_control");
		expect(dot.querySelector(".rose")).toHaveClass("rose-idle");
	});

	it("styles the in-control rose and the banner with the site's tokens", () => {
		const stylesheet = "../src/styles.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		const rule = (selector: string) =>
			css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
		expect(rule(".dot-in_control .dot-disc")).toMatch(/--rim: /);
		expect(rule(".rose-control .rose-light path")).toMatch(/animation: rose-run/);
		expect(rule(".computer-banner")).toMatch(/var\(--accent/);
		expect(rule(".computer-banner")).toMatch(/border-radius: var\(--radius-md\)/);
	});
});
