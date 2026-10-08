import type { ConnectorDraft } from "@gentle-dot/protocol";
import { useEffect, useRef } from "react";
import type { Send } from "./types.ts";

/**
 * A connector the assistant drafted. Every detail is shown; only "Add" adds it, read only with all
 * of its tools hidden, and its secrets are then asked in the Connectors screen.
 */
export function ConnectorDraftCard({
	draft,
	send,
	approved,
}: {
	draft: ConnectorDraft;
	send: Send;
	approved: () => void;
}) {
	const card = useRef<HTMLElement>(null);
	useEffect(() => {
		card.current?.scrollIntoView?.({ block: "nearest" });
	}, []);
	const answer = (approve: boolean) =>
		send({ type: "connector_draft_reply", draftId: draft.draftId, approve });
	const runs = draft.transport === "http" ? draft.url : [draft.command, ...(draft.args ?? [])].join(" ");

	return (
		<section ref={card} className="ask-card connector-draft" aria-label={`Add ${draft.name}?`}>
			<p className="eyebrow">New connector</p>
			<p className="ask-title">Add {draft.name}?</p>
			{draft.description ? <p className="connector-note">{draft.description}</p> : null}
			<dl className="connector-draft-details">
				<dt>{draft.transport === "http" ? "Address" : "Runs on this computer"}</dt>
				<dd>
					<code>{runs}</code>
				</dd>
				<dt>Secrets it needs</dt>
				<dd>
					{draft.envNames.length > 0
						? draft.envNames.map((name) => (
								<span key={name} className="chip">
									{name}
								</span>
							))
						: "None"}
				</dd>
				{draft.needsOAuth ? (
					<>
						<dt>Sign-in</dt>
						<dd>You sign in on the service's own page.</dd>
					</>
				) : null}
			</dl>
			<p className="connector-note">
				You type each secret in the app, never in the chat. It starts read only, with all of its tools hidden.
			</p>
			<div className="ask-options">
				<button
					type="button"
					className="primary"
					onClick={() => {
						answer(true);
						approved();
					}}
				>
					Add {draft.name}
				</button>
				<button type="button" onClick={() => answer(false)}>
					Decline
				</button>
			</div>
		</section>
	);
}
