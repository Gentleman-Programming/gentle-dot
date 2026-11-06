import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/store.ts";

const user: ChatMessage = { id: "u1", role: "user", text: "hello", activities: [], streaming: false };
const streaming: ChatMessage = {
	id: "m1",
	role: "assistant",
	text: "Hel",
	activities: [],
	streaming: true,
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("waiting for the model", () => {
	it("shows that the assistant is thinking, with the time it has waited", () => {
		render(<MessageList messages={[user]} agentState="thinking" />);
		expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
		expect(screen.getByRole("status")).toHaveTextContent("0:00");
		act(() => vi.advanceTimersByTime(83_000));
		expect(screen.getByRole("status")).toHaveTextContent("1:23");
	});

	it("says it is working while a tool runs", () => {
		render(<MessageList messages={[user]} agentState="working" />);
		expect(screen.getByRole("status")).toHaveTextContent("Working…");
	});

	it("explains a long wait and how to get out of it", () => {
		render(<MessageList messages={[user]} agentState="thinking" />);
		expect(screen.queryByText(/still waiting/i)).not.toBeInTheDocument();
		act(() => vi.advanceTimersByTime(60_000));
		expect(screen.getByRole("status")).toHaveTextContent(
			"Still waiting on the model. You can stop and pick another one.",
		);
	});

	it("disappears once the answer starts to arrive", () => {
		render(<MessageList messages={[user, streaming]} agentState="thinking" />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("stays until the first words of the answer, even with an empty answer already open", () => {
		const empty = { ...streaming, text: "" };
		const { rerender } = render(<MessageList messages={[user, empty]} agentState="thinking" />);
		expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
		rerender(<MessageList messages={[user, streaming]} agentState="thinking" />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps the true time when the page's timers were held back", () => {
		render(<MessageList messages={[user]} agentState="thinking" />);
		vi.setSystemTime(Date.now() + 120_000);
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.getByRole("status")).toHaveTextContent("2:01");
		expect(screen.getByRole("status")).toHaveTextContent("Still waiting on the model.");
	});

	it("keeps the ticking time out of what screen readers announce", () => {
		render(<MessageList messages={[user]} agentState="thinking" />);
		expect(screen.getByText("0:00")).toHaveAttribute("aria-hidden", "true");
	});

	it("scrolls the long-wait hint into view", () => {
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		render(<MessageList messages={[user]} agentState="thinking" />);
		scroll.mockClear();
		act(() => vi.advanceTimersByTime(60_000));
		expect(scroll).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(Element.prototype, "scrollIntoView");
	});

	it("does not show while idle or waiting on you", () => {
		const { rerender } = render(<MessageList messages={[user]} agentState="idle" />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		rerender(<MessageList messages={[user]} agentState="needs_you" />);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("restarts the time for the next turn", () => {
		const { rerender } = render(<MessageList messages={[user]} agentState="thinking" />);
		act(() => vi.advanceTimersByTime(90_000));
		rerender(<MessageList messages={[user]} agentState="idle" />);
		rerender(<MessageList messages={[user]} agentState="thinking" />);
		expect(screen.getByRole("status")).toHaveTextContent("0:00");
	});
});
