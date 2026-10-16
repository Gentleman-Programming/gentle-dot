/**
 * Type declarations for the optional @builderbot/bot dependency.
 *
 * BuilderBot (https://github.com/builderbot/builderbot) is licensed under the MIT License.
 * Copyright (c) 2022-present Jhonny Fernando.
 *
 * The WhatsApp bridge loads it with a dynamic `import()` at runtime, so the package
 * does not need to be installed for the daemon to build or run; without it the bridge
 * reports a warning and stays inert. These declarations make the dynamic import
 * type-check in both cases.
 */
declare module "@builderbot/bot" {
	export interface Message {
		from: string;
		body?: string;
		hasMedia: boolean;
		downloadMedia(): Promise<{ data: string; mimetype?: string; filename?: string } | null>;
	}
	export interface MessageMedia {
		data: string;
		mimetype?: string;
		filename?: string;
	}
	export class MemoryStorage {
		constructor();
	}
	export function createClient(options: { storage: unknown }): {
		on(event: string, handler: (...args: never[]) => void): void;
		initialize(): Promise<void>;
		close(): Promise<void>;
		sendMessage(chatId: string, text: string): Promise<unknown>;
		downloadMedia(msg: unknown): Promise<{ data: string; mimetype?: string; filename?: string } | null>;
	};
}

declare module "@builderbot/bot/dist/types" {
	export class MemoryStorage {
		constructor();
	}
}
