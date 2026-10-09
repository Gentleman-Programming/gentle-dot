import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { VoiceControls } from "../useVoice.ts";
import { MicIcon, SendIcon } from "./icons.tsx";
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
}

export function Composer({ busy, disabled, send, focusKey, onStartTyping, voice }: ComposerProps) {
	const [text, setText] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);
	const recording = voice?.phase === "recording";
	const voiceStatus = voice?.phase === "transcribing" ? "Transcribing…" : voice?.note;

	useEffect(() => {
		if (focusKey !== undefined) box.current?.focus();
	}, [focusKey]);

	function submit() {
		const value = text.trim();
		if (!value || disabled) return;
		send({ type: "send", text: value, requestId: newRequestId() });
		voice?.typed();
		setText("");
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<>
			{voiceStatus ? (
				<p className="voice-status" role="status" aria-label="Voice">
					{voiceStatus}
				</p>
			) : null}
			<form
				className="composer"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
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
						aria-label={recording ? "Stop and send" : "Talk"}
						title={voice.mic.available ? "Tap to talk, tap again to send" : voice.mic.reason}
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
						disabled={disabled || text.trim() === ""}
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

function formatElapsed(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
