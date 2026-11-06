/**
 * The two rules the channel contract owns, so no provider re-implements them
 * (Gentleman-Programming#48):
 *
 *  1. "The transport never answers itself" — an inbound carrying an id this
 *     transport just sent is the transport's own echo and is dropped here, not
 *     by a per-bridge `fromMe`-style flag.
 *  2. "The transport resolves the channel identity" — every inbound carries a
 *     branded label, so the assistant and the transcript never lose track of
 *     which channel they are answering.
 */

export interface MessageEchoGuard {
	/** Records an id this transport sent, so its own echo can be dropped. */
	remember(id: string): void;
	/** True when this id came from the transport itself. */
	isEcho(id: string): boolean;
}

/**
 * A bounded set of the ids this transport sent. `limit` caps memory: past it the
 * oldest id is forgotten, which only risks letting an older echo through, never
 * dropping a fresh message.
 */
export function createEchoGuard(limit = 200): MessageEchoGuard {
	const sent = new Set<string>();
	const capacity = limit > 0 ? limit : 1;
	return {
		remember(id: string): void {
			if (id === "" || sent.has(id)) return;
			sent.add(id);
			if (sent.size <= capacity) return;
			const oldest = sent.values().next();
			if (!oldest.done) sent.delete(oldest.value);
		},
		isEcho(id: string): boolean {
			return id !== "" && sent.has(id);
		},
	};
}

/**
 * Prepends the channel label to what the assistant receives. Idempotent, so a
 * provider that already branded its text does not brand it twice, and a blank
 * inbound stays blank instead of sending a label with nothing after it.
 */
export function brandInbound(label: string, text: string): string {
	const trimmed = text.trim();
	if (trimmed === "") return "";
	if (trimmed.startsWith(label)) return trimmed;
	return label.endsWith(" ") ? `${label}${trimmed}` : `${label} ${trimmed}`;
}
