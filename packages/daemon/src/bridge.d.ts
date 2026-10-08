import type { AgentState, ClientMessage, ServerPayload } from "@gentle-dot/protocol";
import type { AgentSupervisor } from "./supervisor.ts";
export interface BridgeClient {
	send(payload: ServerPayload): void;
}
export interface BridgeOptions {
	dataDir: string;
	log?: (line: string) => void;
}
/**
 * Translates between protocol v1 clients and the supervised agent: it keeps
 * the derived agent state, the pending asks, and the streaming message ids,
 * and broadcasts every agent event to all connected clients.
 */
export declare class DotBridge {
	private readonly clients;
	private readonly asks;
	private readonly runningTools;
	private readonly seenRequestIds;
	private readonly sessionDir;
	private readonly supervisor;
	private readonly options;
	private state;
	private interrupted;
	private nextMessage;
	private assistantId;
	constructor(supervisor: AgentSupervisor, options: BridgeOptions);
	get agentState(): AgentState;
	attach(client: BridgeClient): () => void;
	handle(client: BridgeClient, message: ClientMessage): Promise<void>;
	private dispatch;
	private afterConversationChange;
	private loadHistory;
	private conversationsPayload;
	private conversationRef;
	private activeRef;
	private onAgentEvent;
	private onMessageStart;
	private onMessageUpdate;
	private onMessageEnd;
	private onTool;
	private onUiRequest;
	private resolveAsk;
	private clearRun;
	private deriveState;
	private refreshState;
	private alreadySeen;
	private broadcast;
	private deliver;
	private log;
}
