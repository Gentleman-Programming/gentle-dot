import type { ConnectorInfo, ConnectorStatus, ImportCandidate } from "@gentle-dot/protocol";
import { useState } from "react";
import type { ConnectorsState, DotAction } from "../store.ts";
import "../accounts.css";
import { FlowEvent, FlowPrompt } from "./AccountsPanel.tsx";
import type { Send } from "./types.ts";

interface ConnectorsPanelProps {
	connectors: ConnectorsState;
	send: Send;
	dispatch: (action: DotAction) => void;
	openUrl: (url: string) => void;
}

const STATUS_LABELS: Record<ConnectorStatus, string> = {
	off: "Off",
	needs_setup: "Needs setup",
	needs_signin: "Needs sign-in",
	connected: "Connected",
	error: "Sign-in failed",
};

/** What the chat says for "Add another connector"; the assistant answers with a draft to review. */
export const addConnectorRequest = (what: string) =>
	`Please help me add a connector for ${what}. Find its MCP server and draft it for me to review.`;

/** The apps the assistant can use, each signed in from here and set to read only or read and send. */
export function ConnectorsPanel({ connectors, send, dispatch, openUrl }: ConnectorsPanelProps) {
	const [guideFor, setGuideFor] = useState<string>();
	const [adding, setAdding] = useState(false);
	const flow = connectors.flow;
	const busy = flow !== undefined && flow.done === undefined;
	const name = (id: string) => connectors.list?.find((c) => c.id === id)?.name ?? id;
	const start = (
		connector: ConnectorInfo,
		type: "connector_connect" | "connector_signin" | "connector_setup",
	) => {
		setGuideFor(undefined);
		dispatch({ type: "connector_started", connectorId: connector.id });
		send({ type, connectorId: connector.id });
	};
	const guided = connectors.list?.find((c) => c.id === guideFor && c.guide);
	// Values are asked first; once the sign-in page is on its way, it is a sign-in.
	const settingUp = flow?.flowId?.startsWith("connector-setup-") && flow.events.length === 0;

	return (
		<section className="accounts connectors" aria-label="Connectors">
			<header className="accounts-header">
				<h2>Connectors</h2>
				<button
					type="button"
					className="icon"
					aria-label="Close connectors"
					onClick={() => dispatch({ type: "connectors", open: false })}
				>
					×
				</button>
			</header>
			<p className="muted">
				Let the assistant use your other apps. It always asks you before it sends or changes anything.
			</p>

			{flow ? (
				<div className="auth-flow">
					<p className="auth-flow-title">
						{settingUp ? "Setting up" : "Signing in to"} {name(flow.providerId)}
					</p>
					{flow.events.map((event, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: events are append-only and never reordered
						<FlowEvent key={`${event.kind}-${i}`} event={event} openUrl={openUrl} />
					))}
					{flow.prompt ? <FlowPrompt key={flow.prompt.message} prompt={flow.prompt} send={send} /> : null}
					{busy && !flow.prompt && flow.events.length === 0 ? <p className="muted">Starting…</p> : null}
					{flow.done ? (
						<p className={`auth-result ${flow.done.ok ? "ok" : "failed"}`} role="status">
							{flow.done.ok
								? `Connected to ${name(flow.providerId)}.`
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
							<button type="button" onClick={() => dispatch({ type: "connectors", open: true })}>
								Back to connectors
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
				/>
			) : (
				<>
					<div className="connector-actions">
						<button type="button" onClick={() => setAdding(!adding)} aria-expanded={adding}>
							Add another connector
						</button>
						<button type="button" onClick={() => send({ type: "connectors_scan" })}>
							Import my MCP servers
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
							importServers={(ids) => send({ type: "connector_import", ids })}
							close={() => dispatch({ type: "connector_imports_closed" })}
						/>
					) : null}
					<ul className="providers">
						{(connectors.list ?? []).map((connector) => (
							<ConnectorRow
								key={connector.id}
								connector={connector}
								send={send}
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

interface ConnectorGuideViewProps {
	connector: ConnectorInfo;
	openUrl: (url: string) => void;
	back: () => void;
	next: () => void;
}

/** The steps to create the app or bot the connector signs in with, before "Connect". */
function ConnectorGuideView({ connector: c, openUrl, back, next }: ConnectorGuideViewProps) {
	const guide = c.guide;
	if (!guide) return null;
	return (
		<section className="connector-guide" aria-label={`Set up ${c.name}`}>
			<h3>Set up {c.name}</h3>
			<ol>
				{guide.steps.map((step) => (
					<li key={step} className="connector-step">
						{step}
					</li>
				))}
			</ol>
			{guide.redirectUrl ? (
				<div className="connector-redirect">
					<span>Redirect URL to add</span>
					<code>{guide.redirectUrl}</code>
				</div>
			) : null}
			<div className="connector-links">
				{guide.links.map((link) => (
					<button key={link.url} type="button" className="link" onClick={() => openUrl(link.url)}>
						Open {link.label}
					</button>
				))}
			</div>
			{guide.note ? <p className="connector-note">{guide.note}</p> : null}
			<div className="auth-actions">
				<button type="button" onClick={back}>
					Back
				</button>
				<button type="button" className="primary" onClick={next}>
					Continue
				</button>
			</div>
		</section>
	);
}

function AddAnother({ ask, cancel }: { ask: (what: string) => void; cancel: () => void }) {
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
				<span>What do you want to connect?</span>
				<input
					type="text"
					autoComplete="off"
					placeholder="For example GitHub or Jira"
					value={what}
					onChange={(event) => setWhat(event.target.value)}
				/>
			</label>
			<p className="connector-note">
				The assistant looks for its server and sends you a draft. Nothing is added until you approve it.
			</p>
			<div className="auth-actions">
				<button type="submit" className="primary" disabled={!what.trim()}>
					Ask the assistant
				</button>
				<button type="button" onClick={cancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

interface ImportListProps {
	found: ImportCandidate[];
	importServers: (ids: string[]) => void;
	close: () => void;
}

/** What the scan found in the user's other apps: names only, one checkbox each. */
function ImportList({ found, importServers, close }: ImportListProps) {
	const [chosen, setChosen] = useState<string[]>([]);
	const toggle = (id: string) =>
		setChosen((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));
	const count = chosen.length;
	return (
		<section className="connector-imports" aria-label="Found these servers">
			<h3>Found these servers</h3>
			{found.length === 0 ? (
				<p className="muted">No MCP servers were found in your other apps.</p>
			) : (
				<>
					<p className="connector-note">
						Imported servers start read only, with all of their tools hidden. Their keys stay on this
						computer; your other apps are not changed.
					</p>
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
									<span className="muted">From {candidate.sources.join(", ")}</span>
								</label>
								{candidate.summary ? <code>{candidate.summary}</code> : null}
								<ImportNames label="Keys" names={[...candidate.envNames, ...candidate.headerNames]} />
								<ImportNames label="You will type" names={candidate.inputs} />
								{candidate.notes?.map((note) => (
									<p key={note} className="connector-note">
										{note}
									</p>
								))}
								{candidate.duplicateOf ? (
									<p className="connector-note">Already in your connectors as {candidate.duplicateOf}.</p>
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
						disabled={count === 0}
						onClick={() => importServers(chosen)}
					>
						{count === 0 ? "Import" : `Import ${count} server${count === 1 ? "" : "s"}`}
					</button>
				) : null}
				<button type="button" onClick={close}>
					Close the list
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
	send: Send;
	connect: () => void;
	signIn: () => void;
	setUp: () => void;
}

function ConnectorRow({ connector: c, send, connect, signIn, setUp }: ConnectorRowProps) {
	const nameId = `connector-${c.id}`;
	const readOnlyNote = c.custom
		? "Its tools stay hidden until you choose Read and send. Then it asks you before every action."
		: "It cannot send or change anything.";
	const canSignIn = c.enabled && !c.noSignIn && c.status !== "needs_setup";
	return (
		<li aria-labelledby={nameId}>
			<div className="provider-name">
				<b id={nameId}>{c.name}</b>
				{c.added ? <span className={`chip connector-${c.status}`}>{STATUS_LABELS[c.status]}</span> : null}
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
					<legend>What {c.name} may do</legend>
					{(
						[
							["read_only", "Read only"],
							["read_write", "Read and send"],
						] as const
					).map(([mode, label]) => (
						<label key={mode}>
							<input
								type="radio"
								name={`mode-${c.id}`}
								checked={c.mode === mode}
								onChange={() => send({ type: "connector_mode", connectorId: c.id, mode })}
							/>
							{label}
						</label>
					))}
				</fieldset>
			) : null}
			<div className="provider-actions">
				{c.enabled ? null : (
					<button type="button" className="primary" aria-label={`Connect ${c.name}`} onClick={connect}>
						Connect
					</button>
				)}
				{c.enabled && c.status === "needs_setup" ? (
					<button type="button" className="primary" aria-label={`Set up ${c.name}`} onClick={setUp}>
						Set up
					</button>
				) : null}
				{canSignIn && c.status !== "connected" ? (
					<button type="button" className="primary" aria-label={`Sign in to ${c.name}`} onClick={signIn}>
						Sign in
					</button>
				) : null}
				{canSignIn && c.status === "connected" ? (
					<button type="button" aria-label={`Sign in to ${c.name} again`} onClick={signIn}>
						Sign in again
					</button>
				) : null}
				{c.enabled ? (
					<button
						type="button"
						aria-label={`Disconnect ${c.name}`}
						onClick={() => send({ type: "connector_disconnect", connectorId: c.id })}
					>
						Disconnect
					</button>
				) : null}
				{c.added ? (
					<button
						type="button"
						className="link"
						aria-label={`Remove ${c.name}`}
						onClick={() => send({ type: "connector_remove", connectorId: c.id })}
					>
						Remove
					</button>
				) : null}
			</div>
		</li>
	);
}
