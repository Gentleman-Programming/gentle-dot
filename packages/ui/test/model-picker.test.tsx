import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotAction, type DotState, initialState, reduce } from "../src/store.ts";

const levels = ["off", "minimal", "low", "medium", "high"] as const;

const models: ServerPayload = {
	type: "models",
	current: { provider: "openai", id: "gpt-5", name: "GPT-5", thinking: "medium" },
	groups: [
		{
			provider: "openai",
			name: "OpenAI",
			models: [
				{ provider: "openai", id: "gpt-5", name: "GPT-5", images: true, thinkingLevels: [...levels] },
				{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini", images: true },
			],
		},
		{
			provider: "nan",
			name: "NaN",
			models: [{ provider: "nan", id: "big", name: "NaN Big", images: false, thinkingLevels: [...levels] }],
		},
	],
	profiles: [{ name: "daily", model: "nan/big" }],
};

const ready: DotState = {
	...initialState,
	connection: "open",
	agentState: "idle",
	model: "GPT-5",
};

let dispatchServer: (payload: ServerPayload) => void = () => {};

function Harness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	dispatchServer = (payload) =>
		act(() => dispatch({ type: "server", message: { ...payload, seq: 1 } as ServerMessage } as DotAction));
	return <ChatSurface variant="web" state={state} send={send} dismiss={vi.fn()} dispatch={dispatch} />;
}

async function openPicker(send = vi.fn(), initial = ready) {
	render(<Harness initial={initial} send={send} />);
	await userEvent.click(screen.getByRole("button", { name: "Model: GPT-5" }));
	dispatchServer(models);
	return { send, dialog: screen.getByRole("dialog", { name: "Choose a model" }) };
}

const list = () => screen.getByRole("listbox", { name: "Models" });
const option = (name: string) => within(list()).getByRole("option", { name: new RegExp(`^${name}`) });

// Model a short viewport without relying on jsdom layout or scrolling any ancestor.
function mockModelListGeometry() {
	const original = HTMLElement.prototype.getBoundingClientRect;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const viewport = this.closest('[role="listbox"][aria-label="Models"]');
		if (!viewport) return original.call(this);
		const index = Array.from(viewport.querySelectorAll('[role="option"]')).indexOf(this);
		const top = this === viewport ? 100 : 100 + index * 70 - viewport.scrollTop;
		return { top, bottom: top + (this === viewport ? 60 : 20) } as DOMRect;
	});
}

afterEach(() => vi.restoreAllMocks());

describe("model picker (S32)", () => {
	it.each(["row", "search"])(
		"ignores stationary pointer retargeting after arrows (started on %s)",
		async (start) => {
			mockModelListGeometry();
			const { send } = await openPicker();
			const search = screen.getByRole("searchbox", { name: "Search models" });
			const move = (target: HTMLElement, clientX = 20) =>
				fireEvent(target, new MouseEvent("pointermove", { bubbles: true, clientX, clientY: 110 }));
			move(start === "row" ? option("GPT-5") : search);
			for (const [name, scrollTop] of [
				["GPT-4o mini", 30],
				["NaN Big", 100],
			] as const) {
				await userEvent.keyboard("{ArrowDown}");
				move(option("GPT-5"));
				move(option("GPT-5"));
				expect(option(name)).toHaveAttribute("aria-selected", "true");
				expect(option("GPT-5")).toHaveAttribute("aria-selected", "false");
				expect(search).toHaveAttribute("aria-activedescendant", option(name).id);
				expect(list().scrollTop).toBe(scrollTop);
				expect(search).toHaveFocus();
				expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
			}
			if (start === "row") {
				await userEvent.keyboard("{Enter}");
				expect(send.mock.calls).toEqual([
					[{ type: "models_list" }],
					[{ type: "model_set", provider: "nan", id: "big", thinking: "medium" }],
				]);
			} else {
				move(option("daily"), 21);
				expect(option("daily")).toHaveAttribute("aria-selected", "true");
				expect(search).toHaveAttribute("aria-activedescendant", option("daily").id);
				expect(list().scrollTop).toBe(170);
				expect(search).toHaveFocus();
				await userEvent.click(option("daily"));
				expect(send.mock.calls).toEqual([
					[{ type: "models_list" }],
					[{ type: "profile_apply", name: "daily" }],
				]);
			}
			expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
		},
	);

	it("scrolls only the model list down, up and around while search keeps focus until Enter", async () => {
		mockModelListGeometry();
		const { send, dialog } = await openPicker();
		const search = screen.getByRole("searchbox", { name: "Search models" });
		const viewport = list();
		const pageTop = document.documentElement.scrollTop;
		const bodyTop = document.body.scrollTop;
		await userEvent.keyboard("{ArrowDown}");
		expect(viewport.scrollTop).toBe(30);
		expect(option("GPT-4o mini")).toHaveAttribute("aria-selected", "true");
		expect(search).toHaveAttribute("aria-activedescendant", option("GPT-4o mini").id);
		expect(search).toHaveFocus();
		await userEvent.keyboard("{ArrowUp}");
		expect(viewport.scrollTop).toBe(0);
		expect(option("GPT-5")).toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{ArrowUp}");
		expect(viewport.scrollTop).toBe(170);
		expect(option("daily")).toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{ArrowDown}");
		expect(viewport.scrollTop).toBe(0);
		expect(search).toHaveFocus();
		expect(dialog.scrollTop).toBe(0);
		expect(document.documentElement.scrollTop).toBe(pageTop);
		expect(document.body.scrollTop).toBe(bodyTop);
		expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		await userEvent.keyboard("{Enter}");
		expect(send.mock.calls).toEqual([
			[{ type: "models_list" }],
			[{ type: "model_set", provider: "openai", id: "gpt-5", thinking: "medium" }],
		]);
		expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
	});

	it("reveals the filtered first row even when its active index stays zero and handles empty results", async () => {
		mockModelListGeometry();
		const { send } = await openPicker();
		const search = screen.getByRole("searchbox", { name: "Search models" });
		list().scrollTop = 100;
		await userEvent.type(search, "nan");
		expect(list().scrollTop).toBe(0);
		expect(option("NaN Big")).toHaveAttribute("aria-selected", "true");
		expect(search).toHaveAttribute("aria-activedescendant", option("NaN Big").id);
		expect(search).toHaveFocus();
		await userEvent.type(search, "zzz");
		await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
		expect(within(list()).queryAllByRole("option")).toEqual([]);
		expect(search).not.toHaveAttribute("aria-activedescendant");
		expect(screen.getByText("No models match.")).toBeInTheDocument();
		expect(search).toHaveFocus();
		expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
	});

	it.each([false, true])(
		"reveals the offscreen current model on opening or list arrival (loaded=%s)",
		async (loaded) => {
			mockModelListGeometry();
			const send = vi.fn();
			const payload: ServerPayload = {
				...models,
				current: { provider: "nan", id: "big", name: "NaN Big" },
			};
			const initial = loaded
				? reduce(ready, { type: "server", message: { ...payload, seq: 1 } as ServerMessage })
				: ready;
			render(<Harness initial={initial} send={send} />);
			await userEvent.click(screen.getByRole("button", { name: loaded ? "Model: NaN Big" : "Model: GPT-5" }));
			if (!loaded) dispatchServer(payload);
			expect(list().scrollTop).toBe(100);
			expect(option("NaN Big")).toHaveAttribute("aria-selected", "true");
			const search = screen.getByRole("searchbox", { name: "Search models" });
			expect(search).toHaveAttribute("aria-activedescendant", option("NaN Big").id);
			expect(search).toHaveFocus();
			expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		},
	);

	it.each([false, true])(
		"Escape closes the later picker before the drawer (Thinking=%s)",
		async (thinking) => {
			const send = vi.fn();
			render(<Harness initial={ready} send={send} />);
			await userEvent.click(screen.getByRole("button", { name: "Panel menu" }));
			const chip = screen.getByRole("button", { name: "Model: GPT-5" });
			for (let n = 0; n < 40 && document.activeElement !== chip; n++) await userEvent.tab();
			expect(chip).toHaveFocus();
			await userEvent.keyboard("{Enter}");
			dispatchServer(models);
			expect(screen.getByRole("navigation", { name: "Panel menu" })).toBeInTheDocument();
			expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
			if (thinking) await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }));
			await userEvent.keyboard("{Escape}");
			expect(screen.getByRole("navigation", { name: "Panel menu" })).toBeInTheDocument();
			if (thinking) {
				expect(screen.queryByRole("listbox", { name: "Thinking" })).not.toBeInTheDocument();
				expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
				await userEvent.keyboard("{Escape}");
				expect(screen.getByRole("navigation", { name: "Panel menu" })).toBeInTheDocument();
			}
			expect(screen.queryByRole("dialog", { name: "Choose a model" })).not.toBeInTheDocument();
			expect(chip).toHaveFocus();
			expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		},
	);

	it("Escape closes Thinking before the model picker", async () => {
		const { send } = await openPicker();
		await userEvent.click(screen.getByRole("combobox", { name: "Thinking" }));
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("listbox", { name: "Thinking" })).not.toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
		expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it.each(["{ArrowDown}", "{ArrowUp}", "{Enter}", " "])(
		"Thinking owns its opening key %s and navigation without moving or submitting a model",
		async (key) => {
			const { send } = await openPicker();
			const search = screen.getByRole("searchbox", { name: "Search models" });
			const selected = search.getAttribute("aria-activedescendant");
			screen.getByRole("combobox", { name: "Thinking" }).focus();
			await userEvent.keyboard(key);
			expect(screen.getByRole("listbox", { name: "Thinking" })).toBeInTheDocument();
			expect(search).toHaveAttribute("aria-activedescendant", selected);
			await userEvent.keyboard("{ArrowDown}");
			expect(search).toHaveAttribute("aria-activedescendant", selected);
			await userEvent.keyboard("{ArrowUp}");
			expect(search).toHaveAttribute("aria-activedescendant", selected);
			expect(send.mock.calls).toEqual([[{ type: "models_list" }]]);
			await userEvent.keyboard("{ArrowDown}{Enter}");
			expect(send.mock.calls).toEqual([
				[{ type: "models_list" }],
				[{ type: "model_set", provider: "openai", id: "gpt-5", thinking: "high" }],
			]);
			expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
		},
	);

	it("shows the current model in a compact chip and opens a list grouped by account, with profiles", async () => {
		const { send, dialog } = await openPicker();
		expect(send).toHaveBeenCalledWith({ type: "models_list" });
		expect(screen.getByRole("button", { name: "Model: GPT-5" })).toHaveAttribute("aria-expanded", "true");
		expect(within(dialog).getByRole("searchbox", { name: "Search models" })).toHaveFocus();
		const groups = within(dialog).getAllByRole("group");
		expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["OpenAI", "NaN", "Profiles"]);
		expect(within(groups[0] as HTMLElement).getAllByRole("option")).toHaveLength(2);
		expect(within(groups[2] as HTMLElement).getByRole("option", { name: /daily/ })).toBeInTheDocument();
		expect(option("GPT-5")).toHaveAttribute("aria-current", "true");
	});

	it("filters by model or account name as the user types", async () => {
		await openPicker();
		await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "nan");
		expect(
			within(list())
				.getAllByRole("option")
				.map((o) => o.textContent),
		).toEqual([expect.stringContaining("NaN Big")]);
		await userEvent.clear(screen.getByRole("searchbox", { name: "Search models" }));
		await userEvent.type(screen.getByRole("searchbox", { name: "Search models" }), "zzz");
		expect(within(list()).queryAllByRole("option")).toEqual([]);
		expect(screen.getByText("No models match.")).toBeInTheDocument();
	});

	it("selects a model by click, keeping the thinking level when the new model supports it", async () => {
		const { send } = await openPicker();
		await userEvent.click(option("NaN Big"));
		expect(send).toHaveBeenLastCalledWith({
			type: "model_set",
			provider: "nan",
			id: "big",
			thinking: "medium",
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("moves with the arrow keys and selects with Enter", async () => {
		const { send } = await openPicker();
		const search = screen.getByRole("searchbox", { name: "Search models" });
		// The highlight starts on the current model.
		expect(search).toHaveAttribute("aria-activedescendant", option("GPT-5").id);
		await userEvent.keyboard("{ArrowDown}");
		expect(search).toHaveAttribute("aria-activedescendant", option("GPT-4o mini").id);
		await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
		expect(search).toHaveAttribute("aria-activedescendant", option("NaN Big").id);
		await userEvent.keyboard("{Enter}");
		expect(send).toHaveBeenLastCalledWith({
			type: "model_set",
			provider: "nan",
			id: "big",
			thinking: "medium",
		});
	});

	it("applies a profile from the quick picks", async () => {
		const { send } = await openPicker();
		await userEvent.click(option("daily"));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_apply", name: "daily" });
	});

	it("closes on Esc and returns focus to the chip, without letting Esc hide the panel", async () => {
		await openPicker();
		const seen: boolean[] = [];
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") seen.push(event.defaultPrevented);
		};
		window.addEventListener("keydown", onKey);
		await userEvent.keyboard("{Escape}");
		window.removeEventListener("keydown", onKey);
		expect(seen).toEqual([true]);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Model: GPT-5" })).toHaveFocus();
	});

	it("shows the thinking level only when the current model supports it", async () => {
		const { send } = await openPicker();
		const thinking = screen.getByRole("combobox", { name: "Thinking" });
		await userEvent.click(thinking);
		const list = screen.getByRole("listbox", { name: "Thinking" });
		const options = within(list).getAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual([...levels]);
		await userEvent.click(within(list).getByRole("option", { name: "high" }));
		expect(send).toHaveBeenLastCalledWith({
			type: "model_set",
			provider: "openai",
			id: "gpt-5",
			thinking: "high",
		});
		dispatchServer({ ...models, current: { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" } });
		expect(screen.queryByRole("combobox", { name: "Thinking" })).not.toBeInTheDocument();
	});

	it("follows the chosen model, says when it waits for the next message, and shows errors inline", async () => {
		await openPicker(vi.fn(), { ...ready, agentState: "thinking" });
		dispatchServer({ ...models, next: { provider: "nan", id: "big", name: "NaN Big" } });
		expect(screen.getByText("NaN Big is used from your next message.")).toBeInTheDocument();
		dispatchServer({ type: "error", code: "model_unavailable", message: "That model is not available." });
		expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
			"That model is not available.",
		);
		// Inline, not a toast as well.
		expect(document.querySelector(".notices")).toBeNull();
		dispatchServer({ ...models, current: { provider: "nan", id: "big", name: "NaN Big", thinking: "low" } });
		expect(screen.getByRole("button", { name: "Model: NaN Big" })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
