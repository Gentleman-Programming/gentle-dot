import type { RecordingNoteDisplay } from "./i18n-voice-messages.ts";
import { VoiceFailure } from "./voice-failures.ts";

export type DiagnosticStage =
	| "starting"
	| "recording"
	| "final-buffer"
	| "loading"
	| "decoding"
	| "complete"
	| "load-failed"
	| "decode-failed"
	| "worker-failed"
	| "failed"
	| "transcribing";
export interface VoiceDiagnostic {
	diagnosticToken?: string;
	route: "native" | "daemon";
	stage: DiagnosticStage;
	pcmSamples: number | null;
	sampleRate: number | null;
	compressedBytes: number | null;
}
export interface CheckObserver {
	readonly diagnosticToken?: string;
	level(value: number): void;
	preview(text: string): void;
	metadata(value: VoiceDiagnostic): void;
	complete(): void;
	error(message: string, display?: CheckNoteDisplay): void;
}
export interface CheckLease {
	stop(): void;
	cancel(): Promise<void>;
}
export interface CheckDriver {
	input(observer: CheckObserver): CheckLease;
	output(observer: CheckObserver): CheckLease;
}
/** Renderer-only ownership; note remains the original default-English/raw value. */
export type CheckNoteDisplay =
	| "input-unknown"
	| "input-failed"
	| "input-complete"
	| "output-complete"
	| "unavailable"
	| "failed"
	| "cleanup-failed"
	| RecordingNoteDisplay;
export interface CheckState {
	kind: "idle" | "input" | "output" | "done" | "failed";
	level: number;
	preview: string;
	diagnostic: VoiceDiagnostic | null;
	note: string;
	noteDisplay?: CheckNoteDisplay;
}
const nativeStages = new Set([
	"final-buffer",
	"loading",
	"decoding",
	"complete",
	"load-failed",
	"decode-failed",
	"worker-failed",
	"failed",
]);
export function validDiagnosticToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function validateNativeDiagnostic(value: unknown): VoiceDiagnostic | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (v.route !== "native" || typeof v.stage !== "string" || !nativeStages.has(v.stage)) return null;
	if (
		v.pcmSamples === null
			? v.sampleRate !== null
			: !Number.isSafeInteger(v.pcmSamples) || (v.pcmSamples as number) < 0 || v.sampleRate !== 16000
	)
		return null;
	if (v.diagnosticToken !== undefined && !validDiagnosticToken(v.diagnosticToken)) return null;
	return {
		...(v.diagnosticToken === undefined ? {} : { diagnosticToken: v.diagnosticToken as string }),
		route: "native",
		stage: v.stage as DiagnosticStage,
		pcmSamples: v.pcmSamples as number | null,
		sampleRate: v.sampleRate as number | null,
		compressedBytes: null,
	};
}

/** One in-memory check. The driver is the existing hook, never an independent capture pipeline. */
export function createVoiceChecks(driver: () => CheckDriver | undefined) {
	let state: CheckState = { kind: "idle", level: 0, preview: "", diagnostic: null, note: "" };
	let generation = 0;
	let lease: CheckLease | undefined;
	let retiring: Promise<void> | undefined;
	// Lazy, ephemeral identity; no storage, device identity or authority. Never reused.
	let session: string | undefined;
	const listeners = new Set<() => void>();
	const update = (patch: Partial<CheckState>) => {
		state = { ...state, ...patch };
		for (const fn of [...listeners]) fn();
	};
	function start(kind: "input" | "output") {
		if (retiring || lease) return false;
		const id = ++generation;
		if (kind === "input") session ??= globalThis.crypto.randomUUID();
		const diagnosticToken = kind === "input" ? `${session}-${id}` : undefined;
		update({ kind, level: 0, preview: "", diagnostic: null, note: "", noteDisplay: undefined });
		const current = () => id === generation;
		let ended = false;
		let native = false;
		let resultReceived = false;
		let terminal: DiagnosticStage | undefined;
		const failed = (stage: DiagnosticStage) => stage.endsWith("failed");
		const classify = () =>
			update({
				kind: terminal && failed(terminal) ? "failed" : "done",
				level: 0,
				note: !terminal
					? "Input stopped. Final recognition metadata is unknown until available."
					: failed(terminal)
						? "Input recognition failed; see the failure stage."
						: "Input check finished. Preview is not sent to chat.",
				noteDisplay: !terminal ? "input-unknown" : failed(terminal) ? "input-failed" : "input-complete",
			});
		const finish = (note: string, failed = false, noteDisplay?: CheckNoteDisplay) => {
			if (!current()) return;
			ended = true;
			lease = undefined;
			++generation;
			update({ kind: failed ? "failed" : "done", level: 0, note, noteDisplay });
		};
		let unavailable = false;
		try {
			const active = driver();
			if (!active) {
				unavailable = true;
				throw new Error("Voice checks are unavailable until the voice lifecycle is ready.");
			}
			const next = active[kind]({
				diagnosticToken,
				level: (value) => {
					if (current() && Number.isFinite(value)) update({ level: Math.max(0, Math.min(1, value)) });
				},
				preview: (text) => {
					if (current()) update({ preview: text.slice(0, 16000) });
				},
				metadata: (value) => {
					if (!current()) return;
					if (value.route === "native" && value.stage !== "starting" && value.stage !== "recording") {
						const checked = validateNativeDiagnostic(value);
						if (!native || !checked || checked.diagnosticToken !== diagnosticToken) return;
						// Final/failure evidence cannot be erased by reordered progress or success.
						if (terminal && (failed(terminal) || !failed(checked.stage))) return;
						if (checked.stage === "complete" || failed(checked.stage)) terminal = checked.stage;
						value = checked;
					} else {
						if (resultReceived || terminal) return;
						native = value.route === "native";
					}
					// Correlation is intentionally excluded from displayable diagnostic state.
					update({
						diagnostic: {
							route: value.route,
							stage: value.stage,
							pcmSamples: value.pcmSamples,
							sampleRate: value.sampleRate,
							compressedBytes: value.compressedBytes,
						},
					});
					if (resultReceived) classify();
				},
				complete: () => {
					if (!current()) return;
					if (kind === "input" && native) {
						ended = true;
						resultReceived = true;
						lease = undefined;
						classify(); // Retain only this check's bounded late-metadata callback.
					} else
						finish(
							kind === "input"
								? "Input check finished. Preview is not sent to chat."
								: "Playback completed. Please confirm you could hear the test phrase on the intended device.",
							false,
							kind === "input" ? "input-complete" : "output-complete",
						);
				},
				error: (message, display) => finish(message, true, display),
			});
			if (!ended) lease = next;
			return !ended || state.kind !== "failed";
		} catch (error) {
			finish(
				error instanceof Error ? error.message : typeof error === "string" ? error : "Voice check failed.",
				true,
				unavailable
					? "unavailable"
					: error instanceof VoiceFailure
						? error.display
						: error instanceof Error || typeof error === "string"
							? undefined
							: "failed",
			);
			return false;
		}
	}
	async function cancel() {
		if (retiring) return retiring;
		++generation;
		const old = lease;
		lease = undefined;
		update({ kind: "idle", preview: "", level: 0, diagnostic: null, note: "", noteDisplay: undefined });
		if (old) {
			retiring = Promise.resolve()
				.then(() => old.cancel())
				.catch(() => {
					update({
						kind: "failed",
						note: "Voice cleanup failed. Wait for the active recording to retire.",
						noteDisplay: "cleanup-failed",
					});
				});
			await retiring;
			retiring = undefined;
		}
	}
	return {
		read: () => state,
		start,
		stop: () => lease?.stop(),
		cancel,
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
	};
}
