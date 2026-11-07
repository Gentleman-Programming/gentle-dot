import {
	APP_REQUIRED,
	type ConnectorInfo,
	type ConnectorStatus,
	type ImportCandidate,
} from "@gentle-dot/protocol";
import { useState } from "react";
import { useLocale } from "../i18n.tsx";
import type { MessageKey } from "../i18n-messages.ts";
import type { ConnectorsState, DotAction } from "../store.ts";
import "../accounts.css";
import { FlowEvent, FlowPrompt } from "./AccountsPanel.tsx";
import { type ComputerControls, ComputerEntry } from "./Computer.tsx";
import type { Send } from "./types.ts";
import { VoiceModelEntry } from "./VoiceModel.tsx";

interface ConnectorsPanelProps {
	connectors: ConnectorsState;
	send: Send;
	/**
	 * Connector changes, through the desktop app (S25.2). Without it (the web page, a VPS) the
	 * controls are disabled with the reason; lists and sign-in answers still go over `send`.
	 */
	appSend?: Send;
	dispatch: (action: DotAction) => void;
	openUrl: (url: string) => void;
	/** Computer control, in the desktop app on macOS only. */
	computer?: ComputerControls;
	/** The desktop app's voice engine and optional local model (S30.5). */
	voiceModel?: boolean;
}

const STATUS_LABELS: Record<ConnectorStatus, MessageKey> = {
	off: "connector.off",
	needs_setup: "connector.needsSetup",
	needs_signin: "connector.needsSignin",
	connected: "connector.connected",
	error: "connector.error",
};

/** What the chat says for "Add another connector"; the assistant answers with a draft to review. */
export const addConnectorRequest = (what: string) =>
	`Please help me add a connector for ${what}. Find its MCP server and draft it for me to review.`;

/** The apps the assistant can use, each signed in from here and set to read only or read and send. */
export function ConnectorsPanel({
	connectors,
	send,
	appSend,
	dispatch,
	openUrl,
	computer,
	voiceModel,
}: ConnectorsPanelProps) {
	const { t } = useLocale();
	const [guideFor, setGuideFor] = useState<string>();
	const [adding, setAdding] = useState(false);
	const flow = connectors.flow;
	const busy = flow !== undefined && flow.done === undefined;
	const name = (id: string) => connectors.list?.find((c) => c.id === id)?.name ?? id;
	const start = (
		connector: ConnectorInfo,
		type: "connector_connect" | "connector_signin" | "connector_setup",
	) => {
		if (!appSend) return;
		setGuideFor(undefined);
		dispatch({ type: "connector_started", connectorId: connector.id });
		appSend({ type, connectorId: connector.id });
	};
	const guided = connectors.list?.find((c) => c.id === guideFor && c.guide);
	// Values are asked first; once the sign-in page is on its way, it is a sign-in.
	const settingUp = flow?.flowId?.startsWith("connector-setup-") && flow.events.length === 0;

	return (
		<section className="accounts connectors" aria-label={t("connector.title")}>
			<header className="accounts-header">
				<h2>{t("connector.title")}</h2>
				<button
					type="button"
					className="icon"
					aria-label={t("connector.close")}
					onClick={() => dispatch({ type: "connectors", open: false })}
				>
					×
				</button>
			</header>
			<p className="muted">{t("connector.intro")}</p>
			{appSend ? null : <p className="connector-note">{APP_REQUIRED}</p>}

			{flow ? (
				<div className="auth-flow">
					<p className="auth-flow-title">
						{t(settingUp ? "connector.settingUp" : "connector.signingIn")} {name(flow.providerId)}
					</p>
					{flow.events.map((event, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: events are append-only and never reordered
						<FlowEvent key={`${event.kind}-${i}`} event={event} openUrl={openUrl} />
					))}
					{flow.prompt ? <FlowPrompt key={flow.prompt.message} prompt={flow.prompt} send={send} /> : null}
					{busy && !flow.prompt && flow.events.length === 0 ? (
						<p className="muted">{t("connector.starting")}</p>
					) : null}
					{flow.done ? (
						<p className={`auth-result ${flow.done.ok ? "ok" : "failed"}`} role="status">
							{flow.done.ok
								? `${t("connector.connectedTo")} ${name(flow.providerId)}.`
								: (flow.done.message ?? t("connector.failed"))}
						</p>
					) : null}
					<div className="auth-actions">
						{busy && flow.flowId ? (
							<button
								type="button"
								onClick={() => send({ type: "auth_reply", flowId: flow.flowId ?? "", cancelled: true })}
							>
								{t("connector.cancel")}
							</button>
						) : null}
						{flow.done ? (
							<button type="button" onClick={() => dispatch({ type: "connectors", open: true })}>
								{t("connector.backToList")}
							</button>
						) : null}
					</div>
				</div>
			) : guided?.guide ? (
				<ConnectorGuideView
					connector={guided}
					openUrl={openUrl}
					back={() => setGuideFor(undefined)}
					next={() => start(guided, "connector_connect")}
					canChange={appSend !== undefined}
				/>
			) : (
				<>
					<div className="connector-actions">
						<button type="button" onClick={() => setAdding(!adding)} aria-expanded={adding}>
							{t("connector.add")}
						</button>
						<button type="button" onClick={() => send({ type: "connectors_scan" })}>
							{t("connector.scan")}
						</button>
					</div>
					{adding ? (
						<AddAnother
							cancel={() => setAdding(false)}
							ask={(what) => {
								send({ type: "send", text: addConnectorRequest(what) });
								setAdding(false);
								dispatch({ type: "connectors", open: false });
							}}
						/>
					) : null}
					{connectors.imports ? (
						<ImportList
							found={connectors.imports}
							{...(appSend
								? { importServers: (ids: string[]) => appSend({ type: "connector_import", ids }) }
								: {})}
							close={() => dispatch({ type: "connector_imports_closed" })}
						/>
					) : null}
					<ul className="providers">
						{computer ? (
							<ComputerEntry
								controls={computer}
								{...withInfo(connectors.list?.find((c) => c.builtin && c.id === "computer"))}
							/>
						) : null}
						{voiceModel ? <VoiceModelEntry /> : null}
						{/* Built-in entries are the desktop app's; the web page never shows them. */}
						{(connectors.list ?? [])
							.filter((c) => !c.builtin)
							.map((connector) => (
								<ConnectorRow
									key={connector.id}
									connector={connector}
									{...(appSend ? { appSend } : {})}
									connect={() =>
										connector.guide && !connector.added
											? setGuideFor(connector.id)
											: start(connector, "connector_connect")
									}
									signIn={() => start(connector, "connector_signin")}
									setUp={() => start(connector, "connector_setup")}
								/>
							))}
					</ul>
				</>
			)}
		</section>
	);
}

const withInfo = (info: ConnectorInfo | undefined) => (info ? { info } : {});

interface ConnectorGuideViewProps {
	connector: ConnectorInfo;
	openUrl: (url: string) => void;
	back: () => void;
	next: () => void;
	/** False outside the desktop app: the guide reads, but Continue cannot connect. */
	canChange: boolean;
}

/** The steps to create the app or bot the connector signs in with, before "Connect". */
function ConnectorGuideView({ connector: c, openUrl, back, next, canChange }: ConnectorGuideViewProps) {
	const { t } = useLocale();
	const guide = c.guide;
	if (!guide) return null;
	return (
		<section className="connector-guide" aria-label={`${t("connector.setup")} ${c.name}`}>
			<h3>
				{t("connector.setup")} {c.name}
			</h3>
			<ol>
				{guide.steps.map((step) => (
					<li key={step} className="connector-step">
						{step}
					</li>
				))}
			</ol>
			{guide.redirectUrl ? (
				<div className="connector-redirect">
					<span>{t("connector.redirect")}</span>
					<code>{guide.redirectUrl}</code>
				</div>
			) : null}
			<div className="connector-links">
				{guide.links.map((link) => (
					<button key={link.url} type="button" className="link" onClick={() => openUrl(link.url)}>
						{t("connector.open")} {link.label}
					</button>
				))}
			</div>
			{guide.note ? <p className="connector-note">{guide.note}</p> : null}
			<div className="auth-actions">
				<button type="button" onClick={back}>
					{t("connector.back")}
				</button>
				<button type="button" className="primary" disabled={!canChange} onClick={next}>
					{t("connector.continue")}
				</button>
			</div>
		</section>
	);
}

function AddAnother({ ask, cancel }: { ask: (what: string) => void; cancel: () => void }) {
	const { t } = useLocale();
	const [what, setWhat] = useState("");
	return (
		<form
			className="auth-step ask-form connector-add"
			onSubmit={(event) => {
				event.preventDefault();
				if (what.trim()) ask(what.trim());
			}}
		>
			<label>
				<span>{t("connector.question")}</span>
				<input
					type="text"
					autoComplete="off"
					placeholder={t("connector.example")}
					value={what}
					onChange={(event) => setWhat(event.target.value)}
				/>
			</label>
			<p className="connector-note">{t("connector.draftNote")}</p>
			<div className="auth-actions">
				<button type="submit" className="primary" disabled={!what.trim()}>
					{t("connector.ask")}
				</button>
				<button type="button" onClick={cancel}>
					{t("connector.cancel")}
				</button>
			</div>
		</form>
	);
}

interface ImportListProps {
	found: ImportCandidate[];
	/** Missing outside the desktop app: the list reads, but nothing can be imported. */
	importServers?: (ids: string[]) => void;
	close: () => void;
}

/** What the scan found in the user's other apps: names only, one checkbox each. */
function ImportList({ found, importServers, close }: ImportListProps) {
	const { t } = useLocale();
	const [chosen, setChosen] = useState<string[]>([]);
	const toggle = (id: string) =>
		setChosen((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));
	const count = chosen.length;
	return (
		<section className="connector-imports" aria-label={t("connector.found")}>
			<h3>{t("connector.found")}</h3>
			{found.length === 0 ? (
				<p className="muted">{t("connector.none")}</p>
			) : (
				<>
					<p className="connector-note">{t("connector.importNote")}</p>
					<ul>
						{found.map((candidate) => (
							<li key={candidate.id} className="connector-found">
								<label className="connector-import">
									<input
										type="checkbox"
										aria-label={candidate.name}
										disabled={!candidate.importable}
										checked={chosen.includes(candidate.id)}
										onChange={() => toggle(candidate.id)}
									/>
									<b>{candidate.name}</b>
									<span className="muted">
										{t("connector.from")} {candidate.sources.join(", ")}
									</span>
								</label>
								{candidate.summary ? <code>{candidate.summary}</code> : null}
								<ImportNames
									label={t("connector.keys")}
									names={[...candidate.envNames, ...candidate.headerNames]}
								/>
								<ImportNames label={t("connector.inputs")} names={candidate.inputs} />
								{candidate.notes?.map((note) => (
									<p key={note} className="connector-note">
										{note}
									</p>
								))}
								{candidate.duplicateOf ? (
									<p className="connector-note">
										{t("connector.duplicate")} {candidate.duplicateOf}.
									</p>
								) : candidate.reason ? (
									<p className="connector-note">{candidate.reason}</p>
								) : null}
							</li>
						))}
					</ul>
				</>
			)}
			<div className="auth-actions">
				{found.length > 0 ? (
					<button
						type="button"
						className="primary"
						disabled={count === 0 || !importServers}
						onClick={() => importServers?.(chosen)}
					>
						{count === 0
							? t("connector.import")
							: `${t("connector.import")} ${count} ${t(count === 1 ? "connector.server" : "connector.servers")}`}
					</button>
				) : null}
				<button type="button" onClick={close}>
					{t("connector.closeList")}
				</button>
			</div>
		</section>
	);
}

function ImportNames({ label, names }: { label: string; names: string[] }) {
	if (names.length === 0) return null;
	return (
		<p className="connector-names">
			<span className="muted">{label}:</span>
			{names.map((name) => (
				<span key={name} className="chip">
					{name}
				</span>
			))}
		</p>
	);
}

interface ConnectorRowProps {
	connector: ConnectorInfo;
	/** Missing outside the desktop app: every control is disabled. */
	appSend?: Send;
	connect: () => void;
	signIn: () => void;
	setUp: () => void;
}

function ConnectorRow({ connector: c, appSend, connect, signIn, setUp }: ConnectorRowProps) {
	const { t } = useLocale();
	const locked = !appSend;
	const nameId = `connector-${c.id}`;
	const readOnlyNote = c.custom ? t("connector.hiddenTools") : t("connector.cannotSend");
	const canSignIn = c.enabled && !c.noSignIn && c.status !== "needs_setup";
	return (
		<li aria-labelledby={nameId}>
			<div className="provider-name">
				<b id={nameId}>{c.name}</b>
				{c.added ? <span className={`chip connector-${c.status}`}>{t(STATUS_LABELS[c.status])}</span> : null}
			</div>
			{c.custom ? (
				<p className="connector-origin">
					<span>{c.custom.origin}</span>
					<code>{c.custom.summary}</code>
				</p>
			) : null}
			<p className="connector-note">{c.reads}</p>
			<p className="connector-note">{c.mode === "read_write" ? c.sends : readOnlyNote}</p>
			{c.enabled ? (
				<fieldset className="connector-mode">
					<legend>{t("connector.mayDo").replace("{name}", () => c.name)}</legend>
					{(
						[
							["read_only", t("connector.readOnly")],
							["read_write", t("connector.readWrite")],
						] as const
					).map(([mode, label]) => (
						<label key={mode}>
							<input
								type="radio"
								name={`mode-${c.id}`}
								checked={c.mode === mode}
								disabled={locked}
								onChange={() => appSend?.({ type: "connector_mode", connectorId: c.id, mode })}
							/>
							{label}
						</label>
					))}
				</fieldset>
			) : null}
			<div className="provider-actions">
				{c.enabled ? null : (
					<button
						type="button"
						className="primary"
						aria-label={`${t("connector.connect")} ${c.name}`}
						disabled={locked}
						onClick={connect}
					>
						{t("connector.connect")}
					</button>
				)}
				{c.enabled && c.status === "needs_setup" ? (
					<button
						type="button"
						className="primary"
						aria-label={`${t("connector.setup")} ${c.name}`}
						disabled={locked}
						onClick={setUp}
					>
						{t("connector.setup")}
					</button>
				) : null}
				{canSignIn && c.status !== "connected" ? (
					<button
						type="button"
						className="primary"
						aria-label={`${t("connector.signinTo")} ${c.name}`}
						disabled={locked}
						onClick={signIn}
					>
						{t("connector.signin")}
					</button>
				) : null}
				{canSignIn && c.status === "connected" ? (
					<button
						type="button"
						aria-label={t("connector.signinAgainLabel").replace("{name}", () => c.name)}
						disabled={locked}
						onClick={signIn}
					>
						{t("connector.signinAgain")}
					</button>
				) : null}
				{c.enabled ? (
					<button
						type="button"
						aria-label={`${t("connector.disconnect")} ${c.name}`}
						disabled={locked}
						onClick={() => appSend?.({ type: "connector_disconnect", connectorId: c.id })}
					>
						{t("connector.disconnect")}
					</button>
				) : null}
				{c.added ? (
					<button
						type="button"
						className="link"
						aria-label={`${t("connector.remove")} ${c.name}`}
						disabled={locked}
						onClick={() => appSend?.({ type: "connector_remove", connectorId: c.id })}
					>
						{t("connector.remove")}
					</button>
				) : null}
			</div>
		</li>
	);
}
