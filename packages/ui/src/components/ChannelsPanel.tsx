import type { ChannelInfo } from "@gentle-dot/protocol";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { ChannelsState, DotAction } from "../store.ts";
import "../accounts.css";
import "../channels.css";
import type { Send } from "./types.ts";

interface ChannelsPanelProps {
	channels: ChannelsState;
	send: Send;
	/**
	 * Channel changes, through the desktop app (S25.2) or the web PIN. Without it the lists still
	 * show, but every change is disabled with a note.
	 */
	appSend?: Send;
	dispatch: (action: DotAction) => void;
}

const STATUS_LABELS: Record<ChannelInfo["status"], string> = {
	off: "Off",
	pairing: "Pairing",
	connected: "Connected",
	error: "Error",
};

/** The honest preview shown before pairing starts (S8 of odd/tasks/channels-ux.md). */
export const PAIR_PREVIEW =
	"This channel can send WhatsApp messages on your behalf; every send by the assistant still goes through your approval.";

const CHANGES_NOTE = "Open the Gentle Dot app (or use your PIN) to change channels.";

type Step = "overview" | "provider" | "allowlist" | "pair";

/** The Channels screen (§8 of the dot-whatsapp study): register and observe the WhatsApp bridge. */
export function ChannelsPanel({ channels, send, appSend, dispatch }: ChannelsPanelProps) {
	const [step, setStep] = useState<Step>("overview");
	const [typed, setTyped] = useState("");
	const [confirmUnpair, setConfirmUnpair] = useState(false);
	const [qrDataUrl, setQrDataUrl] = useState<string>();
	const whatsapp = channels.list?.[0];
	const connected = whatsapp?.status === "connected";
	const pairing = step === "pair";

	// While the pairing step is open, poll the bridge for the live QR and state (S4).
	useEffect(() => {
		if (!pairing) return;
		send({ type: "channel_pair_status" });
		const timer = setInterval(() => send({ type: "channel_pair_status" }), 3_000);
		return () => clearInterval(timer);
	}, [pairing, send]);

	// A connected bridge leaves the wizard on its own.
	useEffect(() => {
		if (connected && pairing) setStep("overview");
	}, [connected, pairing]);

	// The QR payload is rendered client-side; the UI never receives full numbers (S7).
	useEffect(() => {
		const qr = channels.pair?.qr;
		if (!qr) {
			setQrDataUrl(undefined);
			return;
		}
		let live = true;
		QRCode.toDataURL(qr, { width: 320, margin: 2, errorCorrectionLevel: "L" }).then((url) => {
			if (live) setQrDataUrl(url);
		});
		return () => {
			live = false;
		};
	}, [channels.pair?.qr]);

	const startPairing = () => {
		if (!appSend) return;
		appSend({ type: "channel_pair_start" });
		setStep("pair");
	};

	return (
		<section className="accounts channels" aria-label="Channels">
			<header className="accounts-header">
				<h2>Channels</h2>
				<button
					type="button"
					className="icon"
					aria-label="Close channels"
					onClick={() => dispatch({ type: "channels", open: false })}
				>
					×
				</button>
			</header>
			<p className="muted">
				Doors where you talk to the assistant. The bridge is a separate process; the daemon never sees your
				full number.
			</p>
			{appSend ? null : <p className="connector-note">{CHANGES_NOTE}</p>}

			{step === "overview" ? (
				whatsapp ? (
					<div className="channel-card" data-status={whatsapp.status}>
						<div className="channel-card-head">
							<strong>WhatsApp</strong>
							<span className={`channel-badge status-${whatsapp.status}`}>
								{whatsapp.reachable ? STATUS_LABELS[whatsapp.status] : "Not running"}
							</span>
						</div>
						{whatsapp.maskedNumber ? <p className="muted">Linked as {whatsapp.maskedNumber}</p> : null}
						{whatsapp.lastActivityAt ? (
							<p className="muted">Last activity {new Date(whatsapp.lastActivityAt).toLocaleString()}</p>
						) : null}
						{whatsapp.errorReason ? <p className="channel-error">{whatsapp.errorReason}</p> : null}
						<div className="channel-actions">
							{whatsapp.status === "off" || !whatsapp.reachable ? (
								<button type="button" className="primary" onClick={() => setStep("provider")}>
									Set up
								</button>
							) : null}
							{appSend && connected ? (
								<button type="button" onClick={() => appSend({ type: "channel_verify" })}>
									Send test message
								</button>
							) : null}
							{(connected || whatsapp.status === "error") && appSend ? (
								confirmUnpair ? (
									<>
										<button
											type="button"
											className="danger"
											onClick={() => {
												appSend({ type: "channel_unpair" });
												setConfirmUnpair(false);
												setStep("overview");
											}}
										>
											Yes, unpair
										</button>
										<button type="button" onClick={() => setConfirmUnpair(false)}>
											Keep it
										</button>
									</>
								) : (
									<button type="button" className="danger-text" onClick={() => setConfirmUnpair(true)}>
										Unpair…
									</button>
								)
							) : null}
						</div>
						{channels.verify ? (
							<ul className="channel-verify">
								{channels.verify.map((result) => (
									<li key={result.masked}>
										{result.masked}: {result.ok ? "delivered" : "failed"}
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : (
					<p className="muted">No channel bridge answered. Start dot-whatsapp and reopen this panel.</p>
				)
			) : null}

			{step === "provider" ? (
				<div className="channel-step">
					<p className="auth-flow-title">Choose a provider</p>
					<button type="button" className="channel-option" onClick={() => setStep("allowlist")}>
						<span className="channel-option-title">🟢 Baileys (recommended)</span>
						<span className="muted">
							A dedicated number pairs with a QR. Free, no paperwork; human volume only.
						</span>
					</button>
					<div className="channel-option disabled" aria-disabled>
						<span className="channel-option-title">🔵 Meta Cloud API</span>
						<span className="muted">The official Business path. Coming soon.</span>
					</div>
					<button type="button" className="link" onClick={() => setStep("overview")}>
						Back
					</button>
				</div>
			) : null}

			{step === "allowlist" ? (
				<div className="channel-step">
					<p className="auth-flow-title">Allowed numbers</p>
					<p className="muted">Only these numbers may talk to the assistant. Changes apply right away.</p>
					<ul className="channel-numbers">
						{(channels.allowlist ?? []).map((masked) => (
							<li key={masked}>{masked}</li>
						))}
					</ul>
					<label className="channel-typed">
						<span className="muted">Full number, E.164 digits only (add it, or type it to remove it):</span>
						<input
							value={typed}
							onChange={(event) => setTyped(event.target.value)}
							placeholder="5491112345678"
							inputMode="numeric"
						/>
					</label>
					<div className="channel-actions">
						{appSend ? (
							<>
								<button
									type="button"
									className="primary"
									disabled={typed.trim() === ""}
									onClick={() => {
										appSend({ type: "channel_allowlist_change", action: "add", number: typed.trim() });
										setTyped("");
									}}
								>
									Add
								</button>
								<button
									type="button"
									disabled={typed.trim() === ""}
									onClick={() => {
										appSend({ type: "channel_allowlist_change", action: "remove", number: typed.trim() });
										setTyped("");
									}}
								>
									Remove
								</button>
							</>
						) : null}
						<button type="button" className="link" onClick={() => setStep("provider")}>
							Back
						</button>
					</div>
					<p className="channel-preview">{PAIR_PREVIEW}</p>
					{appSend ? (
						<button type="button" className="primary" onClick={startPairing}>
							Start pairing
						</button>
					) : null}
				</div>
			) : null}

			{step === "pair" ? (
				<div className="channel-step channel-pair">
					<p className="auth-flow-title">Scan the QR</p>
					<p className="muted">WhatsApp on the bot's number → Linked devices → Link a device.</p>
					{channels.pair?.qr ? (
						<>
							{qrDataUrl ? (
								<img
									className="channel-qr"
									src={qrDataUrl}
									alt="WhatsApp pairing QR"
									width={280}
									height={280}
								/>
							) : (
								<div className="channel-qr placeholder" aria-hidden />
							)}
							<p className="muted">
								The QR refreshes in about {channels.pair.expiresInSec}s ({channels.pair.attempts} generated).
							</p>
						</>
					) : (
						<p className="muted">Waiting for the QR…</p>
					)}
					<div className="channel-actions">
						{appSend ? (
							<button type="button" onClick={() => appSend({ type: "channel_pair_regenerate" })}>
								Regenerate
							</button>
						) : null}
						<button
							type="button"
							onClick={() => {
								appSend?.({ type: "channel_pair_cancel" });
								setStep("overview");
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			) : null}
		</section>
	);
}
