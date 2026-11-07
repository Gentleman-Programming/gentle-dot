import { useCallback, useEffect, useState } from "react";
import { useLocale } from "../i18n.tsx";
import type { voiceEn } from "../i18n-voice-messages.ts";
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

const ENGINES: Record<VoiceModelStatus["engine"], keyof typeof voiceEn> = {
	parakeet: "voice.modelParakeet",
	apple: "voice.modelApple",
	none: "voice.modelNeeded",
};

/** The chip names the engine that listens now. */
const CHIPS: Record<VoiceModelStatus["engine"], keyof typeof voiceEn> = {
	parakeet: "voice.modelOffline",
	apple: "voice.modelMac",
	none: "voice.modelOff",
};

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

type Progress = { kind: "downloading"; percent: number } | { kind: "verifying" };

// Only an absent event message owns fallback copy; supplied messages are always raw.
type ModelError = { kind: "raw"; text: string } | { kind: "incomplete" };

/** The Voice entry in Connectors (desktop only): which engine listens, and the optional local model. */
export function VoiceModelEntry() {
	const { t } = useLocale();
	const [status, setStatus] = useState<VoiceModelStatus>();
	const [progress, setProgress] = useState<Progress>();
	const [error, setError] = useState<ModelError>();

	const refresh = useCallback(() => {
		voiceModelStatus().then(
			(next) => {
				// An app without the local model support answers nothing usable.
				if (!next || typeof next !== "object" || typeof next.engine !== "string") {
					setStatus(undefined);
					return;
				}
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
				if (event.state === "failed") {
					setError(event.message == null ? { kind: "incomplete" } : { kind: "raw", text: event.message });
				}
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
		action().catch((reason: unknown) =>
			setError({
				kind: "raw",
				text: typeof reason === "string" ? reason : String(reason),
			}),
		);
	};

	const errorText = error?.kind === "incomplete" ? t("voice.modelIncomplete") : error?.text;

	return (
		<li className="computer-entry" aria-labelledby="connector-voice">
			<div className="provider-name">
				<b id="connector-voice">{t("voice.modelTitle")}</b>
				{status ? <span className="chip connector-connected">{t(CHIPS[status.engine])}</span> : null}
			</div>
			{status ? <p className="connector-note">{t(ENGINES[status.engine])}</p> : null}
			<p className="connector-note">{t("voice.modelHelp")}</p>
			{progress?.kind === "downloading" ? (
				<div className="voice-model-progress">
					<progress aria-label={t("voice.modelProgress")} max={100} value={progress.percent} />
					<span>
						{t("voice.modelDownloading")} {progress.percent}%
					</span>
					<button type="button" onClick={() => act(cancelVoiceModel)}>
						{t("voice.modelCancel")}
					</button>
				</div>
			) : progress?.kind === "verifying" ? (
				<p className="connector-note">{t("voice.modelVerifying")}</p>
			) : status?.installed ? (
				<button type="button" onClick={() => act(removeVoiceModel)}>
					{t("voice.modelRemove")} ({megabytes(status.bytes ?? 0)})
				</button>
			) : status ? (
				<button type="button" className="primary" onClick={() => act(downloadVoiceModel)}>
					{t("voice.modelDownload")} ({megabytes(DOWNLOAD_BYTES)})
				</button>
			) : null}
			{errorText ? (
				<p className="connector-note voice-model-error" role="alert">
					{errorText}
				</p>
			) : null}
		</li>
	);
}
