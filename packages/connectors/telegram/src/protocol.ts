/**
 * The part of the Gentle Dot client <-> daemon protocol (v1) this bridge uses, copied from
 * gentle-dot `packages/protocol/src/index.ts` at commit 535e7f7. That package is unpublished
 * TypeScript source, so it cannot be imported from here. Messages the bridge does not use are left
 * out; unknown daemon messages are ignored.
 */
export const PROTOCOL_VERSION = 1;

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
	method: "select" | "confirm" | "input" | "editor" | "app" | "pin";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeoutMs?: number;
}

export interface VoiceCapability {
	transcribe: boolean;
	speak: boolean;
}

/** A file uploaded with `POST /upload`, waiting to be sent with a message. */
export interface AttachmentRef {
	/** The message folder the daemon gave the first file; later files of the message reuse it. */
	uploadId: string;
	/** The name the daemon stored the file under. */
	name: string;
}

/** The daemon's answer to `POST /upload`. */
export interface UploadedFile extends AttachmentRef {
	size: number;
	mime: string;
	/** Where the file is, relative to the assistant's workspace: `uploads/<uploadId>/<name>`. */
	path: string;
}

/** Longest base64 recording the daemon accepts in `voice_transcribe`. */
export const MAX_VOICE_AUDIO = 960_000;

export type ClientMessage =
	| { type: "hello"; token: string; protocol: number }
	/** `text` may be empty when files are attached. */
	| { type: "send"; text: string; requestId?: string; attachments?: AttachmentRef[] }
	| { type: "abort" }
	| { type: "ui_response"; requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean }
	| { type: "voice_transcribe"; requestId: string; mime: string; data: string };

export type ServerPayload =
	| { type: "ready"; agentState: AgentState; voice?: VoiceCapability }
	| { type: "agent_state"; state: AgentState }
	| { type: "message_delta"; messageId: string; delta: string }
	| { type: "message_done"; messageId: string; text: string; stopped?: true; error?: string }
	| { type: "activity"; messageId: string; activity: Activity }
	| { type: "ask"; ask: Ask }
	| { type: "ask_resolved"; requestId: string }
	| { type: "toast"; level: "info" | "warning" | "error"; message: string }
	| { type: "error"; code: string; message: string }
	| { type: "auth_providers"; voice?: VoiceCapability }
	| { type: "voice_transcript"; requestId: string; text: string }
	| { type: "voice_unavailable"; requestId: string; reason: string };

export type ServerMessage = ServerPayload & { seq: number };
