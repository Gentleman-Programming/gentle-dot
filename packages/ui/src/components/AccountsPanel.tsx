import type { AuthEvent, AuthPrompt, AuthProvider } from "@gentle-dot/protocol";
import { type ReactNode, useState } from "react";
import type { AuthState, DotAction } from "../store.ts";
import "../accounts.css";
import type { Send } from "./types.ts";

interface AccountsPanelProps {
	auth: AuthState;
	send: Send;
	dispatch: (action: DotAction) => void;
	openUrl: (url: string) => void;
}

/** Sign-in for subscriptions and API keys, without a terminal. */
export function AccountsPanel({ auth, send, dispatch, openUrl }: AccountsPanelProps) {
	const [filter, setFilter] = useState("");
	const flow = auth.flow;
	const busy = flow !== undefined && flow.done === undefined;
	const login = (provider: AuthProvider, method: "oauth" | "api_key") => {
		dispatch({ type: "auth_started", providerId: provider.id });
		send({ type: "auth_login", providerId: provider.id, method });
	};
	const providers = (auth.providers ?? []).filter((p) =>
		p.name.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	const providerName = (id: string) => auth.providers?.find((p) => p.id === id)?.name ?? id;

	return (
		<section className="accounts" aria-label="Accounts">
			<header className="accounts-header">
				<h2>Accounts</h2>
				<button
					type="button"
					className="icon"
					aria-label="Close accounts"
					onClick={() => dispatch({ type: "accounts", open: false })}
				>
					×
				</button>
			</header>
			<p className="muted">
				Connect the AI service you already pay for, or paste an API key. Your sign-in stays on this computer.
			</p>

			{flow ? (
				<div className="auth-flow">
					<p className="auth-flow-title">Signing in to {providerName(flow.providerId)}</p>
					{flow.events.map((event, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: events are append-only and never reordered
						<FlowEvent key={`${event.kind}-${i}`} event={event} openUrl={openUrl} />
					))}
					{flow.prompt ? <FlowPrompt key={flow.prompt.message} prompt={flow.prompt} send={send} /> : null}
					{busy && !flow.prompt && flow.events.length === 0 ? <p className="muted">Starting…</p> : null}
					{flow.done ? (
						<p className={`auth-result ${flow.done.ok ? "ok" : "failed"}`} role="status">
							{flow.done.ok
								? `Connected to ${providerName(flow.providerId)}.`
								: (flow.done.message ?? "Sign-in did not finish.")}
						</p>
					) : null}
					<div className="auth-actions">
						{busy && flow.flowId ? (
							<button
								type="button"
								onClick={() => send({ type: "auth_reply", flowId: flow.flowId ?? "", cancelled: true })}
							>
								Cancel
							</button>
						) : null}
						{flow.done ? (
							<button type="button" onClick={() => dispatch({ type: "accounts", open: true })}>
								Back to accounts
							</button>
						) : null}
					</div>
				</div>
			) : (
				<>
					<input
						type="search"
						className="accounts-search"
						aria-label="Search providers"
						placeholder="Search providers"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					<ProviderSection
						title="Use your subscription"
						hint="Sign in with a plan you already pay for."
						providers={providers.filter((p) => p.methods.includes("oauth"))}
						label={(p) => p.name}
						plan={(p) => (p.oauthName && p.oauthName !== p.name ? p.oauthName : undefined)}
						action={(p) => (
							<button
								type="button"
								className="primary"
								aria-label={`Sign in with ${p.oauthName ?? p.name}`}
								onClick={() => login(p, "oauth")}
							>
								Sign in
							</button>
						)}
						send={send}
					/>
					<ProviderSection
						title="Use an API key"
						hint="For every other service: paste the key from its website."
						providers={providers.filter((p) => p.methods.includes("api_key"))}
						label={(p) => p.name}
						action={(p) => (
							<button type="button" onClick={() => login(p, "api_key")}>
								Use an API key
							</button>
						)}
						send={send}
					/>
				</>
			)}
		</section>
	);
}

interface ProviderSectionProps {
	title: string;
	hint: string;
	providers: AuthProvider[];
	label: (provider: AuthProvider) => string;
	/** A second line under the name, for example the subscription plan. */
	plan?: (provider: AuthProvider) => string | undefined;
	action: (provider: AuthProvider) => ReactNode;
	send: Send;
}

function ProviderSection({ title, hint, providers, label, plan, action, send }: ProviderSectionProps) {
	if (providers.length === 0) return null;
	const id = `providers-${title.toLowerCase().replace(/\W+/g, "-")}`;
	return (
		<section className="provider-section" aria-labelledby={id}>
			<h3 id={id}>{title}</h3>
			<p className="muted">{hint}</p>
			<ul className="providers">
				{providers.map((provider) => (
					<li key={provider.id}>
						<div className="provider-name">
							<b>{label(provider)}</b>
							{provider.configured ? <span className="chip ok">Connected</span> : null}
						</div>
						{plan?.(provider) ? <p className="provider-plan">{plan(provider)}</p> : null}
						<div className="provider-actions">
							{action(provider)}
							{provider.configured && provider.source === "stored" ? (
								<button
									type="button"
									className="link"
									onClick={() => send({ type: "auth_logout", providerId: provider.id })}
								>
									Sign out
								</button>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

function FlowEvent({ event, openUrl }: { event: AuthEvent; openUrl: (url: string) => void }) {
	switch (event.kind) {
		case "auth_url":
			return (
				<div className="auth-step">
					<p>{event.instructions ?? "Finish signing in on the provider's page."}</p>
					<button type="button" className="primary" onClick={() => openUrl(event.url)}>
						Open the sign-in page
					</button>
				</div>
			);
		case "device_code":
			return (
				<div className="auth-step">
					<p>Open the page below and enter this code:</p>
					<code className="device-code">{event.userCode}</code>
					<button type="button" className="primary" onClick={() => openUrl(event.verificationUri)}>
						Open the page
					</button>
				</div>
			);
		case "info":
		case "progress":
			return <p className="muted">{event.message}</p>;
	}
}

function FlowPrompt({ prompt, send }: { prompt: AuthPrompt; send: Send }) {
	const [value, setValue] = useState("");
	const answer = (text: string) => send({ type: "auth_reply", flowId: prompt.flowId, value: text });
	if (prompt.kind === "select") {
		return (
			<div className="auth-step">
				<p>{prompt.message}</p>
				<div className="ask-options">
					{(prompt.options ?? []).map((option) => (
						<button
							key={option.id}
							type="button"
							title={option.description}
							onClick={() => answer(option.id)}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>
		);
	}
	return (
		<form
			className="auth-step ask-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (value.trim()) answer(value.trim());
			}}
		>
			<label>
				<span>{prompt.message}</span>
				<input
					type={prompt.kind === "secret" ? "password" : "text"}
					autoComplete="off"
					placeholder={
						prompt.placeholder ??
						(prompt.kind === "manual_code" ? "Paste the code or the full address here" : "")
					}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</label>
			<button type="submit" className="primary" disabled={!value.trim()}>
				Continue
			</button>
		</form>
	);
}
