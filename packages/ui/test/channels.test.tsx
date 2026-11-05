// The Channels panel (WhatsApp, phase 1): states, wizard, masked privacy, honest preview.
import type { ChannelInfo, ClientMessage, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChannelsPanel, PAIR_PREVIEW } from "../src/components/ChannelsPanel.tsx";
import { type ChannelsState, type DotState, initialState, reduce } from "../src/store.ts";

const whatsapp = (overrides: Partial<ChannelInfo>): ChannelInfo => ({
	id: "whatsapp",
	name: "WhatsApp",
	provider: "baileys",
	status: "off",
	reachable: true,
	...overrides,
});

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

function renderPanel(channels: ChannelsState, appSend?: (message: ClientMessage) => boolean) {
	const send = vi.fn(() => true);
	const dispatch = vi.fn();
	render(
		<ChannelsPanel channels={channels} send={send} {...(appSend ? { appSend } : {})} dispatch={dispatch} />,
	);
	return { send, dispatch, appSend: appSend ?? vi.fn() };
}

const withList = (channel: ChannelInfo, more: Partial<ChannelsState> = {}): ChannelsState => ({
	...initialState.channels,
	list: [channel],
	...more,
});

describe("channels store slice", () => {
	it("stores the channels payload, the masked allowlist, the pair step and verify results", () => {
		const state = apply(
			initialState,
			{ type: "channels", channels: [whatsapp({ status: "connected", maskedNumber: "…5678" })] },
			{ type: "channel_allowlist", numbers: ["…5678"] },
			{ type: "channel_pair", status: { qr: "2@x", expiresInSec: 17, attempts: 1 } },
			{ type: "channel_verify_result", results: [{ masked: "…5678", ok: true }] },
		);
		expect(state.channels.list?.[0]?.status).toBe("connected");
		expect(state.channels.allowlist).toEqual(["…5678"]);
		expect(state.channels.pair).toEqual({ qr: "2@x", expiresInSec: 17, attempts: 1 });
		expect(state.channels.verify).toEqual([{ masked: "…5678", ok: true }]);
	});

	it("keeps channels and connectors as exclusive screens", () => {
		let state = reduce(initialState, { type: "channels", open: true });
		expect(state.channels.open).toBe(true);
		state = reduce(state, { type: "connectors", open: true });
		expect(state.connectors.open).toBe(true);
		expect(state.channels.open).toBe(false);
		state = reduce(state, { type: "channels", open: true });
		expect(state.connectors.open).toBe(false);
		expect(state.profiles.open).toBe(false);
	});
});

describe("channels panel", () => {
	it("shows Not running when the bridge did not answer", () => {
		renderPanel(withList(whatsapp({ reachable: false })));
		expect(screen.getByText("Not running")).toBeTruthy();
	});

	it("never renders a full number, only the masked one (S7)", () => {
		renderPanel(
			withList(
				whatsapp({ status: "connected", maskedNumber: "…5678", lastActivityAt: "2026-10-23T20:00:00.000Z" }),
				{ allowlist: ["…5678"] },
			),
		);
		expect(screen.getAllByText(/…5678/).length).toBeGreaterThan(0);
		expect(screen.queryByText("5491112345678")).toBeNull();
	});

	it("offers Baileys in the wizard and shows Meta Cloud API as coming soon (S2)", async () => {
		const user = userEvent.setup();
		renderPanel(withList(whatsapp({ status: "off" })));
		await user.click(screen.getByText("Set up"));
		expect(screen.getByText("Choose a provider")).toBeTruthy();
		expect(screen.getByText(/Meta Cloud API/)).toBeTruthy();
		expect(screen.getByText(/Coming soon/)).toBeTruthy();
		await user.click(screen.getByText(/Baileys/));
		expect(screen.getByText("Allowed numbers")).toBeTruthy();
	});

	it("adds a number by sending the typed full number (S3)", async () => {
		const user = userEvent.setup();
		const appSend = vi.fn(() => true);
		renderPanel(withList(whatsapp({ status: "off" }), { allowlist: ["…5678"] }), appSend);
		await user.click(screen.getByText("Set up"));
		await user.click(screen.getByText(/Baileys/));
		await user.type(screen.getByPlaceholderText("5491112345678"), "5491112345678");
		await user.click(screen.getByText("Add"));
		expect(appSend).toHaveBeenCalledWith({
			type: "channel_allowlist_change",
			action: "add",
			number: "5491112345678",
		});
	});

	it("shows the honest preview before pairing starts (S8) and then the QR with its countdown (S4)", async () => {
		const user = userEvent.setup();
		const appSend = vi.fn(() => true);
		renderPanel(
			withList(whatsapp({ status: "off" }), {
				pair: { qr: "2@pairing-payload", expiresInSec: 17, attempts: 2 },
			}),
			appSend,
		);
		await user.click(screen.getByText("Set up"));
		await user.click(screen.getByText(/Baileys/));
		expect(screen.getByText(PAIR_PREVIEW)).toBeTruthy();
		await user.click(screen.getByText("Start pairing"));
		expect(appSend).toHaveBeenCalledWith({ type: "channel_pair_start" });
		expect(await screen.findByAltText("WhatsApp pairing QR")).toBeTruthy();
		expect(screen.getByText(/17s/)).toBeTruthy();
		await user.click(screen.getByText("Regenerate"));
		expect(appSend).toHaveBeenCalledWith({ type: "channel_pair_regenerate" });
	});

	it("asks for confirmation before unpairing (S6)", async () => {
		const user = userEvent.setup();
		const appSend = vi.fn(() => true);
		renderPanel(withList(whatsapp({ status: "connected" })), appSend);
		await user.click(screen.getByText("Unpair…"));
		expect(appSend).not.toHaveBeenCalledWith({ type: "channel_unpair" });
		await user.click(screen.getByText("Yes, unpair"));
		expect(appSend).toHaveBeenCalledWith({ type: "channel_unpair" });
	});

	it("sends the live verification and reports masked results (S5)", async () => {
		const user = userEvent.setup();
		const appSend = vi.fn(() => true);
		renderPanel(
			withList(whatsapp({ status: "connected" }), { verify: [{ masked: "…5678", ok: true }] }),
			appSend,
		);
		await user.click(screen.getByText("Send test message"));
		expect(appSend).toHaveBeenCalledWith({ type: "channel_verify" });
		expect(screen.getByText(/…5678: delivered/)).toBeTruthy();
	});

	it("disables changes without the app or a PIN while the lists still show", () => {
		renderPanel(withList(whatsapp({ status: "off" })));
		expect(screen.getByText(/change channels/i)).toBeTruthy();
		expect(screen.queryByText("Start pairing")).toBeNull();
	});
});
