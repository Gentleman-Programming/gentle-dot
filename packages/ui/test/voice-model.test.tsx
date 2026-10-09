import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "../src/components/ConnectorsPanel.tsx";
import { VoiceModelEntry } from "../src/components/VoiceModel.tsx";

const TOTAL = 487_170_055;

const h = vi.hoisted(() => ({
	status: {} as Record<string, unknown>,
	invoke: vi.fn(),
	listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => true,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
		h.listeners.set(name, handler);
		return () => h.listeners.delete(name);
	},
}));

const emit = (payload: unknown) =>
	act(async () => {
		h.listeners.get("voice://model")?.({ payload });
	});

beforeEach(() => {
	h.status = { installed: false, downloading: false, engine: "apple" };
	h.listeners.clear();
	h.invoke.mockReset();
	h.invoke.mockImplementation(async (command: string) => {
		if (command === "voice_model_status") return h.status;
		return undefined;
	});
});

afterEach(() => vi.clearAllMocks());

describe("local voice model (S30.5)", () => {
	it("downloads only when asked, showing the size and the progress", async () => {
		render(<VoiceModelEntry />);
		expect(await screen.findByText("Using: macOS speech")).toBeInTheDocument();
		expect(h.invoke).not.toHaveBeenCalledWith("voice_model_download", undefined);

		await userEvent.click(screen.getByRole("button", { name: "Download local voice model (487 MB)" }));
		expect(h.invoke).toHaveBeenCalledWith("voice_model_download", undefined);

		await emit({ state: "downloading", received: TOTAL / 4, total: TOTAL });
		expect(screen.getByRole("progressbar", { name: "Downloading the local voice model" })).toHaveAttribute(
			"value",
			"25",
		);
		expect(screen.getByText("Downloading… 25%")).toBeInTheDocument();

		await emit({ state: "verifying" });
		expect(screen.getByText("Checking and unpacking…")).toBeInTheDocument();
	});

	it("cancels a download", async () => {
		h.status = { installed: false, downloading: true, received: 10, total: TOTAL, engine: "apple" };
		render(<VoiceModelEntry />);
		await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		expect(h.invoke).toHaveBeenCalledWith("voice_model_cancel", undefined);
		h.status = { installed: false, downloading: false, engine: "apple" };
		await emit({ state: "failed", message: "The download was cancelled." });
		expect(screen.getByText("The download was cancelled.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Download local voice model (487 MB)" })).toBeInTheDocument();
	});

	it("uses the installed model and can remove it", async () => {
		h.status = { installed: true, bytes: 670_478_772, downloading: false, engine: "parakeet" };
		render(<VoiceModelEntry />);
		expect(await screen.findByText("Using: local model (Parakeet), works offline")).toBeInTheDocument();

		h.status = { installed: false, downloading: false, engine: "apple" };
		await userEvent.click(screen.getByRole("button", { name: "Remove local model (670 MB)" }));
		expect(h.invoke).toHaveBeenCalledWith("voice_model_remove", undefined);
		await emit({ state: "removed" });
		await waitFor(() => expect(screen.getByText("Using: macOS speech")).toBeInTheDocument());
	});

	it("shows a failed download's reason and offers the download again", async () => {
		render(<VoiceModelEntry />);
		await screen.findByText("Using: macOS speech");
		await emit({ state: "failed", message: "The download did not match its checksum." });
		expect(screen.getByRole("alert")).toHaveTextContent("The download did not match its checksum.");
		expect(screen.getByRole("button", { name: "Download local voice model (487 MB)" })).toBeInTheDocument();
	});

	it("appears in Connectors only when the desktop app offers it", () => {
		const props = {
			connectors: { open: true, list: [] },
			send: () => {},
			dispatch: () => {},
			openUrl: () => {},
		};
		const { unmount } = render(<ConnectorsPanel {...props} />);
		expect(screen.queryByText("Voice")).toBeNull();
		unmount();
		render(<ConnectorsPanel {...props} voiceModel />);
		expect(screen.getByText("Voice")).toBeInTheDocument();
	});
});
