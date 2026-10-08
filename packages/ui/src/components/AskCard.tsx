import type { Ask } from "@gentle-dot/protocol";
import { useState } from "react";
import type { Send } from "./types.ts";

export function AskCard({ ask, send }: { ask: Ask; send: Send }) {
	const [value, setValue] = useState(ask.prefill ?? "");
	const answer = (fields: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
		send({ type: "ui_response", requestId: ask.requestId, ...fields });

	return (
		<section className="ask-card" aria-label="The assistant needs your answer">
			<p className="ask-title">{ask.title}</p>
			{ask.message ? <p className="ask-message">{ask.message}</p> : null}
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
