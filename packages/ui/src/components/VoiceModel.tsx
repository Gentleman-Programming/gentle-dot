import { useCallback, useEffect, useState } from "react";
import {
	cancelVoiceModel,
	downloadVoiceModel,
	onVoiceModel,
	removeVoiceModel,
	type VoiceModelEvent,
	type VoiceModelStatus,
	voiceModelStatus,
} from "../voice-native.ts";

/** The archive's size (pinned in the desktop app), shown before anything downloads. */
const DOWNLOAD_BYTES = 487_170_055;

const ENGINES: Record<VoiceModelStatus["engine"], string> = {
	parakeet: "Using: local model (Parakeet), works offline",
	apple: "Using: macOS speech",
	none: "Voice input needs the local model on this computer",
};

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

type Progress = { kind: "downloading"; percent: number } | { kind: "verifying" };

/** The Voice entry in Connectors (desktop only): which engine listens, and the optional local model. */
export function VoiceModelEntry() {
	const [status, setStatus] = useState<VoiceModelStatus>();
	const [progress, setProgress] = useState<Progress>();
	const [error, setError] = useState<string>();

	const refresh = useCallback(() => {
		voiceModelStatus().then(
			(next) => {
				setStatus(next);
				if (next.downloading) {
					const percent = next.total ? Math.floor(((next.received ?? 0) / next.total) * 100) : 0;
					setProgress({ kind: "downloading", percent });
				}
			},
			() => setStatus(undefined),
		);
	}, []);

	useEffect(() => {
		refresh();
		let stop: (() => void) | undefined;
		let closed = false;
		const handle = (event: VoiceModelEvent) => {
			if (event.state === "downloading") {
				const percent = event.total ? Math.floor(((event.received ?? 0) / event.total) * 100) : 0;
				setError(undefined);
				setProgress({ kind: "downloading", percent });
			} else if (event.state === "verifying") {
				setProgress({ kind: "verifying" });
			} else {
				setProgress(undefined);
				if (event.state === "failed") setError(event.message ?? "The download did not finish.");
				refresh();
			}
		};
		onVoiceModel(handle).then(
			(unlisten) => {
				if (closed) unlisten();
				else stop = unlisten;
			},
			() => {},
		);
		return () => {
			closed = true;
			stop?.();
		};
	}, [refresh]);

	const act = (action: () => Promise<void>) => {
		setError(undefined);
		action().catch((reason: unknown) => setError(typeof reason === "string" ? reason : String(reason)));
	};

	return (
		<li className="computer-entry" aria-labelledby="connector-voice">
			<div className="provider-name">
				<b id="connector-voice">Voice</b>
				<span className="chip connector-connected">Built in</span>
			</div>
			{status ? <p className="connector-note">{ENGINES[status.engine]}</p> : null}
			<p className="connector-note">
				The local model (NVIDIA Parakeet) understands 25 languages, including Spanish, and never sends your
				voice anywhere. It is optional: nothing downloads until you ask.
			</p>
			{progress?.kind === "downloading" ? (
				<div className="voice-model-progress">
					<progress aria-label="Downloading the local voice model" max={100} value={progress.percent} />
					<span>Downloading… {progress.percent}%</span>
					<button type="button" onClick={() => act(cancelVoiceModel)}>
						Cancel
					</button>
				</div>
			) : progress?.kind === "verifying" ? (
				<p className="connector-note">Checking and unpacking…</p>
			) : status?.installed ? (
				<button type="button" onClick={() => act(removeVoiceModel)}>
					Remove local model ({megabytes(status.bytes ?? 0)})
				</button>
			) : status ? (
				<button type="button" className="primary" onClick={() => act(downloadVoiceModel)}>
					Download local voice model ({megabytes(DOWNLOAD_BYTES)})
				</button>
			) : null}
			{error ? (
				<p className="connector-note voice-model-error" role="alert">
					{error}
				</p>
			) : null}
		</li>
	);
}
