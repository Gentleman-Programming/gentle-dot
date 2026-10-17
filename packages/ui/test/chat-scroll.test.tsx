import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatScrollContainer, chatScrollKey, scrollChatTo } from "../src/chat-scroll.ts";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState } from "../src/store.ts";

const open: DotState = { ...initialState, connection: "open", agentState: "idle" };

/** jsdom has no layout: the scroll facts are supplied, so the behaviour under test is the decision. */
function scrollable(element: HTMLElement) {
	element.style.overflowY = "auto";
	let scrollTop = 0;
	Object.defineProperty(element, "clientHeight", { get: () => 400, configurable: true });
	Object.defineProperty(element, "scrollHeight", { get: () => 900, configurable: true });
	Object.defineProperty(element, "scrollTop", {
		get: () => scrollTop,
		set: (value: number) => {
			scrollTop = value;
		},
		configurable: true,
	});
	return () => scrollTop;
}

const key = (over: Partial<Parameters<typeof chatScrollKey>[0]> = {}) => ({
	key: "End",
	ctrlKey: true,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	target: null,
	...over,
});

describe("chat scroll keys", () => {
	it("takes Ctrl+End and Ctrl+Home, and their macOS command form", () => {
		expect(chatScrollKey(key())).toBe("end");
		expect(chatScrollKey(key({ key: "Home" }))).toBe("start");
		expect(chatScrollKey(key({ ctrlKey: false, metaKey: true }))).toBe("end");
	});

	it("leaves every other key, modifier and text field alone", () => {
		expect(chatScrollKey(key({ key: "PageDown" }))).toBeUndefined();
		expect(chatScrollKey(key({ ctrlKey: false }))).toBeUndefined();
		expect(chatScrollKey(key({ altKey: true }))).toBeUndefined();
		expect(chatScrollKey(key({ shiftKey: true }))).toBeUndefined();
		const field = document.createElement("textarea");
		expect(chatScrollKey(key({ target: field }))).toBeUndefined();
		expect(chatScrollKey(key({ key: "Home", target: field }))).toBeUndefined();
		const editable = document.createElement("div");
		editable.setAttribute("contenteditable", "true");
		expect(chatScrollKey(key({ target: editable }))).toBeUndefined();
	});
});

describe("chat scroll behaviour", () => {
	it("finds the scrollable container above the newest message", () => {
		const container = document.createElement("div");
		container.style.overflowY = "auto";
		const inner = document.createElement("div");
		const sentinel = document.createElement("div");
		inner.append(sentinel);
		container.append(inner);
		expect(chatScrollContainer(sentinel)).toBe(container);
		expect(chatScrollContainer(container)).toBe(container);
		expect(chatScrollContainer(document.createElement("div"))).toBeNull();
	});

	it("sends the container to its true end and back to its start", () => {
		const container = document.createElement("div");
		const scrollTop = scrollable(container);
		scrollChatTo(container, "end");
		expect(scrollTop()).toBe(900);
		scrollChatTo(container, "start");
		expect(scrollTop()).toBe(0);
	});
});

describe("the chat region owns its keys", () => {
	const renderChat = () => {
		const { container } = render(
			<ChatSurface variant="panel" state={open} send={vi.fn()} dismiss={vi.fn()} onHide={vi.fn()} />,
		);
		const body = container.querySelector<HTMLElement>(".chat-body[tabindex='0']");
		if (!body) throw new Error("the conversation region is not focusable");
		return { body, scrollTop: scrollable(body) };
	};

	afterEach(() => vi.restoreAllMocks());

	it("is focusable and named, so keyboard scrolling can reach it", () => {
		const { body } = renderChat();
		expect(body).toHaveAttribute("aria-label", "Conversation");
		body.focus();
		expect(document.activeElement).toBe(body);
	});

	it("jumps to the last message with Ctrl+End and to the first with Ctrl+Home", () => {
		const { body, scrollTop } = renderChat();
		body.focus();
		fireEvent.keyDown(body, { key: "End", ctrlKey: true });
		expect(scrollTop()).toBe(900);
		fireEvent.keyDown(body, { key: "Home", ctrlKey: true });
		expect(scrollTop()).toBe(0);
	});

	it("leaves a text field inside the region alone", () => {
		const { body, scrollTop } = renderChat();
		const field = document.createElement("textarea");
		body.append(field);
		fireEvent.keyDown(field, { key: "End", ctrlKey: true, bubbles: true });
		expect(scrollTop()).toBe(0);
	});
});
