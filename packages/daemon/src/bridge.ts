import { join } from "node:path";
import type { AgentState, Ask, ClientMessage, ServerPayload } from "@gentle-dot/protocol";
import {
	conversationIdOf,
	historyFromMessages,
	listConversations,
	resolveConversation,
} from "./conversations.ts";
import { describeTool, textOf } from "./presentation.ts";
import type { AgentRecord, AgentSupervisor, SupervisorEvent } from "./supervisor.ts";
import { isBlockedInput, presentText, shouldShowToast } from "./white-label.ts";

export interface BridgeClient {
	send(payload: ServerPayload): void;
}

export interface BridgeOptions {
	dataDir: string;
	log?: (line: string) => void;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** An open dialog; `options` keeps the agent's original option strings for the answer. */
type PendingAsk = { ask: Ask; options?: string[]; timer?: NodeJS.Timeout };
const REMEMBERED_REQUEST_IDS = 500;

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

	constructor(supervisor: AgentSupervisor, options: BridgeOptions) {
		this.supervisor = supervisor;
		this.options = options;
		this.sessionDir = join(options.dataDir, "sessions");
		supervisor.onEvent((event) => this.onAgentEvent(event));
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
		});
		for (const { ask } of this.asks.values()) this.deliver(client, { type: "ask", ask });
		if (this.interrupted) this.deliver(client, { type: "interrupted" });
		return () => this.clients.delete(client);
	}

	async handle(client: BridgeClient, message: ClientMessage): Promise<void> {
		try {
			await this.dispatch(client, message);
		} catch (error) {
			this.log(`command ${message.type} failed: ${(error as Error).message}`);
			const unavailable = this.supervisor.state !== "ready";
			this.deliver(client, {
				type: "error",
				code: unavailable ? "agent_unavailable" : "command_failed",
				message: unavailable
					? "The assistant is restarting. Try again in a moment."
					: "That did not work. Please try again.",
			});
		}
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
				this.interrupted = false;
				const busy = this.supervisor.busy;
				await this.supervisor.request(
					busy
						? { type: "prompt", message: message.text, streamingBehavior: "steer" }
						: { type: "prompt", message: message.text },
				);
				return;
			}
			case "steer":
				await this.supervisor.request({ type: "steer", message: message.text });
				return;
			case "abort":
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
				await this.supervisor.request({ type: "new_session" });
				this.afterConversationChange([]);
				return;
			case "list_conversations":
				this.deliver(client, this.conversationsPayload());
				return;
			case "open_conversation": {
				const path = resolveConversation(this.sessionDir, message.conversationId);
				if (!path) {
					this.deliver(client, {
						type: "error",
						code: "conversation_not_found",
						message: "That conversation does not exist.",
					});
					return;
				}
				await this.supervisor.request({ type: "switch_session", sessionPath: path });
				this.afterConversationChange(await this.loadHistory());
				return;
			}
			case "get_history":
				this.deliver(client, {
					type: "history",
					...this.conversationRef(),
					messages: historyFromMessages(await this.loadHistory()),
				});
				return;
		}
	}

	private afterConversationChange(messages: unknown[]): void {
		this.interrupted = false;
		this.assistantId = undefined;
		this.broadcast({ type: "history", ...this.conversationRef(), messages: historyFromMessages(messages) });
		this.broadcast(this.conversationsPayload());
	}

	private async loadHistory(): Promise<unknown[]> {
		const response = await this.supervisor.request({ type: "get_messages" });
		return (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];
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
				if (event.state !== "ready") this.clearRun();
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
			case "agent_settled":
				this.runningTools.clear();
				this.assistantId = undefined;
				break;
			case "extension_ui_request":
				this.onUiRequest(event);
				break;
		}
		this.refreshState();
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
		this.broadcast({ type: "message_done", messageId, text: presentText(textOf(message)) });
		if (message.stopReason === "error") {
			this.log(`assistant error: ${message.errorMessage ?? "unknown"}`);
			this.broadcast({ type: "toast", level: "error", message: "Something went wrong while answering." });
		}
	}

	private onTool(event: AgentRecord): void {
		const id = String(event.toolCallId ?? "");
		const started = event.type === "tool_execution_start";
		if (started) this.runningTools.add(id);
		else this.runningTools.delete(id);
		const status = started ? "running" : event.isError ? "failed" : "done";
		this.broadcast({
			type: "activity",
			messageId: this.assistantId ?? `m${++this.nextMessage}`,
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
