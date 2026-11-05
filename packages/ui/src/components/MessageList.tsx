import type { Activity, ActivityKind, AgentState } from "@gentle-dot/protocol";
import { Fragment, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../store.ts";
import { formatSize } from "../uploads.ts";

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

const LONG_WAIT_SECONDS = 60;

/** Seconds as "1:23". */
function formatWait(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the chat shows between sending a message and the answer's first words. */
function WaitingIndicator({ label }: { label: string }) {
	const [seconds, setSeconds] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	return (
		<div className="waiting" role="status">
			<span className="state-dot state-thinking" aria-hidden="true" />
			<span>{label}</span>
			<span className="waiting-time">{formatWait(seconds)}</span>
			{seconds >= LONG_WAIT_SECONDS ? (
				<p className="waiting-hint">Still waiting on the model. You can stop and pick another one.</p>
			) : null}
		</div>
	);
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
	/** Shows a waiting line while the assistant has nothing to display yet. */
	agentState?: AgentState;
}

export function MessageList({
	messages,
	queued = [],
	hasEarlier = false,
	onShowEarlier,
	agentState,
}: MessageListProps) {
	const end = useRef<HTMLDivElement>(null);
	const last = messages.at(-1);
	const lastEarlier = messages.findLastIndex((m) => m.earlier);
	const answering = last?.streaming === true && last.text !== "";
	const waiting = (agentState === "thinking" || agentState === "working") && !answering;
	// Earlier pages are added on top, so only the newest message moves the view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the newest content grows
	useEffect(() => {
		end.current?.scrollIntoView?.({ block: "end" });
	}, [last?.id, last?.text, last?.activities.length, last?.note, queued.length, waiting]);

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
						{message.attachments && message.attachments.length > 0 ? (
							<ul className="message-attachments" aria-label="Attached files">
								{message.attachments.map((file, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: two files may share a name across folders
									<li key={i} className="attachment-chip">
										<span className="chip-name" title={file.name}>
											{file.name}
										</span>
										<span className="chip-size">{formatSize(file.size)}</span>
									</li>
								))}
							</ul>
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
			{waiting ? <WaitingIndicator label={agentState === "working" ? "Working…" : "Thinking…"} /> : null}
			<div ref={end} />
		</div>
	);
}
