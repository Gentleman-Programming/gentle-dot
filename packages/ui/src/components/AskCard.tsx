import type { Ask, PinStatus } from "@gentle-dot/protocol";
import { useEffect, useRef, useState } from "react";
import { PinForm } from "./PinForm.tsx";
import type { Send } from "./types.ts";

/** `pin`: the web PIN on a server (S25.8), for approvals allowed with it. */
export function AskCard({ ask, send, pin }: { ask: Ask; send: Send; pin?: PinStatus }) {
	const [value, setValue] = useState(ask.prefill ?? "");
	const card = useRef<HTMLElement>(null);
	// A question that arrives below a long conversation must be seen.
	useEffect(() => {
		card.current?.scrollIntoView?.({ block: "nearest" });
	}, []);
	const answer = (fields: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
		send({ type: "ui_response", requestId: ask.requestId, ...fields });

	// The desktop app asks this one in a native dialog (S25.3); here it only shows that it waits.
	if (ask.method === "app") {
		return (
			<section ref={card} className="ask-card" aria-label="Waiting for your answer in the app">
				<p className="eyebrow">Needs your answer</p>
				<p className="ask-title">{ask.title}</p>
				{ask.message ? <p className="connector-note">{ask.message}</p> : null}
			</section>
		);
	}

	// On a server, an approval is allowed with the web PIN (S25.8); declining needs none.
	if (ask.method === "pin") {
		return (
			<section ref={card} className="ask-card" aria-label="The assistant needs your answer">
				<p className="eyebrow">Needs your answer</p>
				<p className="ask-title">{ask.title}</p>
				{ask.message ? (
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					<section className="ask-message" aria-label="Details" tabIndex={0}>
						{ask.message}
					</section>
				) : null}
				<PinForm
					pin={pin ?? { set: true }}
					action="Allow"
					onPin={(value, created) => {
						if (created) send({ type: "pin_set", pin: value });
						send({ type: "pin_approve", requestId: ask.requestId, pin: value });
					}}
				>
					<button type="button" onClick={() => answer({ confirmed: false })}>
						Deny
					</button>
				</PinForm>
			</section>
		);
	}

	return (
		<section ref={card} className="ask-card" aria-label="The assistant needs your answer">
			<p className="eyebrow">Needs your answer</p>
			<p className="ask-title">{ask.title}</p>
			{/* The whole text the user approves; long previews scroll inside the card. */}
			{ask.message ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				<section className="ask-message" aria-label="Details" tabIndex={0}>
					{ask.message}
				</section>
			) : null}
			{ask.method === "select" ? (
				<div className="ask-options">
					{(ask.options ?? []).map((option) => (
						<button key={option} type="button" onClick={() => answer({ value: option })}>
							{option}
						</button>
					))}
				</div>
			) : null}
			{ask.method === "confirm" ? (
				<div className="ask-options">
					<button type="button" className="primary" onClick={() => answer({ confirmed: true })}>
						Yes
					</button>
					<button type="button" onClick={() => answer({ confirmed: false })}>
						No
					</button>
				</div>
			) : null}
			{ask.method === "input" || ask.method === "editor" ? (
				<form
					className="ask-form"
					onSubmit={(event) => {
						event.preventDefault();
						answer({ value });
					}}
				>
					{ask.method === "editor" ? (
						<textarea
							aria-label={ask.title}
							rows={6}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					) : (
						<input
							aria-label={ask.title}
							placeholder={ask.placeholder ?? ""}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					)}
					<button type="submit" className="primary">
						Send answer
					</button>
				</form>
			) : null}
			<button type="button" className="ask-skip" onClick={() => answer({ cancelled: true })}>
				Skip
			</button>
		</section>
	);
}
