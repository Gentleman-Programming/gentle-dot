import type { AuthEvent, AuthPrompt, AuthProvider } from "@gentle-dot/protocol";
import { type ReactNode, useState } from "react";
import { useLocale } from "../i18n.tsx";
import { searchProviders } from "../provider-search.ts";
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
	const { t } = useLocale();
	const [filter, setFilter] = useState("");
	const [method, setMethod] = useState<"oauth" | "api_key" | undefined>(undefined);
	const flow = auth.flow;
	const busy = flow !== undefined && flow.done === undefined;
	const login = (provider: AuthProvider, method: "oauth" | "api_key") => {
		dispatch({ type: "auth_started", providerId: provider.id });
		send({ type: "auth_login", providerId: provider.id, method });
	};
	const providers = searchProviders(auth.providers, filter);
	const connected = (auth.providers ?? []).filter((p) => p.configured);
	const providerName = (id: string) => auth.providers?.find((p) => p.id === id)?.name ?? id;

	return (
		<section className="accounts" aria-label={t("account.title")}>
			<header className="accounts-header">
				<h2>{t("account.title")}</h2>
				<button
					type="button"
					className="icon"
					aria-label={t("account.close")}
					onClick={() => dispatch({ type: "accounts", open: false })}
				>
					×
				</button>
			</header>
			<p className="muted">{t("account.intro")}</p>

			{flow ? (
				<div className="auth-flow">
					<p className="auth-flow-title">
						{t("account.signingIn").replace("{provider}", () => providerName(flow.providerId))}
					</p>
					{flow.events.map((event, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: events are append-only and never reordered
						<FlowEvent key={`${event.kind}-${i}`} event={event} openUrl={openUrl} />
					))}
					{flow.prompt ? <FlowPrompt key={flow.prompt.message} prompt={flow.prompt} send={send} /> : null}
					{busy && !flow.prompt && flow.events.length === 0 ? (
						<p className="muted">{t("account.starting")}</p>
					) : null}
					{flow.done ? (
						<p className={`auth-result ${flow.done.ok ? "ok" : "failed"}`} role="status">
							{flow.done.ok
								? t("account.success").replace("{provider}", () => providerName(flow.providerId))
								: (flow.done.message ?? t("account.failure"))}
						</p>
					) : null}
					<div className="auth-actions">
						{busy && flow.flowId ? (
							<button
								type="button"
								onClick={() => send({ type: "auth_reply", flowId: flow.flowId ?? "", cancelled: true })}
							>
								{t("account.cancel")}
							</button>
						) : null}
						{flow.done ? (
							<button
								type="button"
								onClick={() => {
									setMethod(undefined);
									setFilter("");
									dispatch({ type: "accounts", open: true });
								}}
							>
								{t("account.backToAccounts")}
							</button>
						) : null}
					</div>
				</div>
			) : method === undefined ? (
				<>
					{connected.length > 0 ? (
						<section className="provider-section" aria-labelledby="accounts-connected">
							<h3 id="accounts-connected">{t("account.connected")}</h3>
							<ul className="providers">
								{connected.map((provider) => (
									<li key={provider.id} className="connected-row">
										<b>{provider.name}</b>
										{provider.source === "stored" ? (
											<button
												type="button"
												className="link"
												aria-label={t("account.signOutLabel").replace("{provider}", () => provider.name)}
												onClick={() => send({ type: "auth_logout", providerId: provider.id })}
											>
												{t("account.signOut")}
											</button>
										) : (
											<span className="muted">{t("account.environment")}</span>
										)}
									</li>
								))}
							</ul>
						</section>
					) : null}
					<div className="method-choices">
						<button type="button" className="method-choice" onClick={() => setMethod("oauth")}>
							<b>{t("account.subscription")}</b>
							<span>{t("account.subscriptionDescription")}</span>
						</button>
						<button type="button" className="method-choice" onClick={() => setMethod("api_key")}>
							<b>{t("account.apiKey")}</b>
							<span>{t("account.apiKeyDescription")}</span>
						</button>
					</div>
				</>
			) : (
				<>
					<button
						type="button"
						className="link back"
						onClick={() => {
							setMethod(undefined);
							setFilter("");
						}}
					>
						{t("account.back")}
					</button>
					<input
						type="search"
						className="accounts-search"
						aria-label={t("account.search")}
						placeholder={t("account.search")}
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					{method === "oauth" ? (
						<ProviderSection
							title={t("account.subscription")}
							hint={t("account.subscriptionHint")}
							providers={providers.filter((p) => p.methods.includes("oauth"))}
							label={(p) => p.name}
							plan={(p) => (p.oauthName && p.oauthName !== p.name ? p.oauthName : undefined)}
							action={(p) => (
								<button
									type="button"
									className="primary"
									aria-label={t("account.signInLabel").replace("{provider}", () => p.oauthName ?? p.name)}
									onClick={() => login(p, "oauth")}
								>
									{t("account.signIn")}
								</button>
							)}
							send={send}
						/>
					) : (
						<ProviderSection
							title={t("account.apiKey")}
							hint={t("account.apiKeyHint")}
							providers={providers.filter((p) => p.methods.includes("api_key"))}
							label={(p) => p.name}
							action={(p) => (
								<button
									type="button"
									aria-label={t("account.apiKeyLabel").replace("{provider}", () => p.name)}
									onClick={() => login(p, "api_key")}
								>
									{t("account.apiKey")}
								</button>
							)}
							send={send}
						/>
					)}
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
	const { t } = useLocale();
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
							{provider.configured ? <span className="chip ok">{t("account.connected")}</span> : null}
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
									{t("account.signOut")}
								</button>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

export function FlowEvent({ event, openUrl }: { event: AuthEvent; openUrl: (url: string) => void }) {
	const { t } = useLocale();
	switch (event.kind) {
		case "auth_url":
			return (
				<div className="auth-step">
					<p>{event.instructions ?? t("account.finishSignIn")}</p>
					<button type="button" className="primary" onClick={() => openUrl(event.url)}>
						{t("account.openSignIn")}
					</button>
				</div>
			);
		case "device_code":
			return (
				<div className="auth-step">
					<p>{t("account.deviceInstructions")}</p>
					<code className="device-code">{event.userCode}</code>
					<button type="button" className="primary" onClick={() => openUrl(event.verificationUri)}>
						{t("account.openPage")}
					</button>
				</div>
			);
		case "info":
		case "progress":
			return <p className="muted">{event.message}</p>;
	}
}

export function FlowPrompt({ prompt, send }: { prompt: AuthPrompt; send: Send }) {
	const { t } = useLocale();
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
						prompt.placeholder ?? (prompt.kind === "manual_code" ? t("account.codePlaceholder") : "")
					}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</label>
			<button type="submit" className="primary" disabled={!value.trim()}>
				{t("account.continue")}
			</button>
			{prompt.optional ? (
				<button type="button" onClick={() => answer("")}>
					{t("account.skip")}
				</button>
			) : null}
		</form>
	);
}
