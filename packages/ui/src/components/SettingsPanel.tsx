import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../i18n.tsx";
import type { UiLocale } from "../i18n-messages.ts";
import { loadMemory, type MemoryMode, saveMemory } from "../memory.ts";
import {
	formatShortcut,
	isMac,
	isWindows,
	loadShortcut,
	recordKey,
	type ShortcutInfo,
	saveShortcut,
} from "../shortcut.ts";
import { setVoiceLanguage, VOICE_LANGUAGES, voiceLanguage } from "../voice-language.ts";
import "../settings.css";
import { VoiceDevicesSettings } from "./VoiceDevicesSettings.tsx";

type Status =
	| { kind: "idle" }
	| { kind: "recording" }
	| { kind: "applying"; shortcut: string }
	| { kind: "applied" }
	| { kind: "failed"; reason?: string };

// Undefined marks an authored fallback, never a backend string matched by its contents.
function reasonOf(error: unknown): string | undefined {
	if (typeof error === "string" && error) return error;
	if (error instanceof Error && error.message) return error.message;
	return undefined;
}

/** The desktop panel's settings (S33.1): the panel shortcut, the memory mode, and the voice language. */
export function SettingsPanel({ close }: { close: () => void }) {
	const { locale, setLocale, t } = useLocale();
	const [language, setLanguage] = useState(() => voiceLanguage() ?? "");
	const mac = isMac();
	const show = (accelerator: string) => formatShortcut(accelerator, mac);
	const [info, setInfo] = useState<ShortcutInfo | undefined>(undefined);
	const [loadFailed, setLoadFailed] = useState(false);
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [memory, setMemory] = useState<MemoryMode | undefined>(undefined);
	const [memoryFailed, setMemoryFailed] = useState(false);
	const [memoryApplying, setMemoryApplying] = useState(false);
	const [memoryError, setMemoryError] = useState<{ reason?: string } | undefined>(undefined);
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
		loadMemory().then(
			(found) => {
				if (live.current) setMemory(found.memory);
			},
			() => {
				if (live.current) setMemoryFailed(true);
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

	const applyMemory = useCallback((next: MemoryMode) => {
		setMemoryApplying(true);
		setMemoryError(undefined);
		saveMemory(next).then(
			(saved) => {
				if (!live.current) return;
				setMemory(saved);
				setMemoryApplying(false);
			},
			(error: unknown) => {
				if (!live.current) return;
				setMemoryError({ reason: reasonOf(error) });
				setMemoryApplying(false);
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
		<section className="accounts settings" aria-label={t("settings")}>
			<header className="accounts-header">
				<h2>{t("settings")}</h2>
				<button type="button" className="icon" aria-label={t("closeSettings")} onClick={close}>
					×
				</button>
			</header>

			<section className="provider-section" aria-labelledby="settings-interface-language">
				<h3 id="settings-interface-language">{t("interfaceLanguage")}</h3>
				<select
					aria-label={t("interfaceLanguage")}
					value={locale}
					onChange={(event) => setLocale(event.target.value as UiLocale)}
				>
					<option value="en">English</option>
					<option value="es">Español</option>
				</select>
			</section>

			<section className="provider-section" aria-labelledby="settings-shortcut">
				<h3 id="settings-shortcut">{t("settings.shortcut")}</h3>
				<p className="muted">{t("settings.shortcutHelp")}</p>
				{loadFailed ? (
					<p className="settings-error" role="alert">
						{t("settings.shortcutLoadFailed")}
					</p>
				) : null}
				<div className="shortcut-row">
					{recording ? (
						<span ref={prompt} className="shortcut-recording" tabIndex={-1}>
							{t("settings.recording")}
						</span>
					) : (
						<kbd className="shortcut-keys">{info ? show(info.shortcut) : "…"}</kbd>
					)}
					{recording ? (
						<button type="button" onClick={() => setStatus({ kind: "idle" })}>
							{t("settings.cancel")}
						</button>
					) : (
						<button
							type="button"
							className="primary"
							disabled={!info || applying}
							onClick={() => setStatus({ kind: "recording" })}
						>
							{t("settings.change")}
						</button>
					)}
				</div>
				{status.kind === "applying" ? (
					<p className="muted" role="status">
						{t("settings.applying").replace("{shortcut}", () => show(status.shortcut))}
					</p>
				) : null}
				{status.kind === "applied" ? (
					<p className="settings-ok" role="status">
						{t("settings.saved")}
					</p>
				) : null}
				{status.kind === "failed" ? (
					<p className="settings-error" role="alert">
						{status.reason ?? t("settings.shortcutFailed")}
					</p>
				) : null}
				<p className="settings-hint muted">
					{t("settings.shortcutHint").replace("{modifiers}", () =>
						mac ? "⌘ ⌥ ⌃ ⇧" : "Super, Alt, Ctrl, Shift",
					)}
				</p>
				<button
					type="button"
					className="link"
					title={info ? t("settings.default").replace("{shortcut}", () => show(info.default)) : undefined}
					disabled={!info || info.shortcut === info.default || applying || recording}
					onClick={() => info && apply(info.default)}
				>
					{t("settings.reset")}
				</button>
			</section>

			<section className="provider-section" aria-labelledby="settings-memory">
				<h3 id="settings-memory">{t("settings.memory")}</h3>
				<p className="muted">{t("settings.memoryHelp")}</p>
				{memoryFailed ? (
					<p className="settings-error" role="alert">
						{t("settings.memoryLoadFailed")}
					</p>
				) : null}
				<label className="shortcut-row">
					<input
						type="checkbox"
						role="switch"
						aria-checked={memory === "private"}
						checked={memory === "private"}
						disabled={memory === undefined || memoryApplying}
						onChange={(event) => applyMemory(event.target.checked ? "private" : "shared")}
					/>
					<span>{t("settings.privateMemory")}</span>
				</label>
				{memoryError ? (
					<p className="settings-error" role="alert">
						{memoryError.reason ?? t("settings.memoryFailed")}
					</p>
				) : null}
			</section>

			<VoiceDevicesSettings />

			<section className="provider-section" aria-labelledby="settings-voice-language" hidden={isWindows()}>
				<h3 id="settings-voice-language">{t("settings.voiceLanguage")}</h3>
				<p className="muted">{t("settings.voiceLanguageHelp")}</p>
				<select
					aria-label={t("settings.voiceLanguage")}
					value={language}
					onChange={(event) => {
						setLanguage(event.target.value);
						setVoiceLanguage(event.target.value);
					}}
				>
					{VOICE_LANGUAGES.map(([locale, label]) => (
						<option key={locale || "auto"} value={locale}>
							{locale === "" ? t("settings.automaticLanguage") : label}
						</option>
					))}
				</select>
			</section>
		</section>
	);
}
