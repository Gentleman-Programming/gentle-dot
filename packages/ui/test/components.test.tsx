import type { ClientMessage } from "@gentle-dot/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AskCard } from "../src/components/AskCard.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { MessageList } from "../src/components/MessageList.tsx";
import { type DotState, initialState } from "../src/store.ts";

function state(overrides: Partial<DotState> = {}): DotState {
	return { ...initialState, connection: "open", agentState: "idle", ...overrides };
}

describe("Composer", () => {
	it("sends on Enter and keeps a new line on Shift+Enter", async () => {
		const send = vi.fn<(message: ClientMessage) => void>();
		render(<Composer busy={false} disabled={false} send={send} />);
		const box = screen.getByRole("textbox", { name: "Message" });
		await userEvent.type(box, "first line{Shift>}{Enter}{/Shift}second{Enter}");
		expect(send).toHaveBeenCalledTimes(1);
		const sent = send.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ type: "send", text: "first line\nsecond" });
		expect(sent && "requestId" in sent && sent.requestId).toBeTruthy();
		expect(box).toHaveValue("");
	});

	it("does not send blank text", async () => {
		const send = vi.fn();
		render(<Composer busy={false} disabled={false} send={send} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "   {Enter}");
		expect(send).not.toHaveBeenCalled();
	});

	it("offers Stop while the assistant works", async () => {
		const send = vi.fn();
		render(<Composer busy disabled={false} send={send} />);
		await userEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(send).toHaveBeenCalledWith({ type: "abort" });
	});
});

describe("AskCard", () => {
	it("answers a select with the chosen option", async () => {
		const send = vi.fn();
		render(
			<AskCard
				ask={{ requestId: "q1", method: "select", title: "Pick a color", options: ["Red", "Blue"] }}
				send={send}
			/>,
		);
		expect(screen.getByText("Pick a color")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Blue" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "q1", value: "Blue" });
	});

	it("answers a confirm with yes or no", async () => {
		const send = vi.fn();
		render(
			<AskCard
				ask={{ requestId: "q2", method: "confirm", title: "Proceed?", message: "It is safe" }}
				send={send}
			/>,
		);
		expect(screen.getByText("It is safe")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "No" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "q2", confirmed: false });
	});

	it("answers an input with typed text and can be dismissed", async () => {
		const send = vi.fn();
		render(
			<AskCard
				ask={{ requestId: "q3", method: "input", title: "Your name", placeholder: "Name" }}
				send={send}
			/>,
		);
		await userEvent.type(screen.getByPlaceholderText("Name"), "Ada");
		await userEvent.click(screen.getByRole("button", { name: "Send answer" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "q3", value: "Ada" });
		await userEvent.click(screen.getByRole("button", { name: "Skip" }));
		expect(send).toHaveBeenLastCalledWith({ type: "ui_response", requestId: "q3", cancelled: true });
	});
});

describe("MessageList", () => {
	it("renders Markdown and summarizes activities", async () => {
		render(
			<MessageList
				messages={[
					{ id: "u1", role: "user", text: "check it", streaming: false, activities: [] },
					{
						id: "m1",
						role: "assistant",
						text: "All **good**",
						streaming: false,
						activities: [
							{ id: "a", kind: "read", title: "Reading a.md", status: "done" },
							{ id: "b", kind: "read", title: "Reading b.md", status: "done" },
							{ id: "c", kind: "run", title: "Running a command", status: "failed" },
						],
					},
				]}
			/>,
		);
		expect(screen.getByText("good").tagName).toBe("STRONG");
		const summary = screen.getByRole("button", { name: /Read 2 files · Ran 1 command/ });
		await userEvent.click(summary);
		expect(screen.getByText("Reading b.md")).toBeInTheDocument();
	});
});

describe("ChatSurface", () => {
	it("shows the interruption prompt and continues", async () => {
		const send = vi.fn();
		render(<ChatSurface variant="web" state={state({ interrupted: true })} send={send} dismiss={vi.fn()} />);
		expect(screen.getByText("I was interrupted. Continue?")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "send", text: "Continue where you left off." }),
		);
	});

	it("starts a new conversation and opens an earlier one", async () => {
		const send = vi.fn();
		render(
			<ChatSurface
				variant="web"
				state={state({
					conversationId: "b.jsonl",
					conversations: [
						{ id: "b.jsonl", title: "Current", updatedAt: "2026-10-08T10:00:00.000Z" },
						{ id: "a.jsonl", title: "Trip plan", updatedAt: "2026-10-07T10:00:00.000Z" },
					],
				})}
				send={send}
				dismiss={vi.fn()}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Current" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
		expect(send).toHaveBeenCalledWith({ type: "new_conversation" });
		await userEvent.click(screen.getByRole("button", { name: "Conversations" }));
		await userEvent.click(screen.getByRole("button", { name: /Trip plan/ }));
		expect(send).toHaveBeenCalledWith({ type: "open_conversation", conversationId: "a.jsonl" });
	});

	it("explains a lost connection and a rejected token", () => {
		const { rerender } = render(
			<ChatSurface variant="web" state={state({ connection: "closed" })} send={vi.fn()} dismiss={vi.fn()} />,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
		rerender(
			<ChatSurface
				variant="web"
				state={state({ connection: "unauthorized" })}
				send={vi.fn()}
				dismiss={vi.fn()}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("open the link the assistant printed");
	});

	it("shows notices that can be dismissed", () => {
		const dismiss = vi.fn();
		render(
			<ChatSurface
				variant="web"
				state={state({ notices: [{ id: 7, level: "error", message: "That did not work." }] })}
				send={vi.fn()}
				dismiss={dismiss}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(dismiss).toHaveBeenCalledWith(7);
	});
});
