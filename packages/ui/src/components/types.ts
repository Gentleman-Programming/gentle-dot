import type { ClientMessage } from "@gentle-dot/protocol";

/** Sends to the daemon; `false` when the message could not be handed to an open connection. */
// biome-ignore lint/suspicious/noConfusingVoidType: a sender that reports nothing (tests, wrappers) counts as sent.
export type Send = (message: ClientMessage) => boolean | void;

export function newRequestId(): string {
	// crypto.randomUUID is secure-context only: a phone on http://<LAN-ip> has no such
	// context, and a missing id would throw before the message ever left the composer.
	// getRandomValues works everywhere, so fall back to it.
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
