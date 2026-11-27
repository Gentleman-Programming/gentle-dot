import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { initialState } from "../src/store.ts";

const native = vi.hoisted(() => ({
	desktop: true,
	invoke: vi.fn(),
	ready: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.desktop, invoke: native.invoke }));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: initialState, send: () => {}, dismiss: () => {}, dispatch: () => {} }),
}));

const waiting = () => new Promise(() => {});
function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const metadata = { runtime: "present", profile: "no-conflict-found", service: "starting" } as const;
const refusal = "Mock native details: must not be shown";
let connection: () => Promise<unknown>;
let check: () => Promise<unknown>;

function panel(surface = "panel") {
	window.history.replaceState(null, "", `/?surface=${surface}`);
	return render(<App />);
}

const calls = (command: string) => native.invoke.mock.calls.filter(([name]) => name === command);
const refresh = () => fireEvent.click(screen.getByRole("button", { name: "Refresh checks" }));

beforeEach(() => {
	vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0; Win64; x64");
	connection = waiting;
	check = async () => metadata;
	native.desktop = true;
	native.ready = () => {};
	const callbacks = new Map<number, () => void>();
	let callbackId = 0;
	vi.stubGlobal("__TAURI_INTERNALS__", {
		transformCallback(handler: () => void) {
			callbacks.set(++callbackId, handler);
			return callbackId;
		},
		async invoke(command: string, args: { event: string; handler: number }) {
			if (command === "plugin:event|listen") {
				if (args.event === "dot://assistant-ready") native.ready = callbacks.get(args.handler)!;
				return args.handler;
			}
			if (command === "plugin:event|unlisten") return;
			throw new Error(`Unexpected event command: ${command}`);
		},
	});
	vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: (_event: string, id: number) => callbacks.delete(id) });
	native.invoke.mockReset().mockImplementation(async (name: string) => {
		if (name === "connection_info") return connection();
		if (name === "startup_readiness") return check();
		return null;
	});
});

afterEach(async () => {
	cleanup();
	await act(async () => {});
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

it("shows the ordered panel checklist without waiting for connection info", async () => {
	panel();
	expect(screen.getByRole("heading", { level: 1, name: "Startup checklist" })).toBeVisible();
	const rows = within(screen.getByRole("list")).getAllByRole("listitem");
	expect(rows.map((row) => within(row).getByRole("heading", { level: 2 }).textContent)).toEqual([
		"Runtime", "Data profile", "Service", "Provider",
	]);
	expect(await within(rows[0]!).findByText("Ready")).toBeVisible();
	expect(within(rows[1]!).getByText(/Not a full profile audit/)).toBeVisible();
	expect(within(rows[2]!).getByText("Starting")).toBeVisible();
	expect(within(rows[3]!).getByText("Optional · Not checked")).toBeVisible();
	expect(calls("startup_readiness")).toEqual([["startup_readiness"]]);
});

it("explains a typed owner refusal without changing the original profile or offering a restart", async () => {
	connection = async () => {
		throw refusal;
	};
	check = async () => ({ ...metadata, profile: "owner-mismatch", service: "blocked", detail: refusal });
	panel();
	expect(await screen.findByText("Ownership mismatch")).toBeVisible();
	expect(screen.getByText("Blocked")).toBeVisible();
	expect(screen.getByText(/GENTLE_DOT_DATA_DIR=/)).toBeVisible();
	expect(screen.getByText(/for this launch only/)).toBeVisible();
	expect(screen.getByText(/Do not delete or modify the original profile/)).toBeVisible();
	expect(screen.queryByText(refusal)).not.toBeInTheDocument();
	expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
	const before = native.invoke.mock.calls.length;
	refresh();
	await screen.findByText("Ownership mismatch");
	expect(native.invoke.mock.calls.slice(before)).toEqual([["startup_readiness"]]);
});

it("offers fresh-folder recovery when profile ownership could not be determined", async () => {
	check = async () => ({ ...metadata, profile: "unknown" });
	panel();
	expect(await screen.findByText(/could not determine whether the selected profile has an ownership or safety conflict/i)).toBeVisible();
	expect(screen.queryByText("Ownership mismatch")).not.toBeInTheDocument();
	expect(screen.getByText(/GENTLE_DOT_DATA_DIR=/)).toBeVisible();
	expect(screen.getByText(/new, unused local folder.*for this launch only.*Do not delete or modify the original profile/)).toBeVisible();
});

it("does not present a previously successful startup as a live connection after refusal", async () => {
	connection = async () => { throw refusal; };
	check = async () => ({ ...metadata, service: "ready" });
	panel();
	const row = within(screen.getByRole("heading", { name: "Service" }).closest("li")!);
	expect(await row.findByText("Not connected")).toBeVisible();
	expect(row.getByText(/last owned startup succeeded.*panel could not connect/i)).toBeVisible();
	expect(row.queryByText("Ready")).not.toBeInTheDocument();
	expect(screen.queryByText(refusal)).not.toBeInTheDocument();
});

it("rechecks a starting service when the pending connection fails", async () => {
	const pending = deferred();
	connection = () => pending.promise;
	panel();
	expect(await screen.findByText("Starting")).toBeVisible();
	check = async () => ({ ...metadata, service: "failed" });
	await act(async () => pending.reject(refusal));
	expect(await screen.findByText("Failed")).toBeVisible();
	expect(screen.queryByText(refusal)).not.toBeInTheDocument();
});

it("ignores stale refresh results and late refusal after ready restores chat", async () => {
	const first = deferred();
	const stale = deferred();
	const late = deferred();
	connection = () => late.promise;
	check = () => first.promise;
	panel();
	check = () => stale.promise;
	refresh();
	check = async () => ({ ...metadata, service: "failed" });
	refresh();
	expect(await screen.findByText("Failed")).toBeVisible();
	expect(screen.getByText(/Quit and relaunch Gentle Dot to retry the service/)).toBeVisible();
	await act(async () => first.resolve(metadata));
	expect(screen.getByText("Failed")).toBeVisible();
	connection = async () => ({ url: "ws://127.0.0.1:4317/ws", token: "mock" });
	await act(async () => native.ready());
	expect(screen.getByRole("textbox")).toBeVisible();
	await act(async () => {
		late.reject(refusal);
		stale.resolve({ ...metadata, profile: "owner-mismatch", service: "blocked" });
	});
	expect(screen.getByRole("textbox")).toBeVisible();
	expect(screen.queryByText("Startup checklist")).not.toBeInTheDocument();
});

it("keeps unknown checks distinct from a failed service and handles unsupported native results", async () => {
	connection = async () => {
		throw refusal;
	};
	check = async () => ({ ...metadata, service: "unknown" });
	panel();
	expect(await screen.findByText(/service state could not be determined/)).toBeVisible();
	check = async () => ({ ...metadata, service: refusal });
	refresh();
	expect(await screen.findByText("Startup checks are unavailable.")).toBeVisible();
	expect(screen.queryByText(refusal)).not.toBeInTheDocument();
	expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	check = async () => {
		throw refusal;
	};
	refresh();
	expect(await screen.findByText("Startup checks are unavailable.")).toBeVisible();
	expect(screen.queryByText(refusal)).not.toBeInTheDocument();
	check = async () => null;
	refresh();
	expect(await screen.findByText(refusal)).toHaveAttribute("role", "status");
	expect(screen.queryByText("Startup checklist")).not.toBeInTheDocument();
});

it("leaves Windows browser access-key handling and the Dot surface alone", async () => {
	native.desktop = false;
	const page = panel("web");
	expect(await screen.findByText(/This page needs your access key/)).toBeVisible();
	page.unmount();
	native.desktop = true;
	panel("dot");
	expect(calls("set_dot_state").length).toBeGreaterThan(0);
	expect(calls("startup_readiness")).toHaveLength(0);
});
