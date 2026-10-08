import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountsPanel } from "../src/components/AccountsPanel.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

const providers = [
	{
		id: "anthropic",
		name: "Anthropic",
		methods: ["oauth", "api_key"] as const,
		oauthName: "Claude Pro/Max",
		configured: false,
	},
	{ id: "openai", name: "OpenAI", methods: ["api_key"] as const, configured: true, source: "stored" },
].map((p) => ({ ...p, methods: [...p.methods] }));

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

function base(): DotState {
	return apply(
		{ ...initialState, connection: "open", agentState: "idle" },
		{ type: "auth_providers", providers },
	);
}

describe("auth state", () => {
	it("opens the accounts screen when the server asks (/login)", () => {
		const s = apply(base(), { type: "auth_providers", providers, open: true });
		expect(s.auth.open).toBe(true);
	});

	it("tracks one flow: started, link, prompt, and result", () => {
		let s = reduce(base(), { type: "auth_started", providerId: "anthropic" });
		expect(s.auth.flow).toMatchObject({ providerId: "anthropic", events: [] });
		s = apply(
			s,
			{ type: "auth_event", flowId: "f1", event: { kind: "auth_url", url: "https://example.com/a" } },
			{ type: "auth_prompt", prompt: { flowId: "f1", kind: "manual_code", message: "Paste the code" } },
		);
		expect(s.auth.flow).toMatchObject({ flowId: "f1", prompt: { kind: "manual_code" } });
		s = apply(s, { type: "auth_done", flowId: "f1", providerId: "anthropic", ok: true });
		expect(s.auth.flow).toMatchObject({ done: { ok: true } });
		expect(s.auth.flow?.prompt).toBeUndefined();
	});

	it("goes back to the provider list after a finished sign-in", () => {
		let s = reduce(base(), { type: "auth_started", providerId: "anthropic" });
		s = apply(s, { type: "auth_done", flowId: "f1", providerId: "anthropic", ok: true });
		s = reduce(s, { type: "accounts", open: true });
		expect(s.auth).toMatchObject({ open: true, flow: undefined });
	});

	it("keeps a running sign-in when the accounts screen is reopened", () => {
		let s = reduce(base(), { type: "auth_started", providerId: "anthropic" });
		s = reduce(s, { type: "accounts", open: true });
		expect(s.auth.flow?.providerId).toBe("anthropic");
	});
});

describe("AccountsPanel", () => {
	it("lists providers with their status and sign-in options", async () => {
		const send = vi.fn();
		const dispatch = vi.fn();
		render(<AccountsPanel auth={base().auth} send={send} dispatch={dispatch} openUrl={vi.fn()} />);
		expect(screen.getByText("Anthropic")).toBeInTheDocument();
		expect(screen.getByText("Connected")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Sign in with Claude Pro/Max" }));
		expect(send).toHaveBeenCalledWith({ type: "auth_login", providerId: "anthropic", method: "oauth" });
		expect(dispatch).toHaveBeenCalledWith({ type: "auth_started", providerId: "anthropic" });
		await userEvent.click(screen.getAllByRole("button", { name: "Use an API key" })[0] as HTMLElement);
		expect(send).toHaveBeenCalledWith({ type: "auth_login", providerId: "anthropic", method: "api_key" });
	});

	it("lists subscriptions first and API keys below", () => {
		const auth = apply(base(), {
			type: "auth_providers",
			providers: [
				{ id: "anthropic", name: "Anthropic", methods: ["api_key"], configured: false },
				{
					id: "github-copilot",
					name: "GitHub Copilot",
					methods: ["oauth"],
					oauthName: "GitHub Copilot",
					configured: false,
				},
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					methods: ["oauth"],
					oauthName: "OpenAI (ChatGPT Plus/Pro)",
					configured: false,
				},
				{ id: "openai", name: "OpenAI", methods: ["api_key"], configured: false },
			],
		}).auth;
		render(<AccountsPanel auth={auth} send={vi.fn()} dispatch={vi.fn()} openUrl={vi.fn()} />);
		const subscriptions = screen.getByRole("region", { name: "Use your subscription" });
		const keys = screen.getByRole("region", { name: "Use an API key" });
		expect(subscriptions.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(
			within(subscriptions)
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual(["Sign in with GitHub Copilot", "Sign in with OpenAI (ChatGPT Plus/Pro)"]);
		expect(within(keys).getByText("Anthropic")).toBeInTheDocument();
		expect(within(keys).getByText("OpenAI")).toBeInTheDocument();
		expect(within(keys).queryByText("GitHub Copilot")).toBeNull();
	});

	it("filters providers by name", async () => {
		render(<AccountsPanel auth={base().auth} send={vi.fn()} dispatch={vi.fn()} openUrl={vi.fn()} />);
		await userEvent.type(screen.getByRole("searchbox", { name: "Search providers" }), "open");
		expect(screen.queryByText("Anthropic")).toBeNull();
		expect(screen.getByText("OpenAI")).toBeInTheDocument();
	});

	it("opens the sign-in page, takes the pasted code, and can cancel", async () => {
		const send = vi.fn();
		const openUrl = vi.fn();
		let s = reduce(base(), { type: "auth_started", providerId: "anthropic" });
		s = apply(
			s,
			{
				type: "auth_event",
				flowId: "f1",
				event: { kind: "auth_url", url: "https://example.com/a", instructions: "Sign in" },
			},
			{
				type: "auth_prompt",
				prompt: { flowId: "f1", kind: "manual_code", message: "Paste the code", placeholder: "code" },
			},
		);
		render(<AccountsPanel auth={s.auth} send={send} dispatch={vi.fn()} openUrl={openUrl} />);
		await userEvent.click(screen.getByRole("button", { name: "Open the sign-in page" }));
		expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
		await userEvent.type(screen.getByPlaceholderText("code"), "abc123");
		await userEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(send).toHaveBeenCalledWith({ type: "auth_reply", flowId: "f1", value: "abc123" });
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(send).toHaveBeenLastCalledWith({ type: "auth_reply", flowId: "f1", cancelled: true });
	});

	it("hides a secret while typing and shows a device code to copy", () => {
		let s = reduce(base(), { type: "auth_started", providerId: "openai" });
		s = apply(
			s,
			{
				type: "auth_event",
				flowId: "f2",
				event: { kind: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device" },
			},
			{ type: "auth_prompt", prompt: { flowId: "f2", kind: "secret", message: "Enter your API key" } },
		);
		render(<AccountsPanel auth={s.auth} send={vi.fn()} dispatch={vi.fn()} openUrl={vi.fn()} />);
		expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
		expect(screen.getByLabelText("Enter your API key")).toHaveAttribute("type", "password");
	});

	it("answers a choice prompt with the option id", async () => {
		const send = vi.fn();
		let s = reduce(base(), { type: "auth_started", providerId: "anthropic" });
		s = apply(s, {
			type: "auth_prompt",
			prompt: {
				flowId: "f3",
				kind: "select",
				message: "Choose a plan",
				options: [{ id: "max", label: "Max" }],
			},
		});
		render(<AccountsPanel auth={s.auth} send={send} dispatch={vi.fn()} openUrl={vi.fn()} />);
		await userEvent.click(screen.getByRole("button", { name: "Max" }));
		expect(send).toHaveBeenCalledWith({ type: "auth_reply", flowId: "f3", value: "max" });
	});

	it("reports the result in plain words", () => {
		let s = reduce(base(), { type: "auth_started", providerId: "anthropic" });
		s = apply(s, { type: "auth_done", flowId: "f1", providerId: "anthropic", ok: true });
		const { rerender } = render(
			<AccountsPanel auth={s.auth} send={vi.fn()} dispatch={vi.fn()} openUrl={vi.fn()} />,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Connected to Anthropic.");
		s = apply(reduce(base(), { type: "auth_started", providerId: "anthropic" }), {
			type: "auth_done",
			flowId: "f9",
			providerId: "anthropic",
			ok: false,
			message: "Sign-in cancelled.",
		});
		rerender(<AccountsPanel auth={s.auth} send={vi.fn()} dispatch={vi.fn()} openUrl={vi.fn()} />);
		expect(screen.getByRole("status")).toHaveTextContent("Sign-in cancelled.");
	});
});

describe("ChatSurface onboarding", () => {
	it("asks to connect an account when none is configured", async () => {
		const dispatch = vi.fn();
		const s = apply(
			{ ...initialState, connection: "open", agentState: "idle" },
			{ type: "auth_providers", providers: providers.map((p) => ({ ...p, configured: false })) },
		);
		render(<ChatSurface variant="web" state={s} send={vi.fn()} dismiss={vi.fn()} dispatch={dispatch} />);
		await userEvent.click(screen.getByRole("button", { name: "Connect an AI account" }));
		expect(dispatch).toHaveBeenCalledWith({ type: "accounts", open: true });
	});

	it("opens accounts from the header", async () => {
		const dispatch = vi.fn();
		const send = vi.fn();
		render(<ChatSurface variant="web" state={base()} send={send} dismiss={vi.fn()} dispatch={dispatch} />);
		await userEvent.click(screen.getByRole("button", { name: "Accounts" }));
		expect(dispatch).toHaveBeenCalledWith({ type: "accounts", open: true });
		expect(send).toHaveBeenCalledWith({ type: "auth_list" });
	});
});
