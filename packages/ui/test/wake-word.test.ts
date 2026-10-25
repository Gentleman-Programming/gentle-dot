import { describe, expect, it, vi } from "vitest";

/**
 * The desktop voice bridge (S30.1, S30.7): the events the panel listens to, including the two the
 * wake word adds — a note nobody asked for and its automatic transcript.
 */
const h = vi.hoisted(() => ({
	handlers: new Map<string, (event: { payload?: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload?: unknown }) => void) => {
		h.handlers.set(name, handler);
		return () => h.handlers.delete(name);
	},
}));

const { onNativeVoice } = await import("../src/voice-native.ts");

describe("the native voice events", () => {
	it("reports the wake word's own note and its transcript", async () => {
		const started = vi.fn();
		const transcript = vi.fn();
		const partial = vi.fn();
		const stop = await onNativeVoice({ partial, level: () => {}, error: () => {}, started, transcript });

		h.handlers.get("voice://started")?.({});
		h.handlers.get("voice://transcript")?.({ payload: { text: "comprar pan" } });
		h.handlers.get("voice://partial")?.({ payload: { text: "comprar" } });

		expect(started).toHaveBeenCalledOnce();
		expect(transcript).toHaveBeenCalledWith("comprar pan");
		expect(partial).toHaveBeenCalledWith("comprar");
		stop();
		expect(h.handlers.size).toBe(0);
	});

	it("ignores a transcript without text and a panel that asked for neither event", async () => {
		const partial = vi.fn();
		await onNativeVoice({ partial, level: () => {}, error: () => {} });

		expect(() => h.handlers.get("voice://started")?.({})).not.toThrow();
		expect(() => h.handlers.get("voice://transcript")?.({ payload: {} })).not.toThrow();
		expect(partial).not.toHaveBeenCalled();
	});
});
