// The web PIN on a server (S25.8): the page sets it on first use, and asks for it before a connector
// change or before allowing a sending action. Without server mode, the web page stays as it was.
import {
	APP_REQUIRED,
	type Ask,
	type ClientMessage,
	type ConnectorInfo,
	type ServerMessage,
	type ServerPayload,
} from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { AskCard } from "../src/components/AskCard.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

const PIN = "731942";

const notion: ConnectorInfo = {
	id: "notion",
	name: "Notion",
	reads: "Search and read your pages.",
	sends: "Create and edit pages, after you approve each one.",
	added: true,
	enabled: true,
	mode: "read_only",
	status: "connected",
};

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

const open = (pin?: { set: boolean; locked?: boolean }) =>
	apply(
		{ ...initialState, connection: "open" },
		{ type: "ready", agentState: "idle", ...(pin ? { pin } : {}) },
		{ type: "connectors", connectors: [notion], open: true },
	);

function Web({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	return <ChatSurface variant="web" state={state} send={send} dismiss={vi.fn()} dispatch={dispatch} />;
}

describe("PIN state", () => {
	it("follows the daemon: present only in server mode, updated when it changes", () => {
		expect(open().pin).toBeUndefined();
		let s = open({ set: false });
		expect(s.pin).toEqual({ set: false });
		s = apply(s, { type: "pin_status", pin: { set: true, locked: true } });
		expect(s.pin).toEqual({ set: true, locked: true });
	});
});

describe("connector changes in the web page", () => {
	it("stay locked with the reason when the server has no PIN mode", () => {
		render(<Web initial={open()} send={vi.fn()} />);
		expect(screen.getByText(APP_REQUIRED)).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Read and send" })).toBeDisabled();
	});

	it("create the PIN on first use, then send the change with it", async () => {
		const send = vi.fn();
		render(<Web initial={open({ set: false })} send={send} />);
		expect(screen.queryByText(APP_REQUIRED)).toBeNull();
		await userEvent.click(screen.getByRole("radio", { name: "Read and send" }));
		const dialog = screen.getByRole("dialog", { name: "Create a PIN" });
		await userEvent.type(within(dialog).getByLabelText("New PIN"), PIN);
		await userEvent.type(within(dialog).getByLabelText("Repeat the PIN"), "000000");
		await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
		expect(within(dialog).getByRole("alert")).toHaveTextContent("The two PINs are different.");
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pin_set" }));
		await userEvent.clear(within(dialog).getByLabelText("Repeat the PIN"));
		await userEvent.type(within(dialog).getByLabelText("Repeat the PIN"), PIN);
		await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
		expect(send.mock.calls.map(([m]) => m)).toEqual(
			expect.arrayContaining([
				{ type: "pin_set", pin: PIN },
				{
					type: "pin_command",
					pin: PIN,
					command: { type: "connector_mode", connectorId: "notion", mode: "read_write" },
				},
			]),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("ask for the PIN once it is set, and can be cancelled", async () => {
		const send = vi.fn();
		render(<Web initial={open({ set: true })} send={send} />);
		await userEvent.click(screen.getByRole("radio", { name: "Read and send" }));
		const dialog = screen.getByRole("dialog", { name: "Enter your PIN" });
		expect(within(dialog).getByText(/Switch Notion to read and send/)).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pin_command" }));
		await userEvent.click(screen.getByRole("radio", { name: "Read and send" }));
		await userEvent.type(screen.getByLabelText("PIN"), `${PIN}{Enter}`);
		expect(send).toHaveBeenCalledWith({
			type: "pin_command",
			pin: PIN,
			command: { type: "connector_mode", connectorId: "notion", mode: "read_write" },
		});
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "pin_set" }));
	});
});

describe("an approval in the web page", () => {
	const ask: Ask = {
		requestId: "pin-1",
		method: "pin",
		title: "Allow Notion to create pages?",
		message: "The assistant wants to create pages in Notion.\n\ntitle: Plan",
	};

	it("is allowed with the PIN and declined without one", async () => {
		const send = vi.fn();
		render(<AskCard ask={ask} send={send} pin={{ set: true }} />);
		expect(screen.getByText(/title: Plan/)).toBeInTheDocument();
		await userEvent.type(screen.getByLabelText("PIN"), PIN);
		await userEvent.click(screen.getByRole("button", { name: "Allow" }));
		expect(send).toHaveBeenCalledWith({ type: "pin_approve", requestId: "pin-1", pin: PIN });
		await userEvent.click(screen.getByRole("button", { name: "Deny" }));
		expect(send).toHaveBeenCalledWith({ type: "ui_response", requestId: "pin-1", confirmed: false });
	});

	it("creates the PIN first when there is none yet", async () => {
		const send = vi.fn();
		render(<AskCard ask={ask} send={send} pin={{ set: false }} />);
		await userEvent.type(screen.getByLabelText("New PIN"), PIN);
		await userEvent.type(screen.getByLabelText("Repeat the PIN"), PIN);
		await userEvent.click(screen.getByRole("button", { name: "Allow" }));
		expect(send.mock.calls.map(([m]) => m)).toEqual([
			{ type: "pin_set", pin: PIN },
			{ type: "pin_approve", requestId: "pin-1", pin: PIN },
		]);
	});
});
