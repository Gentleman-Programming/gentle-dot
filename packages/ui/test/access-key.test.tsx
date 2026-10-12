import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../src/store.ts";

/**
 * A phone (or an installed PWA, which keeps its own storage on iOS) opens the page without the
 * token in the URL: the app must offer a way to paste the access key instead of a dead end.
 */
const h = vi.hoisted(() => ({
	state: undefined as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => false,
	invoke: vi.fn(),
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({
		state: h.state,
		send: () => {},
		dismiss: () => {},
		dispatch: () => {},
	}),
}));

async function renderApp(search = "") {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	return render(<App />);
}

beforeEach(() => {
	window.sessionStorage.clear();
	window.localStorage.clear();
	h.state = initialState;
});

describe("missing access key", () => {
	it("offers a form to paste the access key when there is no token", async () => {
		await renderApp();
		expect(screen.getByRole("status")).toHaveTextContent("needs your access key");
		expect(screen.getByLabelText("Access key")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
	});

	it("stores the pasted key and connects", async () => {
		await renderApp();
		await act(async () => {
			await userEvent.type(screen.getByLabelText("Access key"), "abc123");
			fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		});
		expect(window.sessionStorage.getItem("gentle-dot-token")).toBe("abc123");
		expect(window.localStorage.getItem("gentle-dot-token")).toBe("abc123");
		expect(screen.queryByLabelText("Access key")).not.toBeInTheDocument();
	});

	it("ignores a blank key", async () => {
		await renderApp();
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(window.localStorage.getItem("gentle-dot-token")).toBeNull();
		expect(screen.getByLabelText("Access key")).toBeInTheDocument();
	});
});
