import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NiriUnitSurface } from "../src/components/NiriUnitSurface.tsx";

/** Stateful child standing in for the real ChatSurface: proves toggles keep its subtree. */
function ChatProbe() {
	const [value, setValue] = useState("");
	return (
		<div className="chat chat-panel" style={{ width: 420, height: 640 }}>
			<header className="chat-header" data-tauri-drag-region="">
				<h1>Gentle Dot</h1>
			</header>
			<input aria-label="Message" value={value} onChange={(event) => setValue(event.target.value)} />
		</div>
	);
}

function setup(props?: { open?: boolean; roseHidden?: boolean; fullscreen?: boolean; revision?: number }) {
	const onTogglePanel = vi.fn();
	const onStartDrag = vi.fn();
	const view = render(
		<NiriUnitSurface
			open={props?.open ?? false}
			roseHidden={props?.roseHidden ?? false}
			fullscreen={props?.fullscreen ?? false}
			revision={props?.revision ?? 0}
			agentState="idle"
			connected
			onTogglePanel={onTogglePanel}
			onStartDrag={onStartDrag}
		>
			<ChatProbe />
		</NiriUnitSurface>,
	);
	return { onTogglePanel, onStartDrag, ...view };
}

describe("NiriUnitSurface modes", () => {
	it("rose-only when the panel is closed and the rose is wanted", () => {
		const { container } = setup({ open: false, roseHidden: false });
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "rose");
		expect(screen.getByRole("button", { name: /Gentle Dot/ })).toBeInTheDocument();
		expect(container.querySelector(".niri-unit-panel")).toHaveAttribute("hidden");
		// Staying mounted must not leak layout or focus: the hidden chat is not visible and inert.
		expect(screen.getByRole("textbox", { name: "Message", hidden: true })).not.toBeVisible();
		expect(container.querySelector(".niri-unit-panel")).toHaveAttribute("inert");
	});

	it("panel-only when the rose is hidden", () => {
		const { container } = setup({ open: true, roseHidden: true });
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "panel");
		expect(screen.queryByRole("button", { name: /Gentle Dot: / })).toBeNull();
		expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
	});

	it("pair when open with the rose shown, panel first then rose", () => {
		const { container } = setup({ open: true, roseHidden: false });
		const unit = container.querySelector(".niri-unit");
		expect(unit).toHaveAttribute("data-mode", "pair");
		expect(screen.getByRole("button", { name: /Gentle Dot: / })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
		const order = [...(unit?.children ?? [])].map((child) =>
			child.classList.contains("niri-unit-panel") ? "panel" : "rose",
		);
		expect(order).toEqual(["panel", "rose"]);
	});

	it("fullscreen hides the rose and restores it from the same preference on exit", () => {
		const { container, rerender } = setup({ open: true, roseHidden: false, fullscreen: true });
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "fullscreen");
		expect(screen.queryByRole("button", { name: /Gentle Dot: / })).toBeNull();
		expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
		rerender(
			<NiriUnitSurface
				open
				roseHidden={false}
				fullscreen={false}
				agentState="idle"
				connected
				onTogglePanel={() => {}}
				onStartDrag={() => {}}
			>
				<ChatProbe />
			</NiriUnitSurface>,
		);
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "pair");
		expect(screen.getByRole("button", { name: /Gentle Dot: / })).toBeInTheDocument();
	});

	it("empty when both are hidden; the shell hides the window", () => {
		const { container } = setup({ open: false, roseHidden: true });
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "empty");
		expect(screen.queryByRole("button", { name: /Gentle Dot: / })).toBeNull();
		expect(container.querySelector(".niri-unit-panel")).toHaveAttribute("hidden");
	});
});

describe("NiriUnitSurface drag ownership", () => {
	it("rose click toggles the panel, rose drag past threshold starts the owning-window drag", () => {
		const { onTogglePanel, onStartDrag } = setup({ open: false });
		const rose = screen.getByRole("button", { name: /Gentle Dot: / });
		fireEvent.pointerDown(rose, { clientX: 10, clientY: 10, button: 0 });
		fireEvent.pointerUp(rose, { clientX: 11, clientY: 10, button: 0 });
		expect(onTogglePanel).toHaveBeenCalledTimes(1);
		expect(onStartDrag).not.toHaveBeenCalled();

		fireEvent.pointerDown(rose, { clientX: 10, clientY: 10, button: 0 });
		fireEvent.pointerMove(rose, { clientX: 20, clientY: 18, button: 0 });
		fireEvent.pointerUp(rose, { clientX: 20, clientY: 18, button: 0 });
		expect(onStartDrag).toHaveBeenCalledTimes(1);
		expect(onTogglePanel).toHaveBeenCalledTimes(1);
	});

	it("keeps the chat header native drag-region so it drags the same owning window", () => {
		setup({ open: true });
		expect(screen.getByText("Gentle Dot").closest(".chat-header")).toHaveAttribute(
			"data-tauri-drag-region",
		);
	});
});

describe("NiriUnitSurface state preservation", () => {
	it("toggling modes keeps the chat child subtree and its input", () => {
		const { container, rerender } = setup({ open: true, roseHidden: false });
		const box = screen.getByRole("textbox", { name: "Message" });
		fireEvent.change(box, { target: { value: "keep me" } });
		const node = container.querySelector(".niri-unit-panel");
		const props = {
			agentState: "idle" as const,
			connected: true,
			onTogglePanel: () => {},
			onStartDrag: () => {},
		};
		rerender(
			<NiriUnitSurface {...props} open roseHidden fullscreen={false}>
				<ChatProbe />
			</NiriUnitSurface>,
		);
		rerender(
			<NiriUnitSurface {...props} open roseHidden={false} fullscreen>
				<ChatProbe />
			</NiriUnitSurface>,
		);
		rerender(
			<NiriUnitSurface {...props} open roseHidden={false} fullscreen={false}>
				<ChatProbe />
			</NiriUnitSurface>,
		);
		expect(container.querySelector(".niri-unit-panel")).toBe(node);
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("keep me");
	});
});

describe("NiriUnitSurface revision", () => {
	it("is observed only: same mode, same child state across generations", () => {
		const { container, rerender } = setup({ open: true, revision: 3 });
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-revision", "3");
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "pair");
		expect(container.querySelector(".niri-unit-panel")).not.toHaveAttribute("inert");
		const box = screen.getByRole("textbox", { name: "Message" });
		fireEvent.change(box, { target: { value: "kept" } });
		rerender(
			<NiriUnitSurface open roseHidden={false} fullscreen={false} revision={4} agentState="idle" connected onTogglePanel={() => {}} onStartDrag={() => {}}>
				<ChatProbe />
			</NiriUnitSurface>,
		);
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-revision", "4");
		expect(container.querySelector(".niri-unit")).toHaveAttribute("data-mode", "pair");
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("kept");
	});
});

describe("NiriUnitSurface layout contract", () => {
	it("pairs 420x640 chat + 8 gap + 72 rose at x428 y284 (500x640), transparent strip", () => {
		// Through a parameter (as in dot.test.tsx): a string literal would make Vite rewrite new URL as an asset.
		const read = (relative: string) =>
			readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
		const css = read("../src/styles.css");
		const block = (selector: string) =>
			css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";
		expect(block(".niri-unit")).toMatch(/background: transparent;/);
		expect(block(".niri-unit")).not.toMatch(/backdrop-filter/);
		expect(block(".niri-unit-pair")).toMatch(/width: 500px;/);
		expect(block(".niri-unit-pair")).toMatch(/height: 640px;/);
		expect(block(".niri-unit-pair")).toMatch(/gap: 8px;/);
		expect(block(".niri-unit-panel")).toMatch(/width: 420px;/);
		expect(block(".niri-unit-panel")).toMatch(/height: 640px;/);
		// Rose sits right of the panel (420 + 8 = 428) and centered vertically ((640 - 72) / 2 = 284).
		expect(block(".niri-unit-rose")).toMatch(/width: 72px;/);
		expect(block(".niri-unit-rose")).toMatch(/height: 72px;/);
		expect(css).toMatch(/\.niri-unit-pair \.niri-unit-rose \{[^}]*margin-top: 284px;/);
		// Only .niri-unit selectors were added: the other backends keep their own CSS.
		const added = css.split("/* ---------- Niri unit")[1] ?? "";
		for (const selector of added.match(/^\.[a-z-]+(?= \{)/gm) ?? [])
			expect(selector.startsWith(".niri-unit")).toBe(true);
		expect(css).toMatch(/\n\.dot \{[^}]*\twidth: 72px;/);
		expect(css).toMatch(/\.dot-disc \{[^}]*\tinset: 3px;/);
		expect(css).toMatch(/\.dot-badge \{[^}]*\ttop: 4px;[\s\S]*?\tright: 4px;[\s\S]*?\twidth: 16px;/);
		expect(css).toMatch(/\.chat-panel \{\s*\n\tbackground: rgba\(26, 18, 24, 0\.94\);/);
		expect(css).toMatch(/\.chat-panel \{[^}]*\tborder-radius: var\(--radius\);/);
		// The host window behind the unit stays transparent, so it never eats the strip.
		expect(css).toMatch(/html\[data-surface="panel"\] body \{[\s\S]*?background: transparent;/);
	});
});
