import type { ConnectorInfo, ConnectorStatus } from "@gentle-dot/protocol";
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
	needs_signin: "Needs sign-in",
	connected: "Connected",
	error: "Sign-in failed",
};

/** The apps the assistant can use, each signed in from here and set to read only or read and send. */
export function ConnectorsPanel({ connectors, send, dispatch, openUrl }: ConnectorsPanelProps) {
	const flow = connectors.flow;
	const busy = flow !== undefined && flow.done === undefined;
	const name = (id: string) => connectors.list?.find((c) => c.id === id)?.name ?? id;
	const startSignIn = (connector: ConnectorInfo, type: "connector_connect" | "connector_signin") => {
		dispatch({ type: "connector_started", connectorId: connector.id });
		send({ type, connectorId: connector.id });
	};

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
					<p className="auth-flow-title">Signing in to {name(flow.providerId)}</p>
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
			) : (
				<ul className="providers">
					{(connectors.list ?? []).map((connector) => (
						<ConnectorRow
							key={connector.id}
							connector={connector}
							send={send}
							connect={() => startSignIn(connector, "connector_connect")}
							signIn={() => startSignIn(connector, "connector_signin")}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

interface ConnectorRowProps {
	connector: ConnectorInfo;
	send: Send;
	connect: () => void;
	signIn: () => void;
}

function ConnectorRow({ connector: c, send, connect, signIn }: ConnectorRowProps) {
	const nameId = `connector-${c.id}`;
	return (
		<li aria-labelledby={nameId}>
			<div className="provider-name">
				<b id={nameId}>{c.name}</b>
				{c.added ? <span className={`chip connector-${c.status}`}>{STATUS_LABELS[c.status]}</span> : null}
			</div>
			<p className="connector-note">{c.reads}</p>
			<p className="connector-note">
				{c.mode === "read_write" ? c.sends : "It cannot send or change anything."}
			</p>
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
				{c.enabled && c.status !== "connected" ? (
					<button type="button" className="primary" aria-label={`Sign in to ${c.name}`} onClick={signIn}>
						Sign in
					</button>
				) : null}
				{c.enabled && c.status === "connected" ? (
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
