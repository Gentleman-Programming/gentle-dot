import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ClientMessage, ConnectorInfo, ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { AskCard } from "../src/components/AskCard.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { ConnectorsPanel } from "../src/components/ConnectorsPanel.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

const connector = (overrides: Partial<ConnectorInfo>): ConnectorInfo => ({
	id: "notion",
	name: "Notion",
	reads: "Search and read your pages.",
	sends: "Create and edit pages, after you approve each one.",
	added: false,
	enabled: false,
	mode: "read_only",
	status: "off",
	...overrides,
});

const list: ConnectorInfo[] = [
	connector({ added: true, enabled: true, status: "connected" }),
	connector({
		id: "linear",
		name: "Linear",
		added: true,
		enabled: true,
		mode: "read_write",
		status: "needs_signin",
	}),
	connector({ id: "atlassian", name: "Atlassian" }),
];

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

const ready = apply(
	{ ...initialState, connection: "open", agentState: "idle" },
	{
		type: "auth_providers",
		providers: [{ id: "openai", name: "OpenAI", methods: ["api_key"], configured: true }],
	},
);

describe("connectors state", () => {
	it("keeps the list and opens the screen when the server asks (/connectors), closing the others", () => {
		let s = reduce(ready, { type: "accounts", open: true });
		s = apply(s, { type: "connectors", connectors: list });
		expect(s.connectors).toMatchObject({ open: false, list });
		expect(s.auth.open).toBe(true);
		s = apply(s, { type: "connectors", connectors: list, open: true });
		expect(s.connectors.open).toBe(true);
		expect(s.auth.open).toBe(false);
		s = reduce(s, { type: "profiles", open: true });
		expect(s.connectors.open).toBe(false);
		s = reduce(s, { type: "connectors", open: true });
		expect(s.profiles.open).toBe(false);
		expect(s.connectors.open).toBe(true);
	});

	it("tracks a connector sign-in apart from account sign-ins", () => {
		let s = reduce(ready, { type: "auth_started", providerId: "openai" });
		s = reduce(s, { type: "connector_started", connectorId: "notion" });
		expect(s.connectors).toMatchObject({ open: true, flow: { providerId: "notion", events: [] } });
		s = apply(
			s,
			{
				type: "auth_event",
				flowId: "connector-1",
				event: { kind: "auth_url", url: "https://auth.example.com/a" },
			},
			{ type: "auth_prompt", prompt: { flowId: "connector-1", kind: "manual_code", message: "Paste it" } },
		);
		expect(s.connectors.flow).toMatchObject({ flowId: "connector-1", prompt: { kind: "manual_code" } });
		expect(s.connectors.flow?.events).toHaveLength(1);
		expect(s.auth.flow).toEqual({ providerId: "openai", events: [] });
		s = apply(s, { type: "auth_done", flowId: "connector-1", providerId: "notion", ok: true });
		expect(s.connectors.flow).toMatchObject({ done: { ok: true } });
		expect(s.connectors.flow?.prompt).toBeUndefined();
		s = reduce(s, { type: "connectors", open: true });
		expect(s.connectors.flow).toBeUndefined();
	});
});

describe("ConnectorsPanel", () => {
	function panel(state: DotState) {
		const send = vi.fn();
		const dispatch = vi.fn();
		const openUrl = vi.fn();
		render(
			<ConnectorsPanel connectors={state.connectors} send={send} dispatch={dispatch} openUrl={openUrl} />,
		);
		return { send, dispatch, openUrl };
	}

	it("shows each connector with its status, what it can do, and the actions that apply", async () => {
		const { send, dispatch } = panel(apply(ready, { type: "connectors", connectors: list, open: true }));
		const notion = within(screen.getByRole("listitem", { name: "Notion" }));
		expect(notion.getByText("Connected")).toBeInTheDocument();
		expect(notion.getByText("Search and read your pages.")).toBeInTheDocument();
		expect(notion.getByRole("radio", { name: "Read only" })).toBeChecked();
		const linear = within(screen.getByRole("listitem", { name: "Linear" }));
		expect(linear.getByText("Needs sign-in")).toBeInTheDocument();
		expect(linear.getByText(/after you approve each one/)).toBeInTheDocument();
		expect(linear.getByRole("radio", { name: "Read and send" })).toBeChecked();
		const atlassian = within(screen.getByRole("listitem", { name: "Atlassian" }));
		expect(atlassian.queryByRole("radio")).toBeNull();
		expect(atlassian.queryByRole("button", { name: /Remove/ })).toBeNull();

		const user = userEvent.setup();
		await user.click(notion.getByRole("radio", { name: "Read and send" }));
		await user.click(notion.getByRole("button", { name: "Sign in to Notion again" }));
		await user.click(notion.getByRole("button", { name: "Disconnect Notion" }));
		await user.click(notion.getByRole("button", { name: "Remove Notion" }));
		await user.click(linear.getByRole("button", { name: "Sign in to Linear" }));
		await user.click(atlassian.getByRole("button", { name: "Connect Atlassian" }));
		expect(send.mock.calls.map(([m]) => m)).toEqual([
			{ type: "connector_mode", connectorId: "notion", mode: "read_write" },
			{ type: "connector_signin", connectorId: "notion" },
			{ type: "connector_disconnect", connectorId: "notion" },
			{ type: "connector_remove", connectorId: "notion" },
			{ type: "connector_signin", connectorId: "linear" },
			{ type: "connector_connect", connectorId: "atlassian" },
		]);
		expect(dispatch.mock.calls.map(([a]) => a)).toEqual([
			{ type: "connector_started", connectorId: "notion" },
			{ type: "connector_started", connectorId: "linear" },
			{ type: "connector_started", connectorId: "atlassian" },
		]);
	});

	it("offers to turn a connector that is off back on", async () => {
		const off = [connector({ added: true, enabled: false, status: "off" })];
		const { send } = panel(apply(ready, { type: "connectors", connectors: off, open: true }));
		const notion = within(screen.getByRole("listitem", { name: "Notion" }));
		expect(notion.getByText("Off")).toBeInTheDocument();
		expect(notion.queryByRole("button", { name: /Disconnect/ })).toBeNull();
		await userEvent.setup().click(notion.getByRole("button", { name: "Connect Notion" }));
		expect(send).toHaveBeenCalledWith({ type: "connector_connect", connectorId: "notion" });
	});

	it("walks through a sign-in: link, pasted address, cancel, and the result", async () => {
		let s = apply(ready, { type: "connectors", connectors: list, open: true });
		s = reduce(s, { type: "connector_started", connectorId: "linear" });
		s = apply(
			s,
			{
				type: "auth_event",
				flowId: "connector-9",
				event: {
					kind: "auth_url",
					url: "https://auth.example.com/a",
					instructions: "Approve access to Linear.",
				},
			},
			{
				type: "auth_prompt",
				prompt: { flowId: "connector-9", kind: "manual_code", message: "Paste the address" },
			},
		);
		const { send, openUrl } = panel(s);
		expect(screen.getByText("Signing in to Linear")).toBeInTheDocument();
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Open the sign-in page" }));
		expect(openUrl).toHaveBeenCalledWith("https://auth.example.com/a");
		await user.type(screen.getByLabelText("Paste the address"), "http://127.0.0.1:1/callback?code=c");
		await user.click(screen.getByRole("button", { name: "Continue" }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(send.mock.calls.map(([m]) => m)).toEqual([
			{ type: "auth_reply", flowId: "connector-9", value: "http://127.0.0.1:1/callback?code=c" },
			{ type: "auth_reply", flowId: "connector-9", cancelled: true },
		]);
	});

	it("says when a sign-in finished", () => {
		let s = apply(ready, { type: "connectors", connectors: list, open: true });
		s = reduce(s, { type: "connector_started", connectorId: "notion" });
		s = apply(s, { type: "auth_done", flowId: "connector-2", providerId: "notion", ok: true });
		panel(s);
		expect(screen.getByRole("status")).toHaveTextContent("Connected to Notion.");
		expect(screen.getByRole("button", { name: "Back to connectors" })).toBeInTheDocument();
	});
});

function Harness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	return <ChatSurface variant="panel" state={state} send={send} dismiss={vi.fn()} dispatch={dispatch} />;
}

describe("Connectors in the panel", () => {
	it("opens from a header icon with a name and tooltip, and typing closes it", async () => {
		const send = vi.fn();
		render(<Harness initial={apply(ready, { type: "connectors", connectors: list })} send={send} />);
		const button = screen.getByRole("button", { name: "Connectors" });
		expect(button).toHaveAttribute("title", "Connectors");
		expect(button.querySelectorAll("svg")).toHaveLength(1);
		const user = userEvent.setup();
		await user.click(button);
		expect(send).toHaveBeenCalledWith({ type: "connectors_list" });
		expect(screen.getByRole("region", { name: "Connectors" })).toBeInTheDocument();
		await user.type(screen.getByRole("textbox", { name: "Message" }), "h");
		expect(screen.queryByRole("region", { name: "Connectors" })).toBeNull();
	});

	it("keeps a sign-in that waits for a pasted address while the user types", async () => {
		let s = apply(ready, { type: "connectors", connectors: list, open: true });
		s = reduce(s, { type: "connector_started", connectorId: "notion" });
		s = apply(s, {
			type: "auth_prompt",
			prompt: { flowId: "connector-3", kind: "manual_code", message: "Paste" },
		});
		render(<Harness initial={s} send={vi.fn()} />);
		await userEvent.setup().type(screen.getByRole("textbox", { name: "Message" }), "h");
		expect(screen.getByRole("region", { name: "Connectors" })).toBeInTheDocument();
	});
});

describe("approval cards", () => {
	it("keep the preview's line breaks and use legible text", () => {
		render(
			<AskCard
				ask={{
					requestId: "r",
					method: "confirm",
					title: "Allow Notion to create pages?",
					message: "The assistant wants to create pages in Notion.\n\ntitle: Plan\nbody: Hello",
				}}
				send={vi.fn()}
			/>,
		);
		const message = screen.getByText(/The assistant wants to create pages/);
		expect(message.textContent).toContain("\ntitle: Plan\nbody: Hello");
		// A variable keeps Vite from turning the address into an asset URL.
		const stylesheet = "../src/styles.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		const rule = /\.ask-message \{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(rule).toMatch(/white-space: pre-wrap/);
		expect(rule).toMatch(/overflow-wrap: anywhere/);
		expect(rule).toMatch(/color: var\(--text\)/);
	});
});
