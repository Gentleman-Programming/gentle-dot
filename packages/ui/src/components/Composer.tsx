import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { newRequestId, type Send } from "./types.ts";

interface ComposerProps {
	busy: boolean;
	disabled: boolean;
	send: Send;
	/** Changes to this value move focus to the text box. */
	focusKey?: number;
}

export function Composer({ busy, disabled, send, focusKey }: ComposerProps) {
	const [text, setText] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (focusKey !== undefined) box.current?.focus();
	}, [focusKey]);

	function submit() {
		const value = text.trim();
		if (!value || disabled) return;
		send({ type: "send", text: value, requestId: newRequestId() });
		setText("");
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<textarea
				ref={box}
				aria-label="Message"
				placeholder={busy ? "Add to what I'm doing…" : "Ask me anything…"}
				rows={1}
				value={text}
				disabled={disabled}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			{busy ? (
				<button type="button" className="composer-stop" onClick={() => send({ type: "abort" })}>
					Stop
				</button>
			) : null}
			<button
				type="submit"
				className="composer-send"
				disabled={disabled || text.trim() === ""}
				aria-label="Send"
			>
				↑
			</button>
		</form>
	);
}
