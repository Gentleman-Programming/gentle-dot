/** The chat's own scroll behaviour, shared by the message list and the surface that wraps it. */

/**
 * The element that actually scrolls the conversation: the first scrollable element at or above
 * `from`. `from` may be the container itself or anything inside it.
 */
export function chatScrollContainer(from: HTMLElement | null): HTMLElement | null {
	for (let el = from; el; el = el.parentElement) {
		const { overflowY } = getComputedStyle(el);
		if (overflowY === "auto" || overflowY === "scroll") return el;
	}
	return null;
}

/**
 * Sends the conversation to its first or last message. `scrollIntoView` aligns the edge of an
 * element with the edge of the container and leaves the container's own padding unscrolled, so the
 * container is sent to its true end instead; it is only a fallback for when nothing scrolls.
 */
export function scrollChatTo(from: HTMLElement | null, edge: "start" | "end"): void {
	const container = chatScrollContainer(from);
	if (!container) {
		from?.scrollIntoView?.({ block: edge === "start" ? "start" : "end" });
		return;
	}
	container.scrollTop = edge === "start" ? 0 : container.scrollHeight;
}

/** True for the fields where Ctrl+Home and Ctrl+End are the caret's own commands, not the chat's. */
function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	// `isContentEditable` is the reliable signal in a browser; the attribute covers engines that do
	// not expose it.
	if (target.isContentEditable || target.getAttribute("contenteditable") === "true") return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The chat edge a key event asks for, or undefined when the key is not the chat's to handle.
 * Takes a structural event so the decision stays pure and testable away from React.
 */
export function chatScrollKey(event: {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	target: EventTarget | null;
}): "start" | "end" | undefined {
	if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return undefined;
	if (event.key !== "Home" && event.key !== "End") return undefined;
	if (isTextEntry(event.target)) return undefined;
	return event.key === "Home" ? "start" : "end";
}
