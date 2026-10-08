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

/** Messages the user sent while the assistant was busy, waiting to be taken. */
export interface MessageQueue {
	/** Delivered after the current step. */
	steering: string[];
	/** Delivered when the assistant finishes. */
	followUp: string[];
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

/** Reasoning effort levels the engine accepts. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The model and thinking level one role uses; an empty route means "Default". */
export interface RoleRoute {
	/** `provider/model-id`. */
	model?: string;
	thinking?: ThinkingLevel;
}

/** Routes keyed by role id (`orchestrator`, an agent name, or a review role). */
export type ProfileRoles = Record<string, RoleRoute>;

export interface Profile {
	name: string;
	roles: ProfileRoles;
}

/** A role the user can route, with a plain-language label. */
export interface ProfileRole {
	id: string;
	label: string;
}

/** A model the assistant can use; never carries endpoints, headers, or costs. */
export interface ModelOption {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const ROLE_ID = /^[A-Za-z0-9._:@/+%-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9._~:@/+%-]{1,256}$/;
const MAX_ROLES = 200;

/** Profile names follow the engine's rule: 1-64 letters, numbers, `.`, `_`, `-`, starting with a letter or number. */
export function isValidProfileName(value: unknown): value is string {
	return typeof value === "string" && PROFILE_NAME.test(value) && !RESERVED_NAMES.has(value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Validates a role map; empty routes are dropped. Returns undefined when anything is malformed. */
export function parseProfileRoles(value: unknown): ProfileRoles | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_ROLES) return undefined;
	const roles: ProfileRoles = {};
	for (const [role, raw] of entries) {
		if (!ROLE_ID.test(role) || RESERVED_NAMES.has(role)) return undefined;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
		const { model, thinking, ...rest } = raw as Record<string, unknown>;
		if (Object.keys(rest).length > 0) return undefined;
		if (model !== undefined && !(typeof model === "string" && MODEL_ID.test(model))) return undefined;
		if (thinking !== undefined && !isThinkingLevel(thinking)) return undefined;
		const route: RoleRoute = {};
		if (model !== undefined) route.model = model;
		if (thinking !== undefined) route.thinking = thinking;
		if (route.model !== undefined || route.thinking !== undefined) roles[role] = route;
	}
	return roles;
}

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
	| { type: "auth_logout"; providerId: string }
	| { type: "profiles_list" }
	| { type: "profile_save"; name: string; roles: ProfileRoles }
	| { type: "profile_rename"; from: string; to: string }
	| { type: "profile_duplicate"; from: string; to: string }
	| { type: "profile_delete"; name: string }
	| { type: "profile_apply"; name: string }
	| { type: "profile_import" }
	| { type: "profile_save_current"; name: string };

export type ServerPayload =
	| { type: "ready"; agentState: AgentState; conversationId?: string; model?: string }
	| { type: "agent_state"; state: AgentState }
	| { type: "user_message"; messageId: string; text: string }
	| { type: "message_delta"; messageId: string; delta: string }
	| {
			type: "message_done";
			messageId: string;
			text: string;
			/** The answer was stopped on purpose (Stop, or switching conversations). */
			stopped?: true;
			/** The answer failed; a plain-language explanation for the chat. */
			error?: string;
	  }
	| { type: "activity"; messageId: string; activity: Activity }
	| { type: "ask"; ask: Ask }
	| { type: "ask_resolved"; requestId: string }
	| { type: "toast"; level: "info" | "warning" | "error"; message: string }
	| { type: "history"; conversationId?: string; messages: HistoryMessage[] }
	| { type: "conversations"; conversations: ConversationSummary[]; activeId?: string }
	| { type: "interrupted" }
	| ({ type: "queue" } & MessageQueue)
	| { type: "error"; code: string; message: string }
	| { type: "auth_providers"; providers: AuthProvider[]; open?: boolean }
	| { type: "auth_prompt"; prompt: AuthPrompt }
	| { type: "auth_event"; flowId: string; event: AuthEvent }
	| { type: "auth_done"; flowId: string; providerId: string; ok: boolean; message?: string }
	| {
			type: "profiles";
			profiles: Profile[];
			active?: string;
			roles: ProfileRole[];
			models: ModelOption[];
			/** True when an existing setup with profiles can be imported. */
			importable: boolean;
			/** Set when the user typed `/profiles`. */
			open?: boolean;
	  }
	| { type: "profiles_imported"; imported: { from: string; to: string }[]; missingProviders: string[] };

/** Every daemon message carries a per-connection, monotonic `seq`. */
export type ServerMessage = ServerPayload & { seq: number };

const isString = (value: unknown): value is string => typeof value === "string";
const isOptional = (value: unknown, check: (v: unknown) => boolean) => value === undefined || check(value);
const MAX_TEXT = 100_000;

/**
 * Reads the complete queues from the engine's `queue_update` record. A missing
 * queue is empty and entries that are not text are dropped; returns undefined
 * when a queue is not a list.
 */
export function parseQueue(value: unknown): MessageQueue | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { steering = [], followUp = [] } = value as Record<string, unknown>;
	if (!Array.isArray(steering) || !Array.isArray(followUp)) return undefined;
	const texts = (list: unknown[]) => list.filter((item): item is string => isString(item) && item !== "");
	return { steering: texts(steering), followUp: texts(followUp) };
}

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
		case "profile_save": {
			const roles = parseProfileRoles(m.roles);
			return isValidProfileName(m.name) && roles ? { type: "profile_save", name: m.name, roles } : undefined;
		}
		case "profile_rename":
		case "profile_duplicate":
			return isValidProfileName(m.from) && isValidProfileName(m.to)
				? { type: m.type, from: m.from, to: m.to }
				: undefined;
		case "profile_delete":
		case "profile_apply":
		case "profile_save_current":
			return isValidProfileName(m.name) ? { type: m.type, name: m.name } : undefined;
		case "profiles_list":
		case "profile_import":
		case "abort":
		case "new_conversation":
		case "list_conversations":
		case "get_history":
			return { type: m.type };
		default:
			return undefined;
	}
}
