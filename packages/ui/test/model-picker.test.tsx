import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
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

describe("model picker (S32)", () => {
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
		expect(
			within(thinking)
				.getAllByRole("option")
				.map((o) => o.textContent),
		).toEqual([...levels]);
		await userEvent.selectOptions(thinking, "high");
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
