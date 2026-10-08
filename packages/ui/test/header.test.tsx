import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

const providers = [{ id: "openai", name: "OpenAI", methods: ["api_key" as const], configured: true }];

const ready = apply(
	{ ...initialState, connection: "open", agentState: "idle" },
	{ type: "auth_providers", providers },
	{ type: "profiles", profiles: [{ name: "daily", roles: {} }], roles: [], models: [], importable: false },
);

/** ChatSurface wired to the real reducer, so opening and closing actually happen. */
function Harness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	return (
		<ChatSurface
			variant="panel"
			state={state}
			send={send}
			dismiss={vi.fn()}
			dispatch={dispatch}
			onHide={vi.fn()}
		/>
	);
}

const box = () => screen.getByRole("textbox", { name: "Message" });

describe("header icons", () => {
	it("uses one set of 18 px stroke SVG icons with names and tooltips instead of text glyphs", () => {
		const { container } = render(<Harness initial={ready} send={vi.fn()} />);
		const names = ["Conversations", "Accounts", "Profiles", "New conversation", "Hide"];
		for (const name of names) {
			const button = screen.getByRole("button", { name });
			expect(button).toHaveAttribute("title", name);
			const icons = button.querySelectorAll("svg");
			expect(icons).toHaveLength(1);
			const icon = icons[0];
			expect(icon).toHaveAttribute("width", "18");
			expect(icon).toHaveAttribute("height", "18");
			expect(icon).toHaveAttribute("fill", "none");
			expect(icon).toHaveAttribute("stroke", "currentColor");
			expect(icon).toHaveAttribute("aria-hidden", "true");
			expect(button.textContent).toBe("");
		}
		const header = container.querySelector(".chat-header");
		for (const glyph of ["☰", "⚿", "◐", "＋", "–"]) expect(header?.textContent).not.toContain(glyph);
		// Each action has its own drawing.
		const drawings = names.map((name) => screen.getByRole("button", { name }).innerHTML);
		expect(new Set(drawings).size).toBe(names.length);
	});

	it("shows no Hide button in the browser", () => {
		render(<ChatSurface variant="web" state={ready} send={vi.fn()} dismiss={vi.fn()} />);
		expect(screen.queryByRole("button", { name: "Hide" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Profiles" })).toHaveAttribute("title", "Profiles");
	});
});

describe("typing closes open options", () => {
	it("closes the conversations list, accounts, and profiles when the first character is typed", async () => {
		const send = vi.fn();
		render(<Harness initial={ready} send={send} />);

		await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
		expect(screen.getByRole("navigation", { name: "Earlier conversations" })).toBeInTheDocument();
		await userEvent.type(box(), "h");
		expect(screen.queryByRole("navigation", { name: "Earlier conversations" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-expanded", "false");
		expect(box()).toHaveValue("h");

		await userEvent.clear(box());
		await userEvent.click(screen.getByRole("button", { name: "Accounts" }));
		expect(screen.getByRole("region", { name: "Accounts" })).toBeInTheDocument();
		await userEvent.type(box(), "hi");
		expect(screen.queryByRole("region", { name: "Accounts" })).not.toBeInTheDocument();

		await userEvent.clear(box());
		await userEvent.click(screen.getByRole("button", { name: "Profiles" }));
		expect(screen.getByRole("region", { name: "Profiles" })).toBeInTheDocument();
		await userEvent.type(box(), "x");
		expect(screen.queryByRole("region", { name: "Profiles" })).not.toBeInTheDocument();
		expect(box()).toHaveValue("x");
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
	});

	it("leaves an option opened while text is already typed until the box is emptied and typing starts again", async () => {
		render(<Harness initial={ready} send={vi.fn()} />);
		await userEvent.type(box(), "draft");
		await userEvent.click(screen.getByRole("button", { name: "Profiles" }));
		await userEvent.type(box(), " more");
		expect(screen.getByRole("region", { name: "Profiles" })).toBeInTheDocument();
		await userEvent.clear(box());
		await userEvent.type(box(), "n");
		expect(screen.queryByRole("region", { name: "Profiles" })).not.toBeInTheDocument();
	});

	it("keeps accounts open while a sign-in waits for the user's answer, but still closes the list", async () => {
		let s = reduce(ready, { type: "accounts", open: true });
		s = reduce(s, { type: "auth_started", providerId: "openai" });
		s = apply(s, {
			type: "auth_prompt",
			prompt: { flowId: "f1", kind: "secret", message: "Paste your API key" },
		});
		render(<Harness initial={s} send={vi.fn()} />);
		await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
		await userEvent.type(box(), "o");
		expect(screen.getByRole("region", { name: "Accounts" })).toBeInTheDocument();
		expect(screen.getByText("Paste your API key")).toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: "Earlier conversations" })).not.toBeInTheDocument();
	});

	it("closes accounts when a sign-in has no question showing", async () => {
		let s = reduce(ready, { type: "accounts", open: true });
		s = reduce(s, { type: "auth_started", providerId: "openai" });
		render(<Harness initial={s} send={vi.fn()} />);
		expect(screen.getByRole("region", { name: "Accounts" })).toBeInTheDocument();
		await userEvent.type(box(), "o");
		expect(screen.queryByRole("region", { name: "Accounts" })).not.toBeInTheDocument();
	});
});
