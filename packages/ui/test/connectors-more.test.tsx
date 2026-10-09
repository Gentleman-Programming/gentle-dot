import {
	APP_REQUIRED,
	type ClientMessage,
	type ConnectorDraft,
	type ConnectorInfo,
	type ImportCandidate,
	type ServerMessage,
	type ServerPayload,
} from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { ConnectorsPanel } from "../src/components/ConnectorsPanel.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

const connector = (overrides: Partial<ConnectorInfo>): ConnectorInfo => ({
	id: "discord",
	name: "Discord",
	reads: "Read messages in the servers your bot is in.",
	sends: "Send messages, after you approve each one.",
	added: false,
	enabled: false,
	mode: "read_only",
	status: "off",
	...overrides,
});

const discord = connector({
	guide: {
		steps: [
			"Open the Discord Developer Portal.",
			"Add a bot.",
			"Turn on Message Content Intent.",
			"Copy the token.",
		],
		links: [{ label: "Discord Developer Portal", url: "https://discord.com/developers/applications" }],
	},
});
const slack = connector({
	id: "slack",
	name: "Slack",
	guide: {
		steps: ["Create an app.", "Turn on PKCE.", "Add the redirect URL.", "Copy the client ID."],
		links: [{ label: "Slack apps", url: "https://api.slack.com/apps" }],
		redirectUrl: "http://localhost:38417/callback",
	},
});
const github = connector({
	id: "github",
	name: "GitHub",
	reads: "Read issues.",
	sends: "Every action asks you first.",
	added: true,
	enabled: true,
	status: "connected",
	custom: { origin: "Imported from Cursor", summary: "npx -y @modelcontextprotocol/server-github" },
});
const perplexity = connector({
	id: "perplexity",
	name: "perplexity",
	added: true,
	enabled: true,
	status: "needs_setup",
	custom: { origin: "Imported from VS Code", summary: "npx -y server-perplexity-ask" },
});

const found: ImportCandidate[] = [
	{
		id: "Cursor:stripe",
		name: "stripe",
		sources: ["Cursor"],
		transport: "http",
		summary: "https://mcp.stripe.com/",
		envNames: [],
		headerNames: ["Authorization"],
		inputs: [],
		importable: true,
	},
	{
		id: "Claude Desktop:github",
		name: "github",
		sources: ["Claude Desktop", "Cursor"],
		transport: "stdio",
		summary: "npx -y @modelcontextprotocol/server-github",
		envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
		headerNames: [],
		inputs: [],
		importable: true,
	},
	{
		id: "Claude Code:legacy",
		name: "legacy",
		sources: ["Claude Code"],
		transport: "sse",
		summary: "https://old.example.com/sse",
		envNames: [],
		headerNames: [],
		inputs: [],
		importable: false,
		reason: "Uses the old SSE transport, which the assistant does not support.",
	},
	{
		id: "Cursor:linear",
		name: "linear",
		sources: ["Cursor"],
		transport: "http",
		summary: "https://mcp.linear.app/mcp",
		envNames: [],
		headerNames: [],
		inputs: [],
		importable: false,
		duplicateOf: "linear",
	},
];

const draft: ConnectorDraft = {
	draftId: "d1",
	name: "GitHub",
	description: "Read issues and pull requests.",
	transport: "stdio",
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
	envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
	needsOAuth: false,
};

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
	{ type: "connectors", connectors: [discord, slack, github, perplexity] },
);

function Harness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	return (
		<ChatSurface
			variant="panel"
			state={state}
			send={send}
			appSend={send}
			dismiss={vi.fn()}
			dispatch={dispatch}
		/>
	);
}

/** The web page: no app, so no `appSend`. */
function WebHarness({ initial, send }: { initial: DotState; send: (m: ClientMessage) => void }) {
	const [state, dispatch] = useReducer(reduce, initial);
	return <ChatSurface variant="web" state={state} send={send} dismiss={vi.fn()} dispatch={dispatch} />;
}

function panel(state: DotState) {
	const send = vi.fn();
	const dispatch = vi.fn();
	const openUrl = vi.fn();
	render(
		<ConnectorsPanel
			connectors={state.connectors}
			send={send}
			appSend={send}
			dispatch={dispatch}
			openUrl={openUrl}
		/>,
	);
	return { send, dispatch, openUrl };
}

describe("guided connectors", () => {
	it("shows the step-by-step guide before connecting, then connects", async () => {
		const send = vi.fn();
		render(<Harness initial={reduce(ready, { type: "connectors", open: true })} send={send} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Connect Slack" }));
		expect(send).not.toHaveBeenCalledWith({ type: "connector_connect", connectorId: "slack" });
		const guide = within(screen.getByRole("region", { name: "Set up Slack" }));
		expect(guide.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"Create an app.",
			"Turn on PKCE.",
			"Add the redirect URL.",
			"Copy the client ID.",
		]);
		expect(guide.getByText("http://localhost:38417/callback")).toBeInTheDocument();
		expect(guide.getByRole("button", { name: "Open Slack apps" })).toBeInTheDocument();
		await user.click(guide.getByRole("button", { name: "Back" }));
		expect(screen.queryByRole("region", { name: "Set up Slack" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Connect Discord" }));
		await user.click(screen.getByRole("button", { name: "Continue" }));
		expect(send).toHaveBeenCalledWith({ type: "connector_connect", connectorId: "discord" });
	});

	it("titles a setup flow, and lets an optional value be skipped", async () => {
		let s = reduce(ready, { type: "connector_started", connectorId: "slack" });
		s = apply(s, {
			type: "auth_prompt",
			prompt: {
				flowId: "connector-setup-1",
				kind: "secret",
				message: "Client secret (leave empty if you turned on PKCE)",
				optional: true,
			},
		});
		const { send } = panel(s);
		expect(screen.getByText("Setting up Slack")).toBeInTheDocument();
		expect(screen.getByLabelText(/Client secret/)).toHaveAttribute("type", "password");
		await userEvent.setup().click(screen.getByRole("button", { name: "Skip" }));
		expect(send).toHaveBeenCalledWith({ type: "auth_reply", flowId: "connector-setup-1", value: "" });
	});

	it("shows where a custom connector came from, that its tools are hidden, and offers Set up", async () => {
		const { send, dispatch } = panel(reduce(ready, { type: "connectors", open: true }));
		const row = within(screen.getByRole("listitem", { name: "GitHub" }));
		expect(row.getByText("Imported from Cursor")).toBeInTheDocument();
		expect(row.getByText("npx -y @modelcontextprotocol/server-github")).toBeInTheDocument();
		expect(row.getByText(/tools stay hidden until you choose Read and send/)).toBeInTheDocument();
		const waiting = within(screen.getByRole("listitem", { name: "perplexity" }));
		expect(waiting.getByText("Needs setup")).toBeInTheDocument();
		await userEvent.setup().click(waiting.getByRole("button", { name: "Set up perplexity" }));
		expect(send).toHaveBeenCalledWith({ type: "connector_setup", connectorId: "perplexity" });
		expect(dispatch).toHaveBeenCalledWith({ type: "connector_started", connectorId: "perplexity" });
	});
});

describe("adding another connector", () => {
	it("asks the assistant in the chat and closes the screen", async () => {
		const send = vi.fn();
		render(<Harness initial={reduce(ready, { type: "connectors", open: true })} send={send} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Add another connector" }));
		await user.type(screen.getByLabelText("What do you want to connect?"), "Jira Cloud");
		await user.click(screen.getByRole("button", { name: "Ask the assistant" }));
		const message = send.mock.calls.map(([m]) => m as ClientMessage).find((m) => m.type === "send");
		expect(message).toMatchObject({ type: "send", text: expect.stringContaining("Jira Cloud") });
		expect(screen.queryByRole("region", { name: "Connectors" })).toBeNull();
	});

	it("shows the assistant's draft as a card with every detail; approving opens its setup", async () => {
		const send = vi.fn();
		render(<Harness initial={apply(ready, { type: "connector_draft", draft })} send={send} />);
		const card = within(screen.getByRole("region", { name: "Add GitHub?" }));
		expect(card.getByText("Read issues and pull requests.")).toBeInTheDocument();
		expect(card.getByText("npx -y @modelcontextprotocol/server-github@2025.4.8")).toBeInTheDocument();
		expect(card.getByText("GITHUB_PERSONAL_ACCESS_TOKEN")).toBeInTheDocument();
		expect(card.getByText(/You type each secret in the app/)).toBeInTheDocument();
		const user = userEvent.setup();
		await user.click(card.getByRole("button", { name: "Add GitHub" }));
		expect(send).toHaveBeenCalledWith({ type: "connector_draft_reply", draftId: "d1", approve: true });
		expect(screen.getByRole("region", { name: "Connectors" })).toBeInTheDocument();
	});

	it("declines a draft, and drops the card when it is resolved anywhere", async () => {
		const send = vi.fn();
		render(<Harness initial={apply(ready, { type: "connector_draft", draft })} send={send} />);
		await userEvent.setup().click(screen.getByRole("button", { name: "Decline" }));
		expect(send).toHaveBeenCalledWith({ type: "connector_draft_reply", draftId: "d1", approve: false });
		const s = apply(
			ready,
			{ type: "connector_draft", draft },
			{ type: "connector_draft_resolved", draftId: "d1", approved: false },
		);
		expect(s.connectors.drafts).toEqual([]);
		expect(
			apply(ready, { type: "connector_draft", draft }, { type: "connector_draft", draft }).connectors.drafts,
		).toHaveLength(1);
	});

	it("keeps only the drafts the daemon still holds: the newest five, and none it resolved while away", () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ ...draft, draftId: `d${i}`, name: `Server ${i}` }));
		const s = apply(ready, ...many.map((d): ServerPayload => ({ type: "connector_draft", draft: d })));
		expect(s.connectors.drafts?.map((d) => d.draftId)).toEqual(["d2", "d3", "d4", "d5", "d6"]);
		// After a reconnect the daemon sends the drafts still waiting right after ready.
		const again = apply(
			s,
			{ type: "ready", agentState: "idle" },
			{ type: "connector_draft", draft: many[6] as ConnectorDraft },
		);
		expect(again.connectors.drafts?.map((d) => d.draftId)).toEqual(["d6"]);
	});
});

describe("importing MCP servers", () => {
	it("scans on request and lists what it found with the source app, names only, and checkboxes", async () => {
		const send = vi.fn();
		render(<Harness initial={reduce(ready, { type: "connectors", open: true })} send={send} />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Import my MCP servers" }));
		expect(send).toHaveBeenCalledWith({ type: "connectors_scan" });
	});

	it("imports only the servers the user checks", async () => {
		const { send } = panel(
			apply(reduce(ready, { type: "connectors", open: true }), { type: "connector_imports", found }),
		);
		const list = within(screen.getByRole("region", { name: "Found these servers" }));
		const stripe = list.getByRole("checkbox", { name: "stripe" });
		const githubBox = list.getByRole("checkbox", { name: "github" });
		expect(stripe).not.toBeChecked();
		expect(list.getByText("From Claude Desktop, Cursor")).toBeInTheDocument();
		expect(list.getByText("GITHUB_PERSONAL_ACCESS_TOKEN")).toBeInTheDocument();
		expect(list.getByText("Authorization")).toBeInTheDocument();
		expect(list.getByRole("checkbox", { name: "legacy" })).toBeDisabled();
		expect(list.getByText(/old SSE transport/)).toBeInTheDocument();
		expect(list.getByRole("checkbox", { name: "linear" })).toBeDisabled();
		expect(list.getByText(/Already in your connectors as linear/)).toBeInTheDocument();
		const user = userEvent.setup();
		const importButton = list.getByRole("button", { name: /Import/ });
		expect(importButton).toBeDisabled();
		await user.click(stripe);
		await user.click(githubBox);
		await user.click(list.getByRole("button", { name: "Import 2 servers" }));
		expect(send).toHaveBeenCalledWith({
			type: "connector_import",
			ids: ["Cursor:stripe", "Claude Desktop:github"],
		});
	});

	it("notes a value that runs a command or reads an environment variable before the import", () => {
		const vault: ImportCandidate = {
			id: "Gentle Shell:vault",
			name: "vault",
			sources: ["Gentle Shell"],
			transport: "stdio",
			summary: "vault-mcp",
			envNames: ["VAULT_TOKEN", "REGION"],
			headerNames: [],
			inputs: [],
			importable: true,
			notes: [
				"VAULT_TOKEN: Runs a command on your computer to get this value.",
				"REGION: Reads the environment variable AWS_REGION.",
			],
		};
		panel(
			apply(reduce(ready, { type: "connectors", open: true }), { type: "connector_imports", found: [vault] }),
		);
		const list = within(screen.getByRole("region", { name: "Found these servers" }));
		expect(
			list.getByText("VAULT_TOKEN: Runs a command on your computer to get this value."),
		).toBeInTheDocument();
		expect(list.getByText("REGION: Reads the environment variable AWS_REGION.")).toBeInTheDocument();
	});

	it("says when nothing was found, and closes the list after an import", () => {
		let s = apply(reduce(ready, { type: "connectors", open: true }), {
			type: "connector_imports",
			found: [],
		});
		expect(s.connectors.imports).toEqual([]);
		panel(s);
		expect(screen.getByText(/No MCP servers were found/)).toBeInTheDocument();
		s = apply(s, { type: "connector_imports", found }, { type: "connector_imported", names: ["stripe"] });
		expect(s.connectors.imports).toBeUndefined();
		expect(s.notices.at(-1)?.message).toMatch(/Imported stripe/);
	});
});

describe("drafts and imports outside the desktop app (S25.2)", () => {
	it("a draft can be declined on the web page but only added in the app", async () => {
		const send = vi.fn();
		render(<WebHarness initial={apply(ready, { type: "connector_draft", draft })} send={send} />);
		const card = within(screen.getByRole("region", { name: "Add GitHub?" }));
		expect(card.getByRole("button", { name: "Add GitHub" })).toBeDisabled();
		expect(card.getByText(APP_REQUIRED)).toBeInTheDocument();
		await userEvent.setup().click(card.getByRole("button", { name: "Decline" }));
		expect(send.mock.calls.map(([m]) => m)).toEqual([
			{ type: "connector_draft_reply", draftId: "d1", approve: false },
		]);
	});

	it("the web page lists what it found but cannot import it", async () => {
		const send = vi.fn();
		render(
			<WebHarness
				initial={apply(reduce(ready, { type: "connectors", open: true }), {
					type: "connector_imports",
					found,
				})}
				send={send}
			/>,
		);
		const list = within(screen.getByRole("region", { name: "Found these servers" }));
		await userEvent.setup().click(list.getByRole("checkbox", { name: "stripe" }));
		expect(list.getByRole("button", { name: /Import/ })).toBeDisabled();
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "connector_import" }));
	});
});
