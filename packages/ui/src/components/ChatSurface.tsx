import type { ClientMessage } from "@gentle-dot/protocol";
import { useState } from "react";
import { openUrl as openExternal } from "../desktop.ts";
import { activeTitle, type DotAction, type DotState, isBusy, needsAccount } from "../store.ts";
import { AccountsPanel } from "./AccountsPanel.tsx";
import { AskCard } from "./AskCard.tsx";
import { Composer } from "./Composer.tsx";
import { AccountsIcon, ConversationsIcon, MinusIcon, PlusIcon, ProfilesIcon } from "./icons.tsx";
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

type SwitchMessage = Extract<ClientMessage, { type: "new_conversation" | "open_conversation" }>;

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
	/** A switch that waits for the user to confirm stopping the running answer. */
	const [pendingSwitch, setPendingSwitch] = useState<SwitchMessage | undefined>(undefined);
	const switchTo = (message: SwitchMessage) => {
		setShowConversations(false);
		if (isBusy(state.agentState)) setPendingSwitch(message);
		else send(message);
	};
	/** Typing means the user is back to the chat; a sign-in waiting for an answer stays. */
	const closeOptions = () => {
		setShowConversations(false);
		if (state.auth.open && !state.auth.flow?.prompt) dispatch({ type: "accounts", open: false });
		if (state.profiles.open) dispatch({ type: "profiles", open: false });
	};
	const covered = state.auth.open || state.profiles.open;
	const status = statusText(state);
	const ready =
		state.connection === "open" && state.agentState !== "restarting" && state.agentState !== "starting";

	return (
		<div className={`chat chat-${variant}`} data-state={state.agentState}>
			<header className="chat-header" data-tauri-drag-region={variant === "panel" ? "" : undefined}>
				<span className={`state-dot state-${state.agentState}`} aria-hidden="true" />
				<h1 className="gradient-text">{activeTitle(state)}</h1>
				<button
					type="button"
					className="icon"
					aria-label="Conversations"
					title="Conversations"
					aria-expanded={showConversations}
					onClick={() => {
						if (!showConversations) send({ type: "list_conversations" });
						setShowConversations(!showConversations);
					}}
				>
					<ConversationsIcon />
				</button>
				<button type="button" className="icon" aria-label="Accounts" title="Accounts" onClick={openAccounts}>
					<AccountsIcon />
				</button>
				<button type="button" className="icon" aria-label="Profiles" title="Profiles" onClick={openProfiles}>
					<ProfilesIcon />
				</button>
				<button
					type="button"
					className="icon"
					aria-label="New conversation"
					title="New conversation"
					disabled={!ready}
					onClick={() => switchTo({ type: "new_conversation" })}
				>
					<PlusIcon />
				</button>
				{onHide ? (
					<button type="button" className="icon" aria-label="Hide" title="Hide" onClick={onHide}>
						<MinusIcon />
					</button>
				) : null}
			</header>

			{showConversations ? (
				<nav className="conversations" aria-label="Earlier conversations">
					<p className="eyebrow">Conversations</p>
					{state.conversations.length === 0 ? <p className="muted">No conversations yet.</p> : null}
					{state.conversations.map((conversation) => (
						<button
							key={conversation.id}
							type="button"
							className={conversation.id === state.conversationId ? "active" : ""}
							onClick={() => {
								if (conversation.id === state.conversationId) setShowConversations(false);
								else switchTo({ type: "open_conversation", conversationId: conversation.id });
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
				<MessageList messages={state.messages} queued={[...state.queue.steering, ...state.queue.followUp]} />
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

			{pendingSwitch ? (
				<div className="switch-confirm" role="alertdialog" aria-label="Stop and switch?">
					<p>The assistant is still answering. Stop it and open the other conversation?</p>
					<div className="switch-actions">
						<button
							type="button"
							className="primary"
							onClick={() => {
								send(pendingSwitch);
								setPendingSwitch(undefined);
							}}
						>
							Stop and switch
						</button>
						<button type="button" onClick={() => setPendingSwitch(undefined)}>
							Cancel
						</button>
					</div>
				</div>
			) : null}

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

			<Composer
				busy={isBusy(state.agentState)}
				disabled={!ready}
				send={send}
				focusKey={focusKey}
				onStartTyping={closeOptions}
			/>
		</div>
	);
}
