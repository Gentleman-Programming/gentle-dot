import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/store.ts";

// jsdom has no layout and no ResizeObserver, so this test drives both directly: the shell closes
// the panel by hiding the chat body (clientHeight 0), and opening it lays the body out again.
class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];
	readonly callback: () => void;
	constructor(callback: () => void) {
		this.callback = callback;
		FakeResizeObserver.instances.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {}
}

const message = (id: string, text: string): ChatMessage => ({
	id,
	role: "assistant",
	text,
	activities: [],
	streaming: false,
});

function mount(messages: ChatMessage[]) {
	const { container } = render(
		<div className="chat-body" style={{ overflowY: "auto" }}>
			<MessageList messages={messages} />
		</div>,
	);
	const body = container.querySelector<HTMLElement>(".chat-body");
	if (!body) throw new Error("no .chat-body");
	let height = 0;
	let scrollTop = 0;
	const scrollHeight = 900;
	Object.defineProperty(body, "clientHeight", { get: () => height, configurable: true });
	Object.defineProperty(body, "scrollHeight", { get: () => scrollHeight, configurable: true });
	Object.defineProperty(body, "scrollTop", {
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
		configurable: true,
	});
	return {
		/** The panel opens: the body is laid out and the observer reports the new size. */
		open() {
			height = 400;
			FakeResizeObserver.instances.at(-1)?.callback();
		},
		/** The panel is resized while open, which must not move a reader's place. */
		resize() {
			height = 300;
			FakeResizeObserver.instances.at(-1)?.callback();
		},
		scrollTop: () => scrollTop,
	};
}

describe("chat scroll", () => {
	afterEach(() => {
		FakeResizeObserver.instances = [];
	});

	it("lands on the newest message when the panel opens with history already loaded", () => {
		globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
		const chat = mount([message("a", "older"), message("b", "newest")]);
		chat.open();
		expect(chat.scrollTop()).toBe(900);
	});

	it("keeps a reader's place when an open panel is only resized", () => {
		globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
		const chat = mount([message("a", "older"), message("b", "newest")]);
		chat.open();
		const opened = chat.scrollTop();
		chat.resize();
		expect(chat.scrollTop()).toBe(opened);
	});

	it("renders the empty chat without a scroll container of its own", () => {
		globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
		const { container } = render(<MessageList messages={[]} />);
		expect(container.querySelector(".messages")).toBeNull();
	});
});
