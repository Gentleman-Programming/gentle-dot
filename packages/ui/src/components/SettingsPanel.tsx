import { useCallback, useEffect, useRef, useState } from "react";
import {
	formatShortcut,
	isMac,
	loadShortcut,
	recordKey,
	type ShortcutInfo,
	saveShortcut,
} from "../shortcut.ts";
import { setVoiceLanguage, VOICE_LANGUAGES, voiceLanguage } from "../voice-language.ts";
import "../settings.css";

type Status =
	| { kind: "idle" }
	| { kind: "recording" }
	| { kind: "applying"; shortcut: string }
	| { kind: "applied" }
	| { kind: "failed"; reason: string };

function reasonOf(error: unknown): string {
	if (typeof error === "string" && error) return error;
	if (error instanceof Error && error.message) return error.message;
	return "Gentle Dot could not change the shortcut.";
}

/** The desktop panel's settings (S33.1); for now, the shortcut that opens the panel. */
export function SettingsPanel({ close }: { close: () => void }) {
	const [language, setLanguage] = useState(() => voiceLanguage() ?? "");
	const mac = isMac();
	const show = (accelerator: string) => formatShortcut(accelerator, mac);
	const [info, setInfo] = useState<ShortcutInfo | undefined>(undefined);
	const [loadFailed, setLoadFailed] = useState(false);
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const live = useRef(true);
	const prompt = useRef<HTMLSpanElement>(null);

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
							onClick={() => setStatus({ kind: "recording" })}
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
