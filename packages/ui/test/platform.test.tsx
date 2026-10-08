import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../src/store.ts";

vi.mock("../src/desktop.ts", () => ({
	inDesktop: () => true,
	connectionInfo: () => new Promise(() => {}),
	hidePanel: () => {},
	togglePanel: () => {},
	setDotState: () => {},
	startDragging: async () => {},
	openUrl: () => {},
	onDesktopEvent: async () => () => {},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: initialState, send: () => {}, dismiss: () => {}, dispatch: () => {} }),
}));

async function renderPanel(search: string) {
	window.history.replaceState(null, "", `/${search}`);
	const { App } = await import("../src/App.tsx");
	render(<App />);
}

describe("panel without window effects (Linux)", () => {
	afterEach(() => {
		window.history.replaceState(null, "", "/");
		delete document.documentElement.dataset.effects;
	});

	it("reads the effects flag the shell puts in the panel URL", async () => {
		const { windowEffects } = await import("../src/App.tsx");
		expect(windowEffects("?surface=panel&effects=none")).toBe("none");
		expect(windowEffects("?surface=panel")).toBe("native");
		expect(windowEffects("?surface=panel&effects=blur")).toBe("native");
		expect(windowEffects("")).toBe("native");
	});

	it("marks the document so the panel paints its own background", async () => {
		await renderPanel("?surface=panel&effects=none");
		expect(document.documentElement.dataset.effects).toBe("none");
	});

	it("keeps the macOS panel on native vibrancy", async () => {
		await renderPanel("?surface=panel");
		expect(document.documentElement.dataset.effects).toBe("native");
	});

	it("paints a solid background with no backdrop blur when effects are off", () => {
		const stylesheet = "../src/styles.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		const rule = css.match(/\nhtml\[data-effects="none"\] \.chat-panel \{([^}]*)\}/)?.[1] ?? "";
		expect(rule).toMatch(/\tbackground: var\(--bg\);/);
		expect(rule).toMatch(/\tbackdrop-filter: none;/);
		expect(rule).toMatch(/\t-webkit-backdrop-filter: none;/);
	});
});
