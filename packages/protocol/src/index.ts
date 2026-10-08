/** Version of the client <-> daemon protocol (docs/design.md §4). */
export const PROTOCOL_VERSION = 1;

/** WebSocket close codes used by the daemon. */
export const CloseCode = {
	unauthorized: 4401,
	badProtocol: 4400,
} as const;

export type AgentState = "starting" | "idle" | "thinking" | "working" | "needs_you" | "restarting" | "error";

export type ActivityKind = "read" | "edit" | "run" | "search" | "memory" | "delegate" | "other";

export interface Activity {
	id: string;
	kind: ActivityKind;
	title: string;
	status: "running" | "done" | "failed";
}

export interface Ask {
	requestId: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeoutMs?: number;
}

export interface HistoryMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	activities: Activity[];
}

export interface ConversationSummary {
	id: string;
	title: string;
	updatedAt: string;
}

export type AuthMethod = "oauth" | "api_key";

export interface AuthProvider {
	id: string;
	name: string;
	/** Sign-in methods the provider supports. */
	methods: AuthMethod[];
	/** Name of the subscription sign-in, for example "Claude Pro/Max". */
	oauthName?: string;
	configured: boolean;
	/** Where the working credential comes from, for example "stored" or "environment". */
	source?: string;
}

export interface AuthPrompt {
	flowId: string;
	kind: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: { id: string; label: string; description?: string }[];
}

export type AuthEvent =
	| { kind: "info"; message: string; links?: { url: string; label?: string }[] }
	| { kind: "auth_url"; url: string; instructions?: string }
	| { kind: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { kind: "progress"; message: string };

export type ClientMessage =
	| { type: "hello"; token: string; protocol: number }
	| { type: "send"; text: string; requestId?: string }
	| { type: "steer"; text: string }
	| { type: "abort" }
	| { type: "ui_response"; requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean }
	| { type: "new_conversation" }
	| { type: "list_conversations" }
	| { type: "open_conversation"; conversationId: string }
	| { type: "get_history" }
	| { type: "auth_list" }
	| { type: "auth_login"; providerId: string; method: AuthMethod }
	| { type: "auth_reply"; flowId: string; value?: string; cancelled?: boolean }
	| { type: "auth_logout"; providerId: string };

export type ServerPayload =
	| { type: "ready"; agentState: AgentState; conversationId?: string; model?: string }
	| { type: "agent_state"; state: AgentState }
	| { type: "user_message"; messageId: string; text: string }
	| { type: "message_delta"; messageId: string; delta: string }
	| { type: "message_done"; messageId: string; text: string }
	| { type: "activity"; messageId: string; activity: Activity }
	| { type: "ask"; ask: Ask }
	| { type: "ask_resolved"; requestId: string }
	| { type: "toast"; level: "info" | "warning" | "error"; message: string }
	| { type: "history"; conversationId?: string; messages: HistoryMessage[] }
	| { type: "conversations"; conversations: ConversationSummary[]; activeId?: string }
	| { type: "interrupted" }
	| { type: "error"; code: string; message: string }
	| { type: "auth_providers"; providers: AuthProvider[]; open?: boolean }
	| { type: "auth_prompt"; prompt: AuthPrompt }
	| { type: "auth_event"; flowId: string; event: AuthEvent }
	| { type: "auth_done"; flowId: string; providerId: string; ok: boolean; message?: string };

/** Every daemon message carries a per-connection, monotonic `seq`. */
export type ServerMessage = ServerPayload & { seq: number };

const isString = (value: unknown): value is string => typeof value === "string";
const isOptional = (value: unknown, check: (v: unknown) => boolean) => value === undefined || check(value);
const MAX_TEXT = 100_000;

/** Validates one raw client frame; returns undefined when it is not a known, well-formed message. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const m = value as Record<string, unknown>;
	switch (m.type) {
		case "hello":
			return isString(m.token) && typeof m.protocol === "number"
				? { type: "hello", token: m.token, protocol: m.protocol }
				: undefined;
		case "send":
			if (!isString(m.text) || m.text.trim() === "" || m.text.length > MAX_TEXT) return undefined;
			if (!isOptional(m.requestId, isString)) return undefined;
			return m.requestId === undefined
				? { type: "send", text: m.text }
				: { type: "send", text: m.text, requestId: m.requestId as string };
		case "steer":
			return isString(m.text) && m.text.trim() !== "" && m.text.length <= MAX_TEXT
				? { type: "steer", text: m.text }
				: undefined;
		case "ui_response": {
			if (!isString(m.requestId)) return undefined;
			if (m.cancelled === true) return { type: "ui_response", requestId: m.requestId, cancelled: true };
			if (typeof m.confirmed === "boolean") {
				return { type: "ui_response", requestId: m.requestId, confirmed: m.confirmed };
			}
			if (isString(m.value) && m.value.length <= MAX_TEXT) {
				return { type: "ui_response", requestId: m.requestId, value: m.value };
			}
			return undefined;
		}
		case "auth_login":
			return isString(m.providerId) && (m.method === "oauth" || m.method === "api_key")
				? { type: "auth_login", providerId: m.providerId, method: m.method }
				: undefined;
		case "auth_reply":
			if (!isString(m.flowId)) return undefined;
			if (m.cancelled === true) return { type: "auth_reply", flowId: m.flowId, cancelled: true };
			return isString(m.value) && m.value.length <= MAX_TEXT
				? { type: "auth_reply", flowId: m.flowId, value: m.value }
				: undefined;
		case "auth_logout":
			return isString(m.providerId) ? { type: "auth_logout", providerId: m.providerId } : undefined;
		case "auth_list":
			return { type: "auth_list" };
		case "open_conversation":
			return isString(m.conversationId)
				? { type: "open_conversation", conversationId: m.conversationId }
				: undefined;
		case "abort":
		case "new_conversation":
		case "list_conversations":
		case "get_history":
			return { type: m.type };
		default:
			return undefined;
	}
}
