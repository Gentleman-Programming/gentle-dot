import { APP_REQUIRED, type ConnectorDraft } from "@gentle-dot/protocol";
import { useEffect, useRef } from "react";
import { useLocale } from "../i18n.tsx";
import type { Send } from "./types.ts";

/**
 * A connector the assistant drafted. Every detail is shown; only "Add" adds it, read only with all
 * of its tools hidden, and its secrets are then asked in the Connectors screen. Adding goes through
 * the desktop app (`appSend`, S25.2), which confirms it natively; any window may decline.
 */
export function ConnectorDraftCard({
	draft,
	send,
	appSend,
	approved,
}: {
	draft: ConnectorDraft;
	send: Send;
	appSend?: Send;
	approved: () => void;
}) {
	const { t } = useLocale();
	const title = t("connector.draftTitle").replace("{name}", () => draft.name);
	const card = useRef<HTMLElement>(null);
	useEffect(() => {
		card.current?.scrollIntoView?.({ block: "nearest" });
	}, []);
	const decline = () => send({ type: "connector_draft_reply", draftId: draft.draftId, approve: false });
	const runs = draft.transport === "http" ? draft.url : [draft.command, ...(draft.args ?? [])].join(" ");

	return (
		<section ref={card} className="ask-card connector-draft" aria-label={title}>
			<p className="eyebrow">{t("connector.draftNew")}</p>
			<p className="ask-title">{title}</p>
			{draft.description ? <p className="connector-note">{draft.description}</p> : null}
			<dl className="connector-draft-details">
				<dt>{t(draft.transport === "http" ? "connector.draftAddress" : "connector.draftRuns")}</dt>
				<dd>
					<code>{runs}</code>
				</dd>
				<dt>{t("connector.draftSecrets")}</dt>
				<dd>
					{draft.envNames.length > 0
						? draft.envNames.map((name) => (
								<span key={name} className="chip">
									{name}
								</span>
							))
						: t("connector.draftNone")}
				</dd>
				{draft.needsOAuth ? (
					<>
						<dt>{t("connector.draftSignin")}</dt>
						<dd>{t("connector.draftSigninHelp")}</dd>
					</>
				) : null}
			</dl>
			<p className="connector-note">{t("connector.draftPrivacy")}</p>
			{appSend ? null : <p className="connector-note">{APP_REQUIRED}</p>}
			<div className="ask-options">
				<button
					type="button"
					className="primary"
					disabled={!appSend}
					onClick={() => {
						appSend?.({ type: "connector_draft_reply", draftId: draft.draftId, approve: true });
						approved();
					}}
				>
					{t("connector.draftAdd").replace("{name}", () => draft.name)}
				</button>
				<button type="button" onClick={decline}>
					{t("connector.draftDecline")}
				</button>
			</div>
		</section>
	);
}
