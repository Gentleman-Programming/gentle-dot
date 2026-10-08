import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

let seq = 0;
function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: ++seq } as ServerMessage }),
		state,
	);
}

const open: DotState = { ...initialState, connection: "open", agentState: "idle" };

describe("queue state", () => {
	it("starts empty, takes each complete queue from the daemon, and replaces it", () => {
		expect(initialState.queue).toEqual({ steering: [], followUp: [] });
		let s = apply(open, { type: "queue", steering: ["first"], followUp: ["later"] });
		expect(s.queue).toEqual({ steering: ["first"], followUp: ["later"] });
		s = apply(s, { type: "queue", steering: [], followUp: ["later"] });
		expect(s.queue).toEqual({ steering: [], followUp: ["later"] });
	});

	it("forgets the queue on ready, since the daemon re-sends it when one exists", () => {
		const s = apply(
			open,
			{ type: "queue", steering: ["stale"], followUp: [] },
			{ type: "ready", agentState: "idle" },
		);
		expect(s.queue).toEqual({ steering: [], followUp: [] });
	});
});

function surface(state: DotState) {
	return <ChatSurface variant="web" state={state} send={vi.fn()} dismiss={vi.fn()} />;
}

describe("queued messages in the chat", () => {
	it("shows queued messages after the running answer as dimmed, labeled user bubbles", () => {
		const s = apply(
			{ ...open, agentState: "thinking" },
			{ type: "user_message", messageId: "u1", text: "write the report" },
			{ type: "message_delta", messageId: "m1", delta: "Working on it" },
			{ type: "queue", steering: ["add a summary"], followUp: ["then email it"] },
		);
		const { container } = render(surface(s));
		const articles = [...container.querySelectorAll("article")];
		expect(articles.map((a) => a.className)).toEqual([
			"message message-user",
			"message message-assistant",
			"message message-user message-queued",
			"message message-user message-queued",
		]);
		const queued = screen.getAllByRole("article", { name: "Queued message" });
		expect(queued.map((q) => within(q).getByText("Queued").textContent)).toEqual(["Queued", "Queued"]);
		expect(queued.map((q) => q.querySelector(".message-body")?.textContent)).toEqual([
			"add a summary",
			"then email it",
		]);
		expect(queued[0]?.querySelector(".message-body")).toHaveClass("message-plain");
	});

	it("shows a queued message even before any answer exists, without the greeting", () => {
		render(surface(apply(open, { type: "queue", steering: ["hello?"], followUp: [] })));
		expect(screen.queryByText("Hi! What can I do for you?")).not.toBeInTheDocument();
		expect(screen.getByRole("article", { name: "Queued message" })).toHaveTextContent("hello?");
	});

	it("turns a queued message into a normal one when the assistant takes it", () => {
		let s = apply(
			{ ...open, agentState: "thinking" },
			{ type: "user_message", messageId: "u1", text: "slow" },
			{ type: "queue", steering: ["queued one"], followUp: [] },
		);
		const { container, rerender } = render(surface(s));
		expect(screen.getByRole("article", { name: "Queued message" })).toHaveTextContent("queued one");
		s = apply(
			s,
			{ type: "message_done", messageId: "m1", text: "Echo: slow" },
			{ type: "queue", steering: [], followUp: [] },
			{ type: "user_message", messageId: "u2", text: "queued one" },
		);
		rerender(surface(s));
		expect(screen.queryByRole("article", { name: "Queued message" })).not.toBeInTheDocument();
		expect(screen.queryByText("Queued")).not.toBeInTheDocument();
		const users = [...container.querySelectorAll(".message-user")];
		expect(users.map((u) => u.textContent)).toEqual(["slow", "queued one"]);
		expect(users.every((u) => !u.classList.contains("message-queued"))).toBe(true);
	});
});
