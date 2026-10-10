import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { formatSize } from "../uploads.ts";
import type { AttachmentControls, PendingFile } from "../useAttachments.ts";
import type { VoiceControls } from "../useVoice.ts";
import { MicIcon, PaperclipIcon, SendIcon } from "./icons.tsx";
import { newRequestId, type Send } from "./types.ts";

interface ComposerProps {
	busy: boolean;
	disabled: boolean;
	send: Send;
	/** Changes to this value move focus to the text box. */
	focusKey?: number;
	/** Called when the text box goes from empty to having text. */
	onStartTyping?: () => void;
	/** Talking to the assistant (S30.4); without it there is no mic. */
	voice?: VoiceControls;
	/** Files for the message (S31.1); without it there is no attach button. */
	attachments?: AttachmentControls;
}

export function Composer({
	busy,
	disabled,
	send,
	focusKey,
	onStartTyping,
	voice,
	attachments,
}: ComposerProps) {
	const [text, setText] = useState("");
	/** The last message could not go out; its text and files stay for another try (#21). */
	const [refused, setRefused] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const recording = voice?.phase === "recording";
	const voiceStatus = voice?.phase === "transcribing" ? "Transcribing…" : voice?.note;

	// A dictation to review joins what was already typed, and the cursor waits at its end.
	const draft = voice?.draft;
	const draftTaken = voice?.draftTaken;
	useEffect(() => {
		if (!draft || !draftTaken) return;
		setText((current) => (current.trim() ? `${current.trimEnd()} ${draft.text}` : draft.text));
		draftTaken(draft.id);
		requestAnimationFrame(() => {
			const input = box.current;
			if (!input) return;
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		});
	}, [draft, draftTaken]);

	useEffect(() => {
		if (focusKey !== undefined) box.current?.focus();
	}, [focusKey]);

	const files = attachments?.files ?? [];
	const uploading = attachments?.uploading === true;
	const blocked = files.some((f) => f.refused);

	async function submit() {
		const value = text.trim();
		if ((!value && files.length === 0) || disabled || uploading || blocked) return;
		// Files upload on send; a failed one keeps the message so sending again retries it.
		const refs = files.length > 0 ? await attachments?.upload() : undefined;
		if (files.length > 0 && !refs) return;
		const message = { type: "send", text: value, requestId: newRequestId() } as const;
		if (send(refs ? { ...message, attachments: refs } : message) === false) {
			setRefused(true);
			return;
		}
		setRefused(false);
		attachments?.clear();
		voice?.sent();
		setText("");
	}

	/** A pasted image becomes an attachment; pasted text stays text. */
	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		if (!attachments) return;
		const images = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
		if (images.length === 0) return;
		event.preventDefault();
		attachments.add(images);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit();
		}
	}

	return (
		<>
			{refused ? (
				<p className="voice-status" role="alert" aria-label="Not sent">
					Not connected, so the message was not sent. It is kept here to send again.
				</p>
			) : null}
			{voiceStatus ? (
				<p className="voice-status" role="status" aria-label="Voice">
					{voiceStatus}
				</p>
			) : null}
			{attachments && files.length > 0 ? (
				<ul className="attachment-chips" aria-label="Files to send">
					{files.map((file) => (
						<FileChip
							key={file.id}
							file={file}
							locked={uploading}
							remove={() => attachments.remove(file.id)}
						/>
					))}
				</ul>
			) : null}
			<form
				className="composer"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				{attachments && !recording ? (
					<label className="composer-attach" title="Attach files">
						<PaperclipIcon />
						<input
							type="file"
							multiple
							aria-label="Attach files"
							className="visually-hidden"
							disabled={disabled || uploading}
							onChange={(event) => {
								attachments.add(Array.from(event.target.files ?? []));
								// The same file can be picked again after removing it.
								event.target.value = "";
							}}
						/>
					</label>
				) : null}
				{recording ? (
					<div className="voice-recording">
						<span className="voice-time" role="timer" aria-label="Recording time">
							{formatElapsed(voice.elapsed)}
						</span>
						<meter
							className="voice-meter"
							aria-label="Microphone level"
							min={0}
							max={1}
							value={voice.level}
						/>
						<span className="voice-partial">{voice.partial || "Listening…"}</span>
						<button
							type="button"
							role="switch"
							aria-checked={voice.sendOnStop}
							className={`voice-send-option${voice.sendOnStop ? " on" : ""}`}
							onClick={() => voice.setSendOnStop(!voice.sendOnStop)}
						>
							Send when I stop
						</button>
						<button
							type="button"
							className="voice-cancel"
							aria-label="Cancel recording"
							title="Cancel (Esc)"
							onClick={voice.cancel}
						>
							✕
						</button>
					</div>
				) : (
					<textarea
						ref={box}
						aria-label="Message"
						placeholder={busy ? "Add to what I'm doing…" : "Ask me anything…"}
						rows={1}
						value={text}
						disabled={disabled}
						onChange={(event) => {
							if (text === "" && event.target.value !== "") onStartTyping?.();
							setText(event.target.value);
						}}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
					/>
				)}
				{busy || voice?.speaking ? (
					<button
						type="button"
						className="composer-stop"
						onClick={() => {
							if (busy) send({ type: "abort" });
							voice?.stopSpeaking();
						}}
					>
						Stop
					</button>
				) : null}
				{voice?.mic ? (
					<button
						type="button"
						className={`composer-mic${recording ? " composer-mic-on" : ""}`}
						aria-label={recording ? (voice.sendOnStop ? "Stop and send" : "Stop and review") : "Talk"}
						title={
							voice.mic.available
								? voice.sendOnStop
									? "Tap to talk, tap again to send"
									: "Tap to talk, tap again to review before sending"
								: voice.mic.reason
						}
						disabled={disabled || !voice.mic.available || voice.phase === "transcribing"}
						onClick={recording ? voice.stop : voice.start}
					>
						<MicIcon />
					</button>
				) : null}
				{recording ? null : (
					<button
						type="submit"
						className="composer-send"
						disabled={disabled || uploading || blocked || (text.trim() === "" && files.length === 0)}
						aria-label="Send"
						title="Send"
					>
						<SendIcon />
					</button>
				)}
			</form>
		</>
	);
}

/** One attached file: name, size, upload progress, and why it cannot be sent. */
function FileChip({ file, locked, remove }: { file: PendingFile; locked: boolean; remove: () => void }) {
	const name = file.file.name;
	const problem = file.refused ?? file.error;
	return (
		<li className={`attachment-chip${problem ? " attachment-chip-error" : ""}`}>
			<span className="chip-name" title={name}>
				{name}
			</span>
			<span className="chip-size">{formatSize(file.file.size)}</span>
			{file.progress !== undefined ? (
				<progress className="chip-progress" aria-label={`Uploading ${name}`} max={1} value={file.progress} />
			) : null}
			{problem ? (
				<span className="chip-error" role="alert">
					{problem}
				</span>
			) : null}
			<button
				type="button"
				className="chip-remove"
				aria-label={`Remove ${name}`}
				disabled={locked}
				onClick={remove}
			>
				×
			</button>
		</li>
	);
}

function formatElapsed(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
