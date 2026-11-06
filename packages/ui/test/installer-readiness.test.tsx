import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import capabilities from "../../../apps/desktop/src-tauri/capabilities/default.json";
import { initialState } from "../src/store.ts";
import { InstallerReadiness } from "../src/components/InstallerReadiness.tsx";
import { SettingsPanel } from "../src/components/SettingsPanel.tsx";
import { App } from "../src/App.tsx";
import { installerReadiness } from "../src/desktop.ts";

const h = vi.hoisted(() => ({ desktop: true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.desktop,
	invoke: (...args: unknown[]) => h.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/desktop.ts", async (original) => ({
	...(await original<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async () => () => {},
}));
vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: initialState, send: () => {}, dismiss: () => {}, dispatch: () => {} }),
}));
const report = {
	processOs: "windows", compiledArch: "x86_64", runtimeTarget: "windows-x64",
	checks: [
		{ path: "node/bin/node.exe", status: "present" },
		{ path: "daemon/cli.mjs", status: "missing" },
		{ path: "MANIFEST.json", status: "unknown" },
	],
};
beforeEach(() => {
	h.desktop = true;
	h.invoke.mockReset().mockImplementation(async (command: string) => {
		if (command === "installer_readiness") return report;
		if (command === "shortcut_get") return { shortcut: "Alt+Space", default: "Alt+Space" };
		if (command === "connection_info") throw "Original assistant failure";
		return null;
	});
	window.history.replaceState(null, "", "/?surface=panel");
	window.sessionStorage.clear();
});

it("shows loading, native facts and explicit refresh with zero client arguments", async () => {
	let resolve!: (value: unknown) => void;
	h.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
	render(<InstallerReadiness />);
	expect(screen.getByText("Checking bundled files…")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Refresh bundled-file checks" })).toBeDisabled();
	await act(async () => resolve(report));
	expect(screen.getByText(/App process OS: windows/)).toBeInTheDocument();
	for (const text of ["node/bin/node.exe — Present", "daemon/cli.mjs — Missing", "MANIFEST.json — Unknown"])
		expect(screen.getByText(text)).toBeInTheDocument();
	expect(screen.getByText(/OS version, physical CPU and system prerequisites: Unknown/)).toBeInTheDocument();
	expect(h.invoke.mock.calls).toEqual([["installer_readiness"]]);
	fireEvent.click(screen.getByRole("button", { name: "Refresh bundled-file checks" }));
	await waitFor(() => expect(h.invoke.mock.calls).toHaveLength(2));
	expect(h.invoke.mock.calls[1]).toEqual(["installer_readiness"]);
});

it("sanitizes IPC errors and ignores a late response after unmount", async () => {
	h.invoke.mockRejectedValueOnce("C:/private/user/location");
	const view = render(<InstallerReadiness />);
	expect(await screen.findByRole("alert")).toHaveTextContent("Bundled-file checks unavailable.");
	expect(view.container.textContent).not.toContain("private");
	let resolve!: (value: unknown) => void;
	h.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
	fireEvent.click(screen.getByRole("button", { name: "Refresh bundled-file checks" }));
	view.unmount();
	await act(async () => resolve(report));
	expect(view.container).toBeEmptyDOMElement();
});

it("never queries or reports host facts in a browser, including the bridge", async () => {
	h.desktop = false;
	const view = render(<InstallerReadiness />);
	expect(view.container).toBeEmptyDOMElement();
	await expect(installerReadiness()).rejects.toThrow("Desktop diagnostics unavailable.");
	expect(h.invoke).not.toHaveBeenCalled();
});

it("mounts in Settings while preserving shortcut, voice row and close", async () => {
	const close = vi.fn();
	render(<SettingsPanel close={close} />);
	expect(await screen.findByText("node/bin/node.exe — Present")).toBeInTheDocument();
	expect(screen.getByRole("heading", { name: "Keyboard shortcut" })).toBeInTheDocument();
	expect(screen.getByRole("combobox", { name: "Voice language" })).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Change" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
	expect(close).toHaveBeenCalledOnce();
});

it("shows diagnostics before Chat on desktop failure, preserving the original reason", async () => {
	render(<App />);
	expect(await screen.findByText("Original assistant failure")).toBeInTheDocument();
	expect(await screen.findByText("daemon/cli.mjs — Missing")).toBeInTheDocument();
});

it("preserves browser access-key guidance without native diagnostics", async () => {
	h.desktop = false;
	render(<App />);
	expect(await screen.findByText(/This page needs your access key/)).toHaveTextContent("#token=<your access key>");
	expect(screen.queryByRole("region", { name: "Bundled runtime diagnostics" })).toBeNull();
	expect(h.invoke).not.toHaveBeenCalled();
});

it("grants the public read-only permission only to the panel", () => {
	const grants = capabilities.capabilities.filter((c) => c.permissions.includes("allow-installer-readiness"));
	expect(grants).toEqual([{ identifier: "installer-readiness", description: "Read-only bundled runtime file diagnostics.", windows: ["panel"], permissions: ["allow-installer-readiness"] }]);
});
