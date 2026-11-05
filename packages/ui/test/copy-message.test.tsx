import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/store.ts";

const message = (over: Partial<ChatMessage>): ChatMessage => ({
	id: "m1",
	role: "assistant",
	text: "**bold** answer",
	activities: [],
	streaming: false,
	...over,
});

const list = (messages: ChatMessage[]) => (
	<MessageList messages={messages} queued={[]} hasEarlier={false} onShowEarlier={vi.fn()} />
);

function mockClipboard(writeText: (text: string) => Promise<void>) {
	const user = userEvent.setup();
	vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
	return user;
}

afterEach(() => vi.restoreAllMocks());

describe("copying an answer", () => {
	it("copies the original markdown and confirms it", async () => {
		const writeText = vi.fn(async () => {});
		const user = mockClipboard(writeText);
		render(list([message({})]));
		await user.click(screen.getByRole("button", { name: "Copy answer" }));
		expect(writeText).toHaveBeenCalledWith("**bold** answer");
		expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
	});

	it("says so when the clipboard refuses", async () => {
		const user = mockClipboard(async () => {
			throw new Error("denied");
		});
		render(list([message({})]));
		await user.click(screen.getByRole("button", { name: "Copy answer" }));
		expect(await screen.findByRole("button", { name: "Could not copy" })).toBeInTheDocument();
	});

	it("offers no copy while an answer streams, on your own messages, or on an empty answer", () => {
		render(
			list([
				message({ id: "a", streaming: true }),
				message({ id: "b", role: "user", text: "hello" }),
				message({ id: "c", text: "" }),
			]),
		);
		expect(screen.queryByRole("button", { name: "Copy answer" })).not.toBeInTheDocument();
	});
});
