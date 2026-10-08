import { join } from "node:path";
import {
	type AgentState,
	type Ask,
	type ClientMessage,
	type Features,
	isThinkingLevel,
	type MessageQueue,
	parseQueue,
	type RoleRoute,
	type ServerPayload,
} from "@gentle-dot/protocol";
import type { AuthManager } from "./auth.ts";
import type { ConnectorManager, ConnectorRefusal } from "./connectors.ts";
import {
	conversationIdOf,
	type HistoryPage,
	listConversations,
	pageHistory,
	resolveConversation,
} from "./conversations.ts";
import { DRAFT_STATUS_KEY } from "./extensions/approval-guard.ts";
import { describeTool, textOf } from "./presentation.ts";
import {
	LiveModelSwitch,
	ProfileError,
	type ProfileStore,
	type SwitchOutcome,
	toModelOptions,
} from "./profiles.ts";
import { DEFAULT_ROTATION, type RotationLimits, SessionRotator } from "./rotation.ts";
import type { AgentRecord, AgentSupervisor, SupervisorEvent } from "./supervisor.ts";
import { isBlockedInput, presentText, shouldShowToast } from "./white-label.ts";

export interface BridgeClient {
	send(payload: ServerPayload): void;
}

export interface BridgeOptions {
	dataDir: string;
	log?: (line: string) => void;
	auth?: AuthManager;
	profiles?: ProfileStore;
	connectors?: ConnectorManager;
	/** How long switching conversations waits for a running answer to stop. Default 10 s. */
	stopTimeoutMs?: number;
	/** Optional parts of the app; by default one continuous chat. */
	features?: Features;
	/** When the open session is replaced by a fresh one (docs/design.md §7). */
	rotation?: RotationLimits;
	/** How many messages `history` and each `get_earlier` page carry. Default 100. */
	historyPage?: number;
}

type ProfileCommand = Extract<
	ClientMessage,
	{
		type:
			| "profile_save"
			| "profile_rename"
			| "profile_duplicate"
			| "profile_delete"
			| "profile_apply"
			| "profile_import"
			| "profile_save_current";
	}
>;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** An open dialog; `options` keeps the agent's original option strings for the answer. */
type PendingAsk = { ask: Ask; options?: string[]; timer?: NodeJS.Timeout };
const REMEMBERED_REQUEST_IDS = 500;
const READY_TIMEOUT_MS = 60_000;
const ANSWER_FAILED = "Something went wrong while answering. Please try again.";
const HISTORY_PAGE = 100;

/**
 * Translates between protocol v1 clients and the supervised agent: it keeps
 * the derived agent state, the pending asks, and the streaming message ids,
 * and broadcasts every agent event to all connected clients.
 */
export class DotBridge {
	private readonly clients = new Set<BridgeClient>();
	private readonly asks = new Map<string, PendingAsk>();
	private readonly runningTools = new Set<string>();
	private readonly seenRequestIds: string[] = [];
	private readonly sessionDir: string;
	private readonly supervisor: AgentSupervisor;
	private readonly options: BridgeOptions;
	private state: AgentState = "starting";
	private interrupted = false;
	private nextMessage = 0;
	private assistantId: string | undefined;
	private restartPending = false;
	private restarting = false;
	private restartAgain = false;
	/** The running answer is being stopped on purpose, so its end is not an error. */
	private stopRequested = false;
	/** The conversation switch in progress; messages sent meanwhile wait for it. */
	private switching: Promise<void> = Promise.resolve();
	/** Messages waiting for the agent, as shown to the user. */
	private queue: MessageQueue = { steering: [], followUp: [] };
	/** Messages on their way to the agent; the session is never rotated under them. */
	private sending = 0;
	/** A run settled while a message was still on its way; check for rotation once it arrived. */
	private rotationDeferred = false;
	private readonly features: Features;
	private readonly rotator: SessionRotator;
	private readonly liveSwitch: LiveModelSwitch;

	constructor(supervisor: AgentSupervisor, options: BridgeOptions) {
		this.supervisor = supervisor;
		this.options = options;
		this.liveSwitch = new LiveModelSwitch(supervisor, (line) => this.log(line));
		this.sessionDir = join(options.dataDir, "sessions");
		this.features = options.features ?? { conversations: false };
		this.rotator = new SessionRotator(supervisor, {
			limits: options.rotation ?? DEFAULT_ROTATION,
			canRotate: () =>
				supervisor.state === "ready" && !supervisor.busy && this.asks.size === 0 && this.sending === 0,
			log: (line) => this.log(line),
		});
		supervisor.onEvent((event) => this.onAgentEvent(event));
		if (options.auth) options.auth.onCredentialsChanged = () => this.afterCredentialsChange();
		if (options.connectors) {
			options.connectors.onChanged = (restart) => this.afterConnectorsChange(restart);
			options.connectors.onBlocked = () => this.connectorChangeBlocked();
			options.connectors.imagesSupported = () => supervisor.modelImages;
		}
		this.state = this.deriveState();
	}

	get agentState(): AgentState {
		return this.state;
	}

	attach(client: BridgeClient): () => void {
		this.clients.add(client);
		this.deliver(client, {
			type: "ready",
			agentState: this.state,
			...this.conversationRef(),
			...(this.supervisor.model ? { model: this.supervisor.model } : {}),
			features: this.features,
		});
		if (this.queued()) this.deliver(client, { type: "queue", ...this.queue });
		for (const { ask } of this.asks.values()) this.deliver(client, { type: "ask", ask });
		for (const draft of this.options.connectors?.drafts() ?? [])
			this.deliver(client, { type: "connector_draft", draft });
		if (this.interrupted) this.deliver(client, { type: "interrupted" });
		return () => {
			this.clients.delete(client);
			this.options.auth?.cancelOwnedBy(client);
			this.options.connectors?.cancelOwnedBy(client);
			this.options.connectors?.unregisterComputer(client);
		};
	}

	async handle(client: BridgeClient, message: ClientMessage): Promise<void> {
		try {
			await this.dispatch(client, message);
		} catch (error) {
			this.log(`command ${message.type} failed: ${(error as Error).message}`);
			if (this.supervisor.state !== "ready") {
				this.deliver(client, {
					type: "error",
					code: "agent_unavailable",
					message: "The assistant is restarting. Try again in a moment.",
				});
			} else if (message.type === "send" && !(await this.hasAccount())) {
				this.deliver(client, {
					type: "error",
					code: "no_account",
					message: "Connect an AI account first: open Accounts or type /login.",
				});
			} else {
				this.deliver(client, {
					type: "error",
					code: "command_failed",
					message: "That did not work. Please try again.",
				});
			}
		}
	}

	/** True when an account is connected, or when that cannot be told. */
	private async hasAccount(): Promise<boolean> {
		if (!this.options.auth) return true;
		return this.options.auth.hasAccount().catch(() => true);
	}

	private async dispatch(client: BridgeClient, message: ClientMessage): Promise<void> {
		switch (message.type) {
			case "hello":
				return;
			case "send": {
				if (isBlockedInput(message.text)) {
					this.deliver(client, {
						type: "error",
						code: "unsupported",
						message: "I can't run that command here.",
					});
					return;
				}
				if (message.requestId && this.alreadySeen(message.requestId)) return;
				if (/^\s*\/login\s*$/i.test(message.text)) {
					await this.sendProviders(client, true);
					return;
				}
				if (/^\s*\/profiles\s*$/i.test(message.text)) {
					await this.sendProfiles(client, true);
					return;
				}
				if (/^\s*\/connectors\s*$/i.test(message.text)) {
					this.deliver(client, {
						type: "connectors",
						connectors: this.requireConnectors().list(),
						open: true,
					});
					return;
				}
				await this.switching;
				this.interrupted = false;
				const busy = this.supervisor.busy;
				this.sending += 1;
				try {
					await this.supervisor.request(
						busy
							? { type: "prompt", message: message.text, streamingBehavior: "steer" }
							: { type: "prompt", message: message.text },
					);
				} finally {
					this.sending -= 1;
					// The run may have settled before the answer to this prompt was handled.
					if (this.sending === 0 && this.rotationDeferred) {
						this.rotationDeferred = false;
						if (!this.supervisor.busy) this.rotateWhenIdle();
					}
				}
				return;
			}
			case "steer":
				await this.supervisor.request({ type: "steer", message: message.text });
				return;
			case "abort":
				if (this.supervisor.busy) this.stopRequested = true;
				await this.supervisor.request({ type: "abort" });
				return;
			case "ui_response": {
				const pending = this.asks.get(message.requestId);
				if (!pending) {
					this.deliver(client, {
						type: "error",
						code: "ask_not_found",
						message: "That question is no longer open.",
					});
					return;
				}
				const { requestId } = message;
				const answer: Record<string, unknown> = {};
				if (message.cancelled) answer.cancelled = true;
				else if (message.confirmed !== undefined) answer.confirmed = message.confirmed;
				else if (message.value !== undefined) {
					// Options are shown rewritten; answer with the agent's original string.
					const index = pending.ask.options?.indexOf(message.value) ?? -1;
					answer.value = index >= 0 ? (pending.options?.[index] ?? message.value) : message.value;
				}
				this.supervisor.send({ type: "extension_ui_response", id: requestId, ...answer });
				this.resolveAsk(requestId);
				return;
			}
			case "new_conversation":
				if (!this.conversationsOn(client)) return;
				await this.changeConversation(async () => {
					await this.switchAfterStop(() => this.supervisor.request({ type: "new_session" }));
					this.afterConversationChange();
				});
				return;
			case "list_conversations":
				this.deliver(client, this.conversationsPayload());
				return;
			case "open_conversation": {
				if (!this.conversationsOn(client)) return;
				const path = resolveConversation(this.sessionDir, message.conversationId);
				if (!path) {
					this.deliver(client, {
						type: "error",
						code: "conversation_not_found",
						message: "That conversation does not exist.",
					});
					return;
				}
				await this.changeConversation(async () => {
					await this.switchAfterStop(() =>
						this.supervisor.request({ type: "switch_session", sessionPath: path }),
					);
					this.afterConversationChange(await this.currentHistory());
				});
				return;
			}
			case "auth_list":
				await this.sendProviders(client);
				return;
			case "auth_login": {
				const refused = this.requireAuth().start(client, message.providerId, message.method, (payload) =>
					this.deliver(client, payload),
				);
				if (refused) this.deliver(client, { type: "error", ...refused });
				return;
			}
			case "auth_reply":
				if (
					this.options.connectors?.owns(message.flowId)
						? !this.options.connectors.reply(client, message.flowId, message)
						: !this.requireAuth().reply(client, message.flowId, message)
				) {
					this.deliver(client, {
						type: "error",
						code: "auth_flow_not_found",
						message: "That sign-in is no longer active.",
					});
				}
				return;
			case "auth_logout": {
				const refused = await this.requireAuth().logout(message.providerId);
				if (refused) this.deliver(client, { type: "error", ...refused });
				return;
			}
			case "profiles_list":
				await this.sendProfiles(client);
				return;
			case "connectors_list":
				this.deliver(client, { type: "connectors", connectors: this.requireConnectors().list() });
				return;
			case "connector_connect":
			case "connector_signin":
			case "connector_setup":
			case "connector_disconnect":
			case "connector_mode":
			case "connector_remove":
				await this.connectorCommand(client, message);
				return;
			case "connector_draft_reply": {
				const emit = (payload: ServerPayload) => this.deliver(client, payload);
				const { draftId, approve } = message;
				const refused = this.requireConnectors().decideDraft(client, draftId, approve, emit);
				if (refused) this.deliver(client, { type: "error", ...refused });
				else this.broadcast({ type: "connector_draft_resolved", draftId, approved: approve });
				return;
			}
			case "connectors_scan":
				this.deliver(client, { type: "connector_imports", found: this.requireConnectors().scan() });
				return;
			case "computer_register":
				this.requireConnectors().registerComputer(client, { url: message.url, token: message.token });
				return;
			case "computer_unregister":
				this.requireConnectors().unregisterComputer(client);
				return;
			case "connector_import":
				this.deliver(client, {
					type: "connector_imported",
					names: this.requireConnectors().importServers(message.ids),
				});
				return;
			case "profile_save":
			case "profile_rename":
			case "profile_duplicate":
			case "profile_delete":
			case "profile_apply":
			case "profile_import":
			case "profile_save_current":
				await this.profileCommand(client, message);
				return;
			case "get_history":
				// Windows ask for history as soon as they connect, often while the agent starts.
				await this.whenReady();
				this.deliver(client, {
					type: "history",
					...this.conversationRef(),
					...(await this.currentHistory()),
				});
				return;
			case "get_earlier":
				this.deliver(client, {
					type: "earlier",
					before: message.before,
					...pageHistory(this.chain(), this.pageSize(), message.before),
				});
				return;
		}
	}

	/** With the conversations list off there is one chat; starting or opening another is refused. */
	private conversationsOn(client: BridgeClient): boolean {
		if (this.features.conversations) return true;
		this.deliver(client, {
			type: "error",
			code: "conversations_off",
			message: "This assistant keeps one continuous chat.",
		});
		return false;
	}

	/** Runs a conversation switch; a message sent meanwhile goes to the new conversation, after its history. */
	private changeConversation(change: () => Promise<void>): Promise<void> {
		const run = change();
		this.switching = run.catch(() => {});
		return run;
	}

	/**
	 * The engine aborts a running answer when it switches sessions, and its end
	 * would land in the new conversation. Stop it first and wait (bounded) for
	 * the run to settle, then switch; that stop is intentional, not an error.
	 */
	private async switchAfterStop(switchTo: () => Promise<unknown>): Promise<void> {
		if (!this.supervisor.busy) {
			await switchTo();
			return;
		}
		this.stopRequested = true;
		try {
			const settled = this.nextSettle(this.options.stopTimeoutMs ?? 10_000);
			await this.supervisor.request({ type: "abort" });
			if (!(await settled)) this.log("the running answer did not stop in time; switching anyway");
			await switchTo();
		} finally {
			this.stopRequested = false;
		}
	}

	/** Resolves true when the run settles or the agent goes away, false after `timeoutMs`. */
	private nextSettle(timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const finish = (settled: boolean) => {
				clearTimeout(timer);
				off();
				resolve(settled);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			const off = this.supervisor.onEvent((event) => {
				if (event.type === "agent_settled") finish(true);
				else if (event.type === "supervisor_state" && event.state !== "ready") finish(true);
			});
		});
	}

	/** Waits until the agent can take commands; gives up after a minute or when it stopped. */
	private whenReady(): Promise<void> {
		if (this.supervisor.state === "ready") return Promise.resolve();
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				off();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => finish(new Error("the agent did not start in time")), READY_TIMEOUT_MS);
			timer.unref();
			const off = this.supervisor.onEvent((event) => {
				if (event.type !== "supervisor_state") return;
				if (event.state === "ready") finish();
				else if (event.state === "stopped") finish(new Error("the agent stopped"));
			});
		});
	}

	private requireAuth(): AuthManager {
		if (!this.options.auth) throw new Error("sign-in is not available");
		return this.options.auth;
	}

	private async sendProviders(client: BridgeClient, open = false): Promise<void> {
		const providers = await this.requireAuth().providers();
		this.deliver(client, { type: "auth_providers", providers, ...(open ? { open: true } : {}) });
	}

	private requireConnectors(): ConnectorManager {
		if (!this.options.connectors) throw new Error("connectors are not available");
		return this.options.connectors;
	}

	/** Runs one connector change; a sign-in's steps go only to the window that started it. */
	private async connectorCommand(
		client: BridgeClient,
		message: Extract<ClientMessage, { connectorId: string }>,
	): Promise<void> {
		const connectors = this.requireConnectors();
		const emit = (payload: ServerPayload) => this.deliver(client, payload);
		let refused: ConnectorRefusal | undefined;
		switch (message.type) {
			case "connector_connect":
				refused = connectors.connect(client, message.connectorId, emit);
				break;
			case "connector_signin":
				refused = connectors.signIn(client, message.connectorId, emit);
				break;
			case "connector_setup":
				refused = connectors.setup(client, message.connectorId, emit);
				break;
			case "connector_disconnect":
				refused = connectors.disconnect(message.connectorId);
				break;
			case "connector_mode":
				refused = connectors.setMode(message.connectorId, message.mode);
				break;
			case "connector_remove":
				refused = await connectors.remove(message.connectorId);
				break;
		}
		if (refused) this.deliver(client, { type: "error", ...refused });
	}

	/**
	 * A connector the assistant drafted with `propose_connector`. It reaches the daemon on the
	 * engine's own output, and every window shows it as a card; nothing changes until the user answers.
	 */
	private onConnectorDraft(text: unknown): void {
		const draft = typeof text === "string" ? this.options.connectors?.propose(text) : undefined;
		if (!draft) {
			this.log("ignored a malformed connector draft");
			return;
		}
		this.log(`the assistant drafted a connector: ${draft.name}`);
		this.broadcast({ type: "connector_draft", draft });
	}

	/** The connector files were changed outside the Connectors screen and put back. */
	private connectorChangeBlocked(): void {
		this.broadcast({ type: "toast", level: "warning", message: "A change to your connectors was blocked." });
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
	}

	/** Every window sees the new statuses; a new mcp.json needs an agent restart, once it is idle. */
	private afterConnectorsChange(restart: boolean): void {
		this.broadcast({ type: "connectors", connectors: this.requireConnectors().list() });
		if (!restart) return;
		if (this.supervisor.busy) this.restartPending = true;
		else this.restartAgent();
	}

	private requireProfiles(): ProfileStore {
		if (!this.options.profiles) throw new Error("profiles are not available");
		return this.options.profiles;
	}

	private async sendProfiles(client: BridgeClient, open = false): Promise<void> {
		try {
			this.deliver(client, { ...(await this.profilesPayload()), ...(open ? { open: true } : {}) });
		} catch (error) {
			if (!(error instanceof ProfileError)) throw error;
			this.deliver(client, { type: "error", code: error.code, message: error.message });
		}
	}

	private async profilesPayload(): Promise<Extract<ServerPayload, { type: "profiles" }>> {
		const store = this.requireProfiles();
		const { profiles, active } = store.list();
		const models = await this.supervisor.request({ type: "get_available_models" }).then(
			(response) => toModelOptions(response.data),
			() => [],
		);
		return {
			type: "profiles",
			profiles,
			...(active ? { active } : {}),
			roles: store.roles(),
			models,
			importable: store.importable(),
		};
	}

	/** Runs one profile change; every window gets the new list, errors go to the window that asked. */
	private async profileCommand(client: BridgeClient, message: ProfileCommand): Promise<void> {
		const store = this.requireProfiles();
		try {
			switch (message.type) {
				case "profile_save":
					await store.save(message.name, message.roles);
					// Editing the profile in use takes effect right away.
					if (store.list().active === message.name) await this.applyProfile(message.name);
					break;
				case "profile_rename":
					await store.rename(message.from, message.to);
					break;
				case "profile_duplicate":
					await store.duplicate(message.from, message.to);
					break;
				case "profile_delete":
					await store.remove(message.name);
					break;
				case "profile_apply":
					await this.applyProfile(message.name);
					break;
				case "profile_save_current":
					await store.saveCurrent(message.name, await this.runningRoute());
					break;
				case "profile_import": {
					const providers = await (this.options.auth?.providers() ?? Promise.resolve([])).catch(() => []);
					this.deliver(client, { type: "profiles_imported", ...(await store.import(providers)) });
					break;
				}
			}
		} catch (error) {
			if (!(error instanceof ProfileError)) throw error;
			this.deliver(client, { type: "error", code: error.code, message: error.message });
			return;
		}
		this.broadcast(await this.profilesPayload());
	}

	private async applyProfile(name: string): Promise<void> {
		const orchestrator = await this.requireProfiles().apply(name);
		if (orchestrator) this.reportSwitch(await this.liveSwitch.switchTo(orchestrator));
	}

	private reportSwitch(outcome: SwitchOutcome): void {
		if (outcome !== "failed") return;
		this.broadcast({
			type: "toast",
			level: "warning",
			message:
				"Profile applied. The main assistant keeps its current model until that model's account is connected.",
		});
	}

	/** The main assistant's model and thinking level in the running conversation. */
	private async runningRoute(): Promise<RoleRoute | undefined> {
		const response = await this.supervisor.request({ type: "get_state" });
		const state = response.data as { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown };
		if (typeof state?.model?.provider !== "string" || typeof state.model.id !== "string") return undefined;
		const route: RoleRoute = { model: `${state.model.provider}/${state.model.id}` };
		if (isThinkingLevel(state.thinkingLevel)) route.thinking = state.thinkingLevel;
		return route;
	}

	/** New credentials: refresh every window, and restart the agent once it is idle so it sees new models. */
	private afterCredentialsChange(): void {
		void this.requireAuth()
			.providers()
			.then((providers) => this.broadcast({ type: "auth_providers", providers }))
			.catch((error: Error) => this.log(`could not list providers: ${error.message}`));
		if (this.supervisor.busy) {
			this.restartPending = true;
			return;
		}
		this.restartAgent();
	}

	/** Restarts the engine; changes that arrive during a restart get one more, so the last one is read. */
	private restartAgent(): void {
		this.restartPending = false;
		if (this.restarting) {
			this.restartAgain = true;
			return;
		}
		this.restarting = true;
		this.supervisor
			.restart()
			.catch((error: Error) => this.log(`agent restart failed: ${error.message}`))
			.finally(() => {
				this.restarting = false;
				if (!this.restartAgain) return;
				this.restartAgain = false;
				this.restartAgent();
			});
	}

	/** A profile applied while the assistant was busy switches the model now. */
	private settleModelSwitch(): void {
		void this.liveSwitch.settle().then((outcome) => this.reportSwitch(outcome));
	}

	private afterConversationChange(page: HistoryPage = { messages: [], hasEarlier: false }): void {
		this.interrupted = false;
		this.assistantId = undefined;
		this.broadcast({ type: "history", ...this.conversationRef(), ...page });
		this.broadcast(this.conversationsPayload());
	}

	/** After a run settles, replace an oversized session; every window gets the same chat, now marked earlier. */
	private rotateWhenIdle(): void {
		void this.changeConversation(async () => {
			if (!(await this.rotator.maybeRotate())) return;
			this.broadcast({ type: "history", ...this.conversationRef(), ...(await this.currentHistory()) });
		});
	}

	/**
	 * History replaces what a window shows, so it must not be older than the
	 * messages already sent: read it again when one arrived while loading.
	 */
	private async currentHistory(): Promise<HistoryPage> {
		for (let attempt = 0; ; attempt++) {
			const seen = this.nextMessage;
			// The engine writes a message to its session file right after announcing it;
			// one round trip makes sure everything announced so far is on disk.
			await this.supervisor.request({ type: "get_state" });
			const page = pageHistory(this.chain(), this.pageSize());
			if (this.nextMessage === seen || attempt >= 2) return page;
		}
	}

	/** The open chat's session files, oldest first. */
	private chain(): string[] {
		const file = this.supervisor.sessionFile;
		return file ? [...this.supervisor.previousSessions, file] : [];
	}

	private pageSize(): number {
		return this.options.historyPage ?? HISTORY_PAGE;
	}

	private conversationsPayload(): ServerPayload {
		return { type: "conversations", conversations: listConversations(this.sessionDir), ...this.activeRef() };
	}

	private conversationRef(): { conversationId?: string } {
		const file = this.supervisor.sessionFile;
		return file ? { conversationId: conversationIdOf(this.sessionDir, file) } : {};
	}

	private activeRef(): { activeId?: string } {
		const ref = this.conversationRef();
		return ref.conversationId ? { activeId: ref.conversationId } : {};
	}

	private onAgentEvent(event: SupervisorEvent): void {
		switch (event.type) {
			case "supervisor_state":
				if (event.state !== "ready") {
					this.stopRequested = false;
					this.clearRun();
					this.clearQueue();
				} else this.settleModelSwitch();
				break;
			case "interrupted":
				this.interrupted = true;
				this.broadcast({ type: "interrupted" });
				break;
			case "message_start":
				this.onMessageStart(event);
				break;
			case "message_update":
				this.onMessageUpdate(event);
				break;
			case "message_end":
				this.onMessageEnd(event);
				break;
			case "tool_execution_start":
			case "tool_execution_end":
				this.onTool(event);
				break;
			case "queue_update":
				this.onQueueUpdate(event);
				break;
			case "agent_settled":
				// The run may have changed the connector files.
				this.options.connectors?.enforce();
				this.runningTools.clear();
				this.assistantId = undefined;
				this.stopRequested = false;
				// Anything still queued will not be taken by this run.
				this.clearQueue();
				// The title of a new conversation comes from its first message.
				this.broadcast(this.conversationsPayload());
				this.settleModelSwitch();
				if (this.restartPending) this.restartAgent();
				else if (this.sending > 0) this.rotationDeferred = true;
				else this.rotateWhenIdle();
				break;
			case "extension_ui_request":
				this.onUiRequest(event);
				break;
		}
		this.refreshState();
	}

	/** The engine sends both complete queues on every change. */
	private onQueueUpdate(event: AgentRecord): void {
		const queue = parseQueue(event);
		if (!queue) return;
		this.queue = { steering: queue.steering.map(presentText), followUp: queue.followUp.map(presentText) };
		this.broadcast({ type: "queue", ...this.queue });
	}

	private queued(): boolean {
		return this.queue.steering.length > 0 || this.queue.followUp.length > 0;
	}

	private clearQueue(): void {
		if (!this.queued()) return;
		this.queue = { steering: [], followUp: [] };
		this.broadcast({ type: "queue", ...this.queue });
	}

	private onMessageStart(event: AgentRecord): void {
		const message = event.message as { role?: string } | undefined;
		if (message?.role === "user") {
			this.broadcast({ type: "user_message", messageId: `u${++this.nextMessage}`, text: textOf(message) });
		}
		if (message?.role === "assistant") this.assistantId = `m${++this.nextMessage}`;
	}

	private onMessageUpdate(event: AgentRecord): void {
		const update = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
		if (update?.type !== "text_delta" || typeof update.delta !== "string") return;
		this.assistantId ??= `m${++this.nextMessage}`;
		this.broadcast({ type: "message_delta", messageId: this.assistantId, delta: update.delta });
	}

	private onMessageEnd(event: AgentRecord): void {
		const message = event.message as
			| { role?: string; stopReason?: string; errorMessage?: string }
			| undefined;
		if (message?.role !== "assistant") return;
		const messageId = this.assistantId ?? `m${++this.nextMessage}`;
		const text = presentText(textOf(message));
		// The engine ends a stopped answer as "aborted", or as an error when a session switch tore it down.
		if (message.stopReason === "aborted" || (message.stopReason === "error" && this.stopRequested)) {
			this.broadcast({ type: "message_done", messageId, text, stopped: true });
		} else if (message.stopReason === "error") {
			this.log(`assistant error: ${message.errorMessage ?? "unknown"}`);
			this.broadcast({ type: "message_done", messageId, text, error: ANSWER_FAILED });
		} else {
			this.broadcast({ type: "message_done", messageId, text });
		}
	}

	private onTool(event: AgentRecord): void {
		const id = String(event.toolCallId ?? "");
		const started = event.type === "tool_execution_start";
		if (started) this.runningTools.add(id);
		else this.runningTools.delete(id);
		const status = started ? "running" : event.isError ? "failed" : "done";
		// Start and end of one tool call must land on the same message.
		this.assistantId ??= `m${++this.nextMessage}`;
		this.broadcast({
			type: "activity",
			messageId: this.assistantId,
			activity: { id, ...describeTool(String(event.toolName ?? ""), event.args), status },
		});
	}

	private onUiRequest(event: AgentRecord): void {
		const method = String(event.method ?? "");
		const requestId = String(event.id ?? "");
		if (method === "notify") {
			const level =
				event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
			if (shouldShowToast(level))
				this.broadcast({ type: "toast", level, message: presentText(String(event.message ?? "")) });
			return;
		}
		if (method === "setStatus" && event.statusKey === DRAFT_STATUS_KEY) {
			this.onConnectorDraft(event.statusText);
			return;
		}
		if (!DIALOG_METHODS.has(method) || !requestId) return;
		const ask: Ask = {
			requestId,
			method: method as Ask["method"],
			title: presentText(String(event.title ?? "")),
		};
		const entry: PendingAsk = { ask };
		if (typeof event.message === "string") ask.message = presentText(event.message);
		if (Array.isArray(event.options)) {
			entry.options = event.options.map(String);
			ask.options = entry.options.map(presentText);
		}
		if (typeof event.placeholder === "string") ask.placeholder = presentText(event.placeholder);
		if (typeof event.prefill === "string") ask.prefill = event.prefill;
		if (typeof event.timeout === "number" && event.timeout > 0) {
			ask.timeoutMs = event.timeout;
			// Pi resolves the dialog by itself when it times out; drop it here too.
			entry.timer = setTimeout(() => this.resolveAsk(requestId), event.timeout);
		}
		this.asks.set(requestId, entry);
		this.broadcast({ type: "ask", ask });
	}

	private resolveAsk(requestId: string): void {
		const entry = this.asks.get(requestId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.asks.delete(requestId);
		this.broadcast({ type: "ask_resolved", requestId });
		this.refreshState();
	}

	private clearRun(): void {
		for (const requestId of [...this.asks.keys()]) this.resolveAsk(requestId);
		this.runningTools.clear();
		this.assistantId = undefined;
	}

	private deriveState(): AgentState {
		switch (this.supervisor.state) {
			case "starting":
				return "starting";
			case "restarting":
				return "restarting";
			case "stopped":
				return "error";
		}
		if (this.asks.size > 0) return "needs_you";
		if (!this.supervisor.busy) return "idle";
		return this.runningTools.size > 0 ? "working" : "thinking";
	}

	private refreshState(): void {
		const next = this.deriveState();
		if (next === this.state) return;
		this.state = next;
		this.broadcast({ type: "agent_state", state: next });
	}

	private alreadySeen(requestId: string): boolean {
		if (this.seenRequestIds.includes(requestId)) return true;
		this.seenRequestIds.push(requestId);
		if (this.seenRequestIds.length > REMEMBERED_REQUEST_IDS) this.seenRequestIds.shift();
		return false;
	}

	private broadcast(payload: ServerPayload): void {
		for (const client of this.clients) this.deliver(client, payload);
	}

	private deliver(client: BridgeClient, payload: ServerPayload): void {
		client.send(payload);
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}
