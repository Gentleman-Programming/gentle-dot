import type {
	Activity,
	AgentState,
	Ask,
	AuthEvent,
	AuthPrompt,
	AuthProvider,
	ConversationSummary,
	MessageQueue,
	ModelOption,
	Profile,
	ProfileRole,
	ServerMessage,
} from "@gentle-dot/protocol";

export interface AuthFlowState {
	providerId: string;
	flowId?: string;
	events: AuthEvent[];
	prompt?: AuthPrompt;
	done?: { ok: boolean; message?: string };
}

export interface AuthState {
	open: boolean;
	/** Undefined until the first provider list arrives. */
	providers?: AuthProvider[];
	flow?: AuthFlowState;
}

export interface ProfilesState {
	open: boolean;
	/** Undefined until the first list arrives. */
	list?: Profile[];
	active?: string;
	roles: ProfileRole[];
	models: ModelOption[];
	importable: boolean;
	/** The last import's result, shown until the screen closes. */
	lastImport?: { imported: { from: string; to: string }[]; missingProviders: string[] };
}

export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthorized";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	streaming: boolean;
	activities: Activity[];
	/** How an answer ended when it did not finish normally. */
	note?: { kind: "stopped" | "error"; text: string };
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
}

export interface DotState {
	connection: ConnectionStatus;
	agentState: AgentState;
	conversationId?: string;
	model?: string;
	messages: ChatMessage[];
	/** Messages sent while the assistant works, not taken yet. */
	queue: MessageQueue;
	asks: Ask[];
	conversations: ConversationSummary[];
	interrupted: boolean;
	notices: Notice[];
	auth: AuthState;
	profiles: ProfilesState;
}

export type DotAction =
	| { type: "server"; message: ServerMessage }
	| { type: "connection"; status: ConnectionStatus }
	| { type: "dismiss"; id: number }
	| { type: "accounts"; open: boolean }
	| { type: "profiles"; open: boolean }
	| { type: "auth_started"; providerId: string };

export const initialState: DotState = {
	connection: "connecting",
	agentState: "starting",
	messages: [],
	queue: { steering: [], followUp: [] },
	asks: [],
	conversations: [],
	interrupted: false,
	notices: [],
	auth: { open: false },
	profiles: { open: false, roles: [], models: [], importable: false },
};

let nextNotice = 0;

export function reduce(state: DotState, action: DotAction): DotState {
	switch (action.type) {
		case "connection":
			return {
				...state,
				connection: action.status,
				messages: action.status === "open" ? state.messages : state.messages.map(stopStreaming),
			};
		case "dismiss":
			return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
		case "accounts": {
			// Closing drops the flow; reopening keeps a running one and leaves a finished one.
			const keep = action.open && state.auth.flow !== undefined && state.auth.flow.done === undefined;
			return {
				...closeProfiles(state, action.open),
				auth: { ...state.auth, open: action.open, flow: keep ? state.auth.flow : undefined },
			};
		}
		case "profiles":
			return openProfiles(state, action.open);
		case "auth_started":
			return {
				...state,
				auth: { ...state.auth, open: true, flow: { providerId: action.providerId, events: [] } },
			};
		case "server":
			return reduceServer(state, action.message);
	}
}

function reduceServer(state: DotState, message: ServerMessage): DotState {
	switch (message.type) {
		case "ready":
			return {
				...state,
				agentState: message.agentState,
				// The daemon sends the queue right after ready when one exists.
				queue: initialState.queue,
				conversationId: message.conversationId ?? state.conversationId,
				model: message.model ?? state.model,
			};
		case "agent_state":
			return { ...state, agentState: message.state };
		case "user_message":
			return {
				...state,
				interrupted: false,
				messages: [
					...state.messages,
					{ id: message.messageId, role: "user", text: message.text, streaming: false, activities: [] },
				],
			};
		case "message_delta":
			return updateAssistant(state, message.messageId, (m) => ({
				...m,
				text: m.text + message.delta,
				streaming: true,
			}));
		case "message_done":
			return updateAssistant(state, message.messageId, (m) => {
				const done: ChatMessage = { ...m, text: message.text, streaming: false };
				if (message.error !== undefined) done.note = { kind: "error", text: message.error };
				else if (message.stopped) done.note = { kind: "stopped", text: "Stopped." };
				return done;
			});
		case "activity":
			return updateAssistant(state, message.messageId, (m) => {
				const index = m.activities.findIndex((a) => a.id === message.activity.id);
				const activities =
					index < 0
						? [...m.activities, message.activity]
						: m.activities.map((a, i) => (i === index ? message.activity : a));
				return { ...m, activities };
			});
		case "ask":
			if (state.asks.some((a) => a.requestId === message.ask.requestId)) return state;
			return { ...state, asks: [...state.asks, message.ask] };
		case "ask_resolved":
			return { ...state, asks: state.asks.filter((a) => a.requestId !== message.requestId) };
		case "history":
			return {
				...state,
				interrupted: false,
				conversationId: message.conversationId ?? state.conversationId,
				messages: message.messages.map((m) => ({ ...m, streaming: false })),
			};
		case "conversations":
			return {
				...state,
				conversations: message.conversations,
				conversationId: message.activeId ?? state.conversationId,
			};
		case "interrupted":
			return { ...state, interrupted: true };
		case "queue":
			return { ...state, queue: { steering: message.steering, followUp: message.followUp } };
		case "auth_providers":
			return {
				...closeProfiles(state, message.open === true),
				auth: { ...state.auth, providers: message.providers, open: message.open ? true : state.auth.open },
			};
		case "profiles": {
			const { type: _type, seq: _seq, open, profiles, active, ...rest } = message;
			const next = { ...state.profiles, ...rest, list: profiles };
			if (active === undefined) delete next.active;
			else next.active = active;
			const updated = { ...state, profiles: next };
			return open ? openProfiles(updated, true) : updated;
		}
		case "profiles_imported":
			return {
				...state,
				profiles: {
					...state.profiles,
					lastImport: { imported: message.imported, missingProviders: message.missingProviders },
				},
			};
		case "auth_event":
			return updateFlow(state, message.flowId, (f) => ({ ...f, events: [...f.events, message.event] }));
		case "auth_prompt":
			return updateFlow(state, message.prompt.flowId, (f) => ({ ...f, prompt: message.prompt }));
		case "auth_done":
			return updateFlow(state, message.flowId, (f) => {
				const { prompt: _prompt, ...rest } = f;
				return {
					...rest,
					done: message.message ? { ok: message.ok, message: message.message } : { ok: message.ok },
				};
			});
		case "toast":
			return addNotice(state, message.level, message.message);
		case "error":
			return addNotice(state, "error", message.message);
	}
}

/** Profiles and accounts share the screen: opening one closes the other. */
function openProfiles(state: DotState, open: boolean): DotState {
	const { lastImport: _lastImport, ...rest } = state.profiles;
	return {
		...state,
		auth: open ? { ...state.auth, open: false } : state.auth,
		profiles: open ? { ...state.profiles, open } : { ...rest, open },
	};
}

function closeProfiles(state: DotState, when: boolean): DotState {
	return when && state.profiles.open ? openProfiles(state, false) : state;
}

function updateFlow(state: DotState, flowId: string, update: (f: AuthFlowState) => AuthFlowState): DotState {
	const flow = state.auth.flow;
	if (!flow || (flow.flowId && flow.flowId !== flowId)) return state;
	return { ...state, auth: { ...state.auth, flow: update({ ...flow, flowId }) } };
}

/** True once providers are known and none has a working credential. */
export function needsAccount(state: DotState): boolean {
	return state.auth.providers !== undefined && !state.auth.providers.some((p) => p.configured);
}

function updateAssistant(state: DotState, id: string, update: (m: ChatMessage) => ChatMessage): DotState {
	const index = state.messages.findIndex((m) => m.id === id);
	if (index < 0) {
		const created: ChatMessage = { id, role: "assistant", text: "", streaming: false, activities: [] };
		return { ...state, messages: [...state.messages, update(created)] };
	}
	return { ...state, messages: state.messages.map((m, i) => (i === index ? update(m) : m)) };
}

function addNotice(state: DotState, level: Notice["level"], message: string): DotState {
	if (!message) return state;
	return { ...state, notices: [...state.notices.slice(-4), { id: ++nextNotice, level, message }] };
}

function stopStreaming(message: ChatMessage): ChatMessage {
	return message.streaming ? { ...message, streaming: false } : message;
}

/** Conversation title for the header. */
export function activeTitle(state: DotState): string {
	return state.conversations.find((c) => c.id === state.conversationId)?.title ?? "New conversation";
}

export function isBusy(state: AgentState): boolean {
	return state === "thinking" || state === "working" || state === "needs_you";
}
