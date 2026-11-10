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
	{ ...initialState, connection: "open", agentState: "idle", features: { conversations: true } },
	{ type: "auth_providers", providers },
	{ type: "profiles", profiles: [{ name: "daily", roles: {} }], roles: [], models: [], importable: false },
);

const single = apply(
	{ ...initialState, connection: "open", agentState: "idle" },
	{ type: "auth_providers", providers },
);

/** ChatSurface wired to the real reducer, so opening and closing actually happen. */
function Harness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	const panelWindow = {
		roseHidden: false,
		setRoseHidden: vi.fn(),
		fullscreen: false,
		setFullscreen: vi.fn(),
	};
	return (
		<ChatSurface
			variant="panel"
			state={state}
			send={send}
			dismiss={vi.fn()}
			dispatch={dispatch}
			onHide={vi.fn()}
			settings
			panelWindow={panelWindow}
		/>
	);
}

const box = () => screen.getByRole("textbox", { name: "Message" });
const openMenu = () => userEvent.click(screen.getByRole("button", { name: "Panel menu" }));
const drawer = () => screen.getByRole("navigation", { name: "Panel menu" });

describe("the panel menu drawer", () => {
	it("collapses the header icon row into one menu button, with the drawer closed until asked", () => {
		const { container } = render(<Harness initial={ready} send={vi.fn()} />);
		const menu = screen.getByRole("button", { name: "Panel menu" });
		expect(menu).toHaveAttribute("aria-expanded", "false");
		// The old loose icon row is gone: the actions live in the drawer now.
		for (const name of ["Accounts", "Profiles", "Connectors", "Settings", "Hide"]) {
			expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
		}
		expect(screen.queryByRole("navigation", { name: "Panel menu" })).not.toBeInTheDocument();
		// The header keeps only the state dot, the name and the menu button (plus the drag region).
		expect(container.querySelector(".chat-header")).not.toBeNull();
		expect(container.querySelectorAll(".chat-header .icon")).toHaveLength(1);
	});

	it("opens a drawer with every action grouped, and closes it by scrim, close button and Escape", async () => {
		render(<Harness initial={ready} send={vi.fn()} />);
		await openMenu();
		expect(drawer()).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Panel menu" })).toHaveAttribute("aria-expanded", "true");
		for (const name of [
			"New conversation",
			"Conversations",
			"Accounts",
			"Profiles",
			"Connectors",
			"Settings",
			"Hide the rose",
			"Full screen",
			"Hide",
		]) {
			expect(screen.getByRole("button", { name })).toBeInTheDocument();
		}

		await userEvent.click(screen.getByRole("button", { name: "Close menu" }));
		expect(screen.queryByRole("navigation", { name: "Panel menu" })).not.toBeInTheDocument();

		await openMenu();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("navigation", { name: "Panel menu" })).not.toBeInTheDocument();

		await openMenu();
		await userEvent.click(document.querySelector(".header-menu-scrim") as HTMLElement);
		expect(screen.queryByRole("navigation", { name: "Panel menu" })).not.toBeInTheDocument();
	});

	it("opens the screens from the drawer and closes it afterwards", async () => {
		const send = vi.fn();
		render(<Harness initial={ready} send={send} />);
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Accounts" }));
		expect(screen.getByRole("region", { name: "Accounts" })).toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: "Panel menu" })).not.toBeInTheDocument();

		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
		expect(screen.getByRole("navigation", { name: "Earlier conversations" })).toBeInTheDocument();
		expect(screen.queryByRole("navigation", { name: "Panel menu" })).not.toBeInTheDocument();
	});

	it("marks the open screen with the active rail", async () => {
		const s = reduce(ready, { type: "accounts", open: true });
		render(<Harness initial={s} send={vi.fn()} />);
		await openMenu();
		expect(screen.getByRole("button", { name: "Accounts" }).className).toContain("active");
		expect(screen.getByRole("button", { name: "Profiles" }).className).not.toContain("active");
	});

	it("gates the conversation rows: without the feature only a Pronto row shows", async () => {
		render(<Harness initial={single} send={vi.fn()} />);
		await openMenu();
		expect(screen.queryByRole("button", { name: "New conversation" })).not.toBeInTheDocument();
		const conversations = screen.getByRole("button", { name: /Conversations/ });
		expect(conversations).toBeDisabled();
		expect(conversations.textContent).toContain("Pronto");
	});

	it("keeps the drawer honest to the variant: no window rows in the browser", async () => {
		render(<ChatSurface variant="web" state={ready} send={vi.fn()} dismiss={vi.fn()} />);
		await openMenu();
		for (const name of ["Hide the rose", "Full screen", "Hide"]) {
			expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
		}
		// The drawer still carries what the browser has: integrations and the conversations row.
		expect(screen.getByRole("button", { name: "Accounts" })).toBeInTheDocument();
	});

	it("keeps a live session row working from the drawer", async () => {
		const onHide = vi.fn();
		render(<ChatSurface variant="panel" state={ready} send={vi.fn()} dismiss={vi.fn()} onHide={onHide} />);
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Hide" }));
		expect(onHide).toHaveBeenCalled();
	});
});

describe("typing closes open options", () => {
	it("closes the conversations list, accounts, and profiles when the first character is typed", async () => {
		const send = vi.fn();
		render(<Harness initial={ready} send={send} />);

		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
		expect(screen.getByRole("navigation", { name: "Earlier conversations" })).toBeInTheDocument();
		await userEvent.type(box(), "h");
		expect(screen.queryByRole("navigation", { name: "Earlier conversations" })).not.toBeInTheDocument();
		expect(box()).toHaveValue("h");

		await userEvent.clear(box());
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Accounts" }));
		expect(screen.getByRole("region", { name: "Accounts" })).toBeInTheDocument();
		await userEvent.type(box(), "hi");
		expect(screen.queryByRole("region", { name: "Accounts" })).not.toBeInTheDocument();

		await userEvent.clear(box());
		await openMenu();
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
		await openMenu();
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
		await openMenu();
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
