import type { ConversationSummary, HistoryMessage } from "@gentle-dot/protocol";
/** Session files under `sessionDir` (and one level of subfolders), newest first. */
export declare function listConversations(sessionDir: string): ConversationSummary[];
export declare function conversationIdOf(sessionDir: string, sessionFile: string): string;
/** Resolves a client-supplied id to a session file inside `sessionDir`, or undefined. */
export declare function resolveConversation(sessionDir: string, id: string): string | undefined;
/** Converts Pi `get_messages` output into display messages; consecutive assistant messages form one turn. */
export declare function historyFromMessages(messages: unknown[]): HistoryMessage[];
