import type { Activity, ActivityKind } from "@gentle-dot/protocol";
import { Fragment, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../store.ts";

const VERBS: Record<ActivityKind, [string, string, string]> = {
	read: ["Read", "file", "files"],
	edit: ["Edited", "file", "files"],
	run: ["Ran", "command", "commands"],
	search: ["Searched", "time", "times"],
	memory: ["Used memory", "time", "times"],
	delegate: ["Asked", "helper", "helpers"],
	other: ["Did", "step", "steps"],
};

/** "Read 2 files · Ran 1 command" */
export function summarize(activities: Activity[]): string {
	const counts = new Map<ActivityKind, number>();
	for (const activity of activities) counts.set(activity.kind, (counts.get(activity.kind) ?? 0) + 1);
	return [...counts]
		.map(([kind, count]) => {
			const [verb, one, many] = VERBS[kind];
			return `${verb} ${count} ${count === 1 ? one : many}`;
		})
		.join(" · ");
}

function Activities({ activities }: { activities: Activity[] }) {
	const [open, setOpen] = useState(false);
	const running = activities.find((a) => a.status === "running");
	return (
		<div className="activities">
			<button
				type="button"
				className="activities-summary"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<span className={running ? "pulse" : ""} aria-hidden="true" />
				{running ? running.title : summarize(activities)}
			</button>
			{open ? (
				<ul>
					{activities.map((a) => (
						<li key={a.id} className={`activity activity-${a.status}`}>
							{a.title}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

interface MessageListProps {
	messages: ChatMessage[];
	/** Messages waiting for the assistant, shown after the running answer. */
	queued?: string[];
	/** Offers "Show earlier" at the top, which calls `onShowEarlier`. */
	hasEarlier?: boolean;
	onShowEarlier?: () => void;
}

export function MessageList({ messages, queued = [], hasEarlier = false, onShowEarlier }: MessageListProps) {
	const end = useRef<HTMLDivElement>(null);
	const last = messages.at(-1);
	const lastEarlier = messages.findLastIndex((m) => m.earlier);
	// Earlier pages are added on top, so only the newest message moves the view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the newest content grows
	useEffect(() => {
		end.current?.scrollIntoView?.({ block: "end" });
	}, [last?.id, last?.text, last?.activities.length, last?.note, queued.length]);

	if (messages.length === 0 && queued.length === 0) {
		return (
			<div className="empty">
				<p>Hi! What can I do for you?</p>
			</div>
		);
	}
	return (
		<div className="messages" aria-live="polite">
			{hasEarlier ? (
				<button type="button" className="show-earlier" onClick={onShowEarlier}>
					Show earlier
				</button>
			) : null}
			{messages.map((message, index) => (
				<Fragment key={message.id}>
					<article className={`message message-${message.role}`}>
						{message.activities.length > 0 ? <Activities activities={message.activities} /> : null}
						{message.text && message.role === "user" ? (
							<div className="message-body message-plain">{message.text}</div>
						) : null}
						{message.text && message.role === "assistant" ? (
							<div className="message-body">
								<Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
							</div>
						) : null}
						{message.streaming ? <span className="caret" aria-hidden="true" /> : null}
						{message.note ? (
							<p
								className={`message-note message-note-${message.note.kind}`}
								role={message.note.kind === "error" ? "alert" : undefined}
							>
								{message.note.text}
							</p>
						) : null}
					</article>
					{index === lastEarlier ? (
						<div className="earlier-divider">
							<hr aria-label="Earlier messages" />
							<span aria-hidden="true">Earlier messages</span>
							<span className="earlier-line" />
						</div>
					) : null}
				</Fragment>
			))}
			{queued.map((text, i) => (
				<article
					// biome-ignore lint/suspicious/noArrayIndexKey: the same text can be queued twice
					key={`${i}-${text}`}
					className="message message-user message-queued"
					aria-label="Queued message"
				>
					<span className="queued-label">Queued</span>
					<div className="message-body message-plain">{text}</div>
				</article>
			))}
			<div ref={end} />
		</div>
	);
}
