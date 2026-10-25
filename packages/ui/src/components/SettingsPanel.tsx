import { useCallback, useEffect, useRef, useState } from "react";
import {
	formatShortcut,
	isMac,
	loadShortcut,
	loadVoiceShortcut,
	recordKey,
	type ShortcutInfo,
	saveShortcut,
	saveVoiceShortcut,
	type VoiceShortcutInfo,
} from "../shortcut.ts";
import { deviceLabel, deviceValue, missingChoice } from "../voice-device.ts";
import { setVoiceLanguage, VOICE_LANGUAGES, voiceLanguage } from "../voice-language.ts";
import { loadVoiceInputOptions, saveVoiceInput, type VoiceInputOptions } from "../voice-native.ts";
import "../settings.css";

type Status =
	| { kind: "idle" }
	| { kind: "recording" }
	| { kind: "applying"; shortcut: string }
	| { kind: "applied" }
	| { kind: "failed"; reason: string };

type SaveStatus =
	| { kind: "idle" }
	| { kind: "saving" }
	| { kind: "saved" }
	| { kind: "failed"; reason: string };

function reasonOf(error: unknown, fallback = "Gentle Dot could not change the shortcut."): string {
	if (typeof error === "string" && error) return error;
	if (error instanceof Error && error.message) return error.message;
	return fallback;
}

/** The desktop panel's settings (S33.1); for now, the shortcut that opens the panel. */
export function SettingsPanel({ close }: { close: () => void }) {
	const [language, setLanguage] = useState(() => voiceLanguage() ?? "");
	const mac = isMac();
	const show = (accelerator: string) => formatShortcut(accelerator, mac);
	const [info, setInfo] = useState<ShortcutInfo | undefined>(undefined);
	const [loadFailed, setLoadFailed] = useState(false);
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [voice, setVoice] = useState<VoiceShortcutInfo | undefined>(undefined);
	const [voiceLoadFailed, setVoiceLoadFailed] = useState(false);
	const [voiceStatus, setVoiceStatus] = useState<Status>({ kind: "idle" });
	const [input, setInput] = useState<VoiceInputOptions | undefined>(undefined);
	const [inputLoadFailed, setInputLoadFailed] = useState(false);
	const [inputStatus, setInputStatus] = useState<SaveStatus>({ kind: "idle" });
	const live = useRef(true);
	const prompt = useRef<HTMLSpanElement>(null);
	const voicePrompt = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		live.current = true;
		loadShortcut().then(
			(found) => {
				if (live.current) setInfo(found);
			},
			() => {
				if (live.current) setLoadFailed(true);
			},
		);
		loadVoiceShortcut().then(
			(found) => {
				if (live.current && found) setVoice(found);
			},
			() => {
				if (live.current) setVoiceLoadFailed(true);
			},
		);
		loadVoiceInputOptions().then(
			(found) => {
				if (live.current) setInput(found);
			},
			() => {
				if (live.current) setInputLoadFailed(true);
			},
		);
		return () => {
			live.current = false;
		};
	}, []);

	const apply = useCallback((accelerator: string) => {
		setStatus({ kind: "applying", shortcut: accelerator });
		saveShortcut(accelerator).then(
			(saved) => {
				if (!live.current) return;
				setInfo((current) => current && { ...current, shortcut: saved });
				setStatus({ kind: "applied" });
			},
			(error: unknown) => {
				if (live.current) setStatus({ kind: "failed", reason: reasonOf(error) });
			},
		);
	}, []);

	const recording = status.kind === "recording";
	useEffect(() => {
		if (!recording) return;
		prompt.current?.focus();
		// Captured before the panel's own keys: Esc here cancels recording instead of hiding the
		// panel, and ⌘⇧F is recorded instead of filling the screen (they skip handled keys).
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault();
			const recorded = recordKey(event);
			if (recorded.kind === "cancel") setStatus({ kind: "idle" });
			else if (recorded.kind === "shortcut") apply(recorded.accelerator);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [recording, apply]);

	const applying = status.kind === "applying";

	const applyVoice = useCallback((shortcut: string | null) => {
		setVoiceStatus({ kind: "applying", shortcut: shortcut ?? "" });
		saveVoiceShortcut(shortcut).then(
			(saved) => {
				if (!live.current) return;
				setVoice((current) => current && { ...current, shortcut: saved });
				setVoiceStatus({ kind: "applied" });
			},
			(error: unknown) => {
				if (live.current) setVoiceStatus({ kind: "failed", reason: reasonOf(error) });
			},
		);
	}, []);

	const voiceRecording = voiceStatus.kind === "recording";
	useEffect(() => {
		if (!voiceRecording) return;
		voicePrompt.current?.focus();
		// Captured before the panel's own keys, as in the shortcut above: Esc cancels, and a
		// combination is recorded instead of doing its usual job.
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault();
			const recorded = recordKey(event);
			if (recorded.kind === "cancel") setVoiceStatus({ kind: "idle" });
			else if (recorded.kind === "shortcut") applyVoice(recorded.accelerator);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [voiceRecording, applyVoice]);

	const applyInput = useCallback((uid: string | null) => {
		setInputStatus({ kind: "saving" });
		saveVoiceInput(uid).then(
			(chosen) => {
				if (!live.current) return;
				setInput((current) => current && { ...current, chosen });
				setInputStatus({ kind: "saved" });
			},
			(error: unknown) => {
				if (live.current)
					setInputStatus({
						kind: "failed",
						reason: reasonOf(error, "Gentle Dot could not change the microphone."),
					});
			},
		);
	}, []);

	const voiceApplying = voiceStatus.kind === "applying";
	const voiceOff = voice?.shortcut === null;
	const inputSaving = inputStatus.kind === "saving";
	return (
		<section className="accounts settings" aria-label="Settings">
			<header className="accounts-header">
				<h2>Settings</h2>
				<button type="button" className="icon" aria-label="Close settings" onClick={close}>
					×
				</button>
			</header>

			<section className="provider-section" aria-labelledby="settings-shortcut">
				<h3 id="settings-shortcut">Keyboard shortcut</h3>
				<p className="muted">Opens and hides the panel from any app.</p>
				{loadFailed ? (
					<p className="settings-error" role="alert">
						Gentle Dot could not read the current shortcut.
					</p>
				) : null}
				<div className="shortcut-row">
					{recording ? (
						<span ref={prompt} className="shortcut-recording" tabIndex={-1}>
							Press the new shortcut… Esc cancels.
						</span>
					) : (
						<kbd className="shortcut-keys">{info ? show(info.shortcut) : "…"}</kbd>
					)}
					{recording ? (
						<button type="button" onClick={() => setStatus({ kind: "idle" })}>
							Cancel
						</button>
					) : (
						<button
							type="button"
							className="primary"
							disabled={!info || applying}
							onClick={() => {
								setVoiceStatus({ kind: "idle" });
								setStatus({ kind: "recording" });
							}}
						>
							Change
						</button>
					)}
				</div>
				{status.kind === "applying" ? (
					<p className="muted" role="status">
						Applying {show(status.shortcut)}…
					</p>
				) : null}
				{status.kind === "applied" ? (
					<p className="settings-ok" role="status">
						Saved. It works right away.
					</p>
				) : null}
				{status.kind === "failed" ? (
					<p className="settings-error" role="alert">
						{status.reason}
					</p>
				) : null}
				<p className="settings-hint muted">
					Use at least one modifier key ({mac ? "⌘ ⌥ ⌃ ⇧" : "Super, Alt, Ctrl, Shift"}), or a function key.
				</p>
				<button
					type="button"
					className="link"
					title={info ? `Default: ${show(info.default)}` : undefined}
					disabled={!info || info.shortcut === info.default || applying || recording}
					onClick={() => info && apply(info.default)}
				>
					Reset to default
				</button>
			</section>

			<section className="provider-section" aria-labelledby="settings-voice-shortcut">
				<h3 id="settings-voice-shortcut">Voice shortcut</h3>
				<p className="muted">Hold to record a voice note from any app. Release to send it.</p>
				{voiceLoadFailed ? (
					<p className="settings-error" role="alert">
						Gentle Dot could not read the current voice shortcut.
					</p>
				) : null}
				<div className="shortcut-row">
					{voiceRecording ? (
						<span ref={voicePrompt} className="shortcut-recording" tabIndex={-1}>
							Press the new shortcut… Esc cancels.
						</span>
					) : (
						<kbd className="shortcut-keys">
							{!voice ? "…" : voice.shortcut === null ? "Off" : show(voice.shortcut)}
						</kbd>
					)}
					{voiceRecording ? (
						<button type="button" onClick={() => setVoiceStatus({ kind: "idle" })}>
							Cancel
						</button>
					) : (
						<>
							<button
								type="button"
								className="primary"
								disabled={!voice || voiceApplying}
								onClick={() => {
									setStatus({ kind: "idle" });
									setVoiceStatus({ kind: "recording" });
								}}
							>
								Change
							</button>
							{voice && !voiceOff ? (
								<button
									type="button"
									className="link"
									disabled={voiceApplying}
									onClick={() => applyVoice(null)}
								>
									Turn off
								</button>
							) : null}
						</>
					)}
				</div>
				{voiceStatus.kind === "applying" ? (
					<p className="muted" role="status">
						Applying {voiceStatus.shortcut ? show(voiceStatus.shortcut) : "the change"}…
					</p>
				) : null}
				{voiceStatus.kind === "applied" ? (
					<p className="settings-ok" role="status">
						Saved. It works right away.
					</p>
				) : null}
				{voiceStatus.kind === "failed" ? (
					<p className="settings-error" role="alert">
						{voiceStatus.reason}
					</p>
				) : null}
				<p className="settings-hint muted">
					Use at least one modifier key ({mac ? "⌘ ⌥ ⌃ ⇧" : "Super, Alt, Ctrl, Shift"}), or a function key.
				</p>
				<button
					type="button"
					className="link"
					title={voice ? `Default: ${show(voice.default)}` : undefined}
					disabled={!voice || voiceOff || voice.shortcut === voice.default || voiceApplying || voiceRecording}
					onClick={() => voice && applyVoice(voice.default)}
				>
					Reset to default
				</button>
			</section>

			<section className="provider-section" aria-labelledby="settings-microphone">
				<h3 id="settings-microphone">Microphone</h3>
				<p className="muted">
					The input the voice notes are recorded from. Changing it applies to the next recording.
				</p>
				{inputLoadFailed ? (
					<p className="settings-error" role="alert">
						Gentle Dot could not read the current microphone.
					</p>
				) : (
					<select
						aria-label="Microphone"
						value={input ? deviceValue(input) : ""}
						disabled={!input || inputSaving}
						onChange={(event) => applyInput(event.target.value || null)}
					>
						<option value="">System default</option>
						{input?.devices.map((device) => (
							<option key={device.uid} value={device.uid}>
								{deviceLabel(device)}
							</option>
						))}
					</select>
				)}
				{input && missingChoice(input) ? (
					<p className="settings-error" role="alert">
						The chosen microphone is not connected. The system default is used instead.
					</p>
				) : null}
				{inputStatus.kind === "saved" ? (
					<p className="settings-ok" role="status">
						Saved. It applies to the next recording.
					</p>
				) : null}
				{inputStatus.kind === "failed" ? (
					<p className="settings-error" role="alert">
						{inputStatus.reason}
					</p>
				) : null}
			</section>

			<section className="provider-section" aria-labelledby="settings-voice-language">
				<h3 id="settings-voice-language">Voice language</h3>
				<p className="muted">
					The language macOS speech listens in. The local voice model detects it by itself.
				</p>
				<select
					aria-label="Voice language"
					value={language}
					onChange={(event) => {
						setLanguage(event.target.value);
						setVoiceLanguage(event.target.value);
					}}
				>
					{VOICE_LANGUAGES.map(([locale, label]) => (
						<option key={locale || "auto"} value={locale}>
							{label}
						</option>
					))}
				</select>
			</section>
		</section>
	);
}
