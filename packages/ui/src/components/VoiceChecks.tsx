import { useEffect, useState } from "react";
import { useLocale } from "../i18n.tsx";
import { recordingNoteKeys, type voiceEn } from "../i18n-voice-messages.ts";
import type { VoiceDeviceRuntime } from "../voice-device-runtime.ts";
import type { CheckNoteDisplay } from "../voice-diagnostics.ts";

const NOTE_KEYS: Record<CheckNoteDisplay, keyof typeof voiceEn> = {
	...recordingNoteKeys,
	"input-unknown": "voice.checkInputUnknown",
	"input-failed": "voice.checkInputFailed",
	"input-complete": "voice.checkInputComplete",
	"output-complete": "voice.checkOutputComplete",
	unavailable: "voice.checkUnavailable",
	failed: "voice.checkFailed",
	"cleanup-failed": "voice.checkCleanupFailed",
};

/** Mounting only subscribes. Media actions require one of the labelled buttons. */
export function VoiceChecks({ runtime }: { runtime: VoiceDeviceRuntime }) {
	const { t } = useLocale();
	const [state, setState] = useState(runtime.checks.read);
	useEffect(() => {
		setState(runtime.checks.read());
		const off = runtime.checks.subscribe(() => setState(runtime.checks.read()));
		return () => {
			off();
			void runtime.checks.cancel();
		};
	}, [runtime]);
	const active = state.kind === "input" || state.kind === "output";
	const metadata = state.diagnostic;
	return (
		<section className="provider-section" aria-label={t("voice.verification")}>
			<h3>{t("voice.check")}</h3>
			<p className="muted">{t("voice.checkHelp")}</p>
			<div className="shortcut-row">
				<button type="button" disabled={active} onClick={() => runtime.checks.start("input")}>
					{t("voice.checkInput")}
				</button>
				<button type="button" disabled={active} onClick={() => runtime.checks.start("output")}>
					{t("voice.checkOutput")}
				</button>
				<button type="button" disabled={!active} onClick={() => runtime.checks.stop()}>
					{t("voice.stopCheck")}
				</button>
				<button
					type="button"
					disabled={!active}
					onClick={() => {
						void runtime.checks.cancel();
					}}
				>
					{t("voice.cancelCheck")}
				</button>
			</div>
			<p className="muted">
				{t("voice.testPhrase")} “Hello, this is the Gentle Dot voice output check.” {t("voice.phraseHelp")}
			</p>
			{state.kind === "input" ? (
				<label>
					{t("voice.inputLevel")}{" "}
					<meter aria-label={t("voice.checkLevel")} min={0} max={1} value={state.level} />
				</label>
			) : null}
			{metadata ? (
				<p role="status">
					{t("voice.route")} {metadata.route}. {t("voice.stage")} {metadata.stage}
					{"."} {t("voice.samples")} {metadata.pcmSamples ?? t("voice.unknown")}
					{"."} {t("voice.sampleRate")} {metadata.sampleRate ?? t("voice.unknown")}
					{"."} {t("voice.bytes")} {metadata.compressedBytes ?? t("voice.unavailable")}.
				</p>
			) : null}
			{state.preview ? (
				<section aria-label={t("voice.preview")}>
					<p>{state.preview}</p>
				</section>
			) : null}
			{state.note ? (
				<p role={state.kind === "failed" ? "alert" : "status"}>
					{state.noteDisplay ? t(NOTE_KEYS[state.noteDisplay]) : state.note}
				</p>
			) : null}
		</section>
	);
}
