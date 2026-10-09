import type { ClientMessage } from "@gentle-dot/protocol";

export type Send = (message: ClientMessage) => void;

export function newRequestId(): string {
	return crypto.randomUUID();
}
