import type { ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

const open: DotState = { ...initialState, connection: "open", agentState: "idle" };
const single = apply(open, { type: "ready", agentState: "idle", features: { conversations: false } });
const withList = apply(open, { type: "ready", agentState: "idle", features: { conversations: true } });

const turn = (id: string, role: "user" | "assistant", text: string, earlier?: true) => ({
	id,
	role,
	text,
	activities: [],
	...(earlier ? { earlier } : {}),
});

describe("one continuous chat", () => {
	it("starts with the conversations list off until the daemon turns it on", () => {
		expect(initialState.features).toEqual({ conversations: false });
		expect(single.features.conversations).toBe(false);
		expect(withList.features.conversations).toBe(true);
		// A daemon that does not say keeps the single chat.
		expect(apply(withList, { type: "ready", agentState: "idle" }).features.conversations).toBe(false);
	});

	it("shows the assistant in the header, with no new-conversation button or conversations list", () => {
		const { container } = render(
			<ChatSurface variant="panel" state={single} send={vi.fn()} dismiss={vi.fn()} onHide={vi.fn()} />,
		);
		expect(screen.queryByRole("button", { name: "New conversation" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Conversations" })).not.toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gentle Dot");
		expect(container.querySelector(".chat-header .rose-glyph")).not.toBeNull();
		for (const name of ["Accounts", "Profiles", "Hide"]) {
			expect(screen.getByRole("button", { name })).toBeInTheDocument();
		}
	});

	it("brings the conversations back when the flag is on", () => {
		render(<ChatSurface variant="web" state={withList} send={vi.fn()} dismiss={vi.fn()} />);
		expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Conversations" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("New conversation");
	});
});

describe("recent history", () => {
	const history = apply(single, {
		type: "history",
		messages: [
			turn("s0-5", "user", "compact", true),
			turn("s0-6", "assistant", "Compacted.", true),
			turn("s1-1", "user", "two"),
			turn("s1-2", "assistant", "Echo: two"),
		],
		hasEarlier: true,
	});

	it("keeps whether more messages exist, and puts an earlier page on top", () => {
		expect(history.hasEarlier).toBe(true);
		const more = apply(history, {
			type: "earlier",
			before: "s0-5",
			messages: [turn("s0-3", "user", "one", true), turn("s0-4", "assistant", "Echo: one", true)],
			hasEarlier: false,
		});
		expect(more.messages.map((m) => m.text)).toEqual([
			"one",
			"Echo: one",
			"compact",
			"Compacted.",
			"two",
			"Echo: two",
		]);
		expect(more.hasEarlier).toBe(false);
		// A page for messages this window no longer shows is dropped.
		const stale = apply(history, {
			type: "earlier",
			before: "s9-1",
			messages: [turn("s9-0", "user", "old", true)],
			hasEarlier: true,
		});
		expect(stale.messages).toBe(history.messages);
		// History without the flag means there is nothing earlier.
		expect(apply(history, { type: "history", messages: [] }).hasEarlier).toBe(false);
	});

	it("asks for the page before the first message with Show earlier", async () => {
		const send = vi.fn<(m: ClientMessage) => void>();
		render(<ChatSurface variant="web" state={history} send={send} dismiss={vi.fn()} />);
		await userEvent.click(screen.getByRole("button", { name: "Show earlier" }));
		expect(send).toHaveBeenCalledWith({ type: "get_earlier", before: "s0-5" });
	});

	it("hides Show earlier when nothing earlier exists", () => {
		render(
			<ChatSurface
				variant="web"
				state={{ ...history, hasEarlier: false }}
				send={vi.fn()}
				dismiss={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Show earlier" })).not.toBeInTheDocument();
	});

	it("draws one subtle divider where the earlier session ends", () => {
		const { container } = render(
			<ChatSurface variant="web" state={history} send={vi.fn()} dismiss={vi.fn()} />,
		);
		expect(screen.getAllByRole("separator", { name: "Earlier messages" })).toHaveLength(1);
		expect(container.querySelector(".earlier-divider")).toHaveTextContent("Earlier messages");
		const order = [...container.querySelectorAll(".messages > *")].map((el) =>
			el.matches(".earlier-divider") ? "divider" : el.textContent,
		);
		expect(order.slice(0, 5)).toEqual(["Show earlier", "compact", "Compacted.", "divider", "two"]);
	});

	it("draws no divider when every message is from the current session", () => {
		const s = apply(single, { type: "history", messages: [turn("s0-1", "user", "hi")] });
		render(<ChatSurface variant="web" state={s} send={vi.fn()} dismiss={vi.fn()} />);
		expect(screen.queryByRole("separator", { name: "Earlier messages" })).not.toBeInTheDocument();
	});
});

const desktop = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
const dot = vi.hoisted(() => ({ state: undefined as unknown, send: undefined as unknown }));

vi.mock("../src/desktop.ts", () => ({
	inDesktop: () => true,
	connectionInfo: () => new Promise(() => {}),
	hidePanel: () => {},
	togglePanel: () => {},
	setDotState: () => {},
	startDragging: async () => {},
	openUrl: () => {},
	onDesktopEvent: async (name: string, handler: () => void) => {
		desktop.handlers.set(name, handler);
		return () => desktop.handlers.delete(name);
	},
}));

vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: dot.state, send: dot.send, dismiss: () => {}, dispatch: () => {} }),
}));

describe("menu bar New conversation", () => {
	afterEach(() => {
		desktop.handlers.clear();
		window.history.replaceState(null, "", "/");
	});

	async function trayClick(state: DotState) {
		const send = vi.fn();
		dot.state = state;
		dot.send = send;
		window.history.replaceState(null, "", "/?surface=panel");
		const { App } = await import("../src/App.tsx");
		render(<App />);
		await vi.waitFor(() => expect(desktop.handlers.has("dot://new-conversation")).toBe(true));
		act(() => desktop.handlers.get("dot://new-conversation")?.());
		return send;
	}

	it("is ignored in the single chat", async () => {
		const send = await trayClick(single);
		expect(send).not.toHaveBeenCalled();
	});

	it("starts a new conversation when the list is on", async () => {
		const send = await trayClick(withList);
		expect(send).toHaveBeenCalledWith({ type: "new_conversation" });
	});
});
