import { useState } from "react";
import { openUrl as openExternal } from "../desktop.ts";
import { activeTitle, type DotAction, type DotState, isBusy, needsAccount } from "../store.ts";
import { AccountsPanel } from "./AccountsPanel.tsx";
import { AskCard } from "./AskCard.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { ProfilesPanel } from "./ProfilesPanel.tsx";
import { newRequestId, type Send } from "./types.ts";

interface ChatSurfaceProps {
	variant: "web" | "panel";
	state: DotState;
	send: Send;
	dismiss: (id: number) => void;
	onHide?: () => void;
	focusKey?: number;
	dispatch?: (action: DotAction) => void;
	openUrl?: (url: string) => void;
}

const CONTINUE_TEXT = "Continue where you left off.";

function statusText(state: DotState): string | undefined {
	if (state.connection === "unauthorized") {
		return "This access key is not valid anymore. Open the page again from the Gentle Dot menu (Open in browser).";
	}
	if (state.connection === "closed") return "Reconnecting to the assistant…";
	if (state.connection === "connecting") return "Connecting…";
	if (state.agentState === "restarting") return "The assistant is restarting…";
	if (state.agentState === "starting") return "Starting the assistant…";
	return undefined;
}

export function ChatSurface({
	variant,
	state,
	send,
	dismiss,
	onHide,
	focusKey,
	dispatch = () => {},
	openUrl = openExternal,
}: ChatSurfaceProps) {
	const openAccounts = () => {
		send({ type: "auth_list" });
		dispatch({ type: "accounts", open: true });
	};
	const openProfiles = () => {
		send({ type: "profiles_list" });
		dispatch({ type: "profiles", open: true });
	};
	const [showConversations, setShowConversations] = useState(false);
	const covered = state.auth.open || state.profiles.open;
	const status = statusText(state);
	const ready =
		state.connection === "open" && state.agentState !== "restarting" && state.agentState !== "starting";

	return (
		<div className={`chat chat-${variant}`} data-state={state.agentState}>
			<header className="chat-header" data-tauri-drag-region={variant === "panel" ? "" : undefined}>
				<span className={`state-dot state-${state.agentState}`} aria-hidden="true" />
				<h1>{activeTitle(state)}</h1>
				<button
					type="button"
					className="icon"
					aria-label="Conversations"
					aria-expanded={showConversations}
					onClick={() => {
						if (!showConversations) send({ type: "list_conversations" });
						setShowConversations(!showConversations);
					}}
				>
					☰
				</button>
				<button type="button" className="icon" aria-label="Accounts" onClick={openAccounts}>
					⚿
				</button>
				<button type="button" className="icon" aria-label="Profiles" onClick={openProfiles}>
					◐
				</button>
				<button
					type="button"
					className="icon"
					aria-label="New conversation"
					disabled={!ready}
					onClick={() => {
						setShowConversations(false);
						send({ type: "new_conversation" });
					}}
				>
					＋
				</button>
				{onHide ? (
					<button type="button" className="icon" aria-label="Hide" onClick={onHide}>
						–
					</button>
				) : null}
			</header>

			{showConversations ? (
				<nav className="conversations" aria-label="Earlier conversations">
					{state.conversations.length === 0 ? <p className="muted">No conversations yet.</p> : null}
					{state.conversations.map((conversation) => (
						<button
							key={conversation.id}
							type="button"
							className={conversation.id === state.conversationId ? "active" : ""}
							onClick={() => {
								setShowConversations(false);
								if (conversation.id !== state.conversationId) {
									send({ type: "open_conversation", conversationId: conversation.id });
								}
							}}
						>
							<span>{conversation.title}</span>
							<time dateTime={conversation.updatedAt}>
								{new Date(conversation.updatedAt).toLocaleString()}
							</time>
						</button>
					))}
				</nav>
			) : null}

			{status ? (
				<div className="status" role="status">
					{status}
				</div>
			) : null}

			{state.auth.open ? (
				<main className="chat-body">
					<AccountsPanel auth={state.auth} send={send} dispatch={dispatch} openUrl={openUrl} />
				</main>
			) : null}

			{state.profiles.open && !state.auth.open ? (
				<main className="chat-body">
					<ProfilesPanel
						profiles={state.profiles}
						send={send}
						dispatch={dispatch}
						{...(state.auth.providers ? { providers: state.auth.providers } : {})}
					/>
				</main>
			) : null}

			{!covered && needsAccount(state) ? (
				<div className="onboarding">
					<p>To start, connect the AI service you use (a subscription or an API key).</p>
					<button type="button" className="primary" onClick={openAccounts}>
						Connect an AI account
					</button>
				</div>
			) : null}

			<main className="chat-body" hidden={covered}>
				<MessageList messages={state.messages} />
				{state.interrupted ? (
					<div className="interrupted">
						<p>I was interrupted. Continue?</p>
						<button
							type="button"
							className="primary"
							disabled={!ready}
							onClick={() => send({ type: "send", text: CONTINUE_TEXT, requestId: newRequestId() })}
						>
							Continue
						</button>
					</div>
				) : null}
				{state.asks.map((ask) => (
					<AskCard key={ask.requestId} ask={ask} send={send} />
				))}
			</main>

			{state.notices.length > 0 ? (
				<div className="notices">
					{state.notices.map((notice) => (
						<div key={notice.id} className={`notice notice-${notice.level}`}>
							<span>{notice.message}</span>
							<button type="button" aria-label="Dismiss" onClick={() => dismiss(notice.id)}>
								×
							</button>
						</div>
					))}
				</div>
			) : null}

			<Composer busy={isBusy(state.agentState)} disabled={!ready} send={send} focusKey={focusKey} />
		</div>
	);
}
