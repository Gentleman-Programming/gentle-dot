import type { ClientMessage } from "@gentle-dot/protocol";
import { useState } from "react";
import { openUrl as openExternal } from "../desktop.ts";
import { activeTitle, type DotAction, type DotState, isBusy, needsAccount } from "../store.ts";
import type { PanelWindowControls } from "../usePanelWindow.ts";
import { AccountsPanel } from "./AccountsPanel.tsx";
import { AskCard } from "./AskCard.tsx";
import { Composer } from "./Composer.tsx";
import { ComputerBanner, type ComputerControls } from "./Computer.tsx";
import { ConnectorDraftCard } from "./ConnectorDraftCard.tsx";
import { ConnectorsPanel } from "./ConnectorsPanel.tsx";
import {
	AccountsIcon,
	CollapseIcon,
	ConnectorsIcon,
	ConversationsIcon,
	ExpandIcon,
	EyeIcon,
	EyeOffIcon,
	MinusIcon,
	PlusIcon,
	ProfilesIcon,
	RoseGlyph,
} from "./icons.tsx";
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
	/** Computer control, in the desktop panel only. */
	computer?: ComputerControls;
	/** Hiding the rose and full screen (S26), in the desktop panel only; the web page already fills the browser. */
	panelWindow?: PanelWindowControls;
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
	computer,
	panelWindow,
}: ChatSurfaceProps) {
	const openAccounts = () => {
		send({ type: "auth_list" });
		dispatch({ type: "accounts", open: true });
	};
	const openProfiles = () => {
		send({ type: "profiles_list" });
		dispatch({ type: "profiles", open: true });
	};
	const openConnectors = () => {
		send({ type: "connectors_list" });
		dispatch({ type: "connectors", open: true });
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
		if (state.connectors.open && !state.connectors.flow?.prompt)
			dispatch({ type: "connectors", open: false });
	};
	const covered = state.auth.open || state.profiles.open || state.connectors.open;
	// One continuous chat unless the daemon turns the conversations list on.
	const conversations = state.features.conversations;
	const status = statusText(state);
	const ready =
		state.connection === "open" && state.agentState !== "restarting" && state.agentState !== "starting";

	return (
		<div
			className={`chat chat-${variant}${panelWindow?.fullscreen ? " chat-fullscreen" : ""}`}
			data-state={state.agentState}
		>
			<header className="chat-header" data-tauri-drag-region={variant === "panel" ? "" : undefined}>
				<span className={`state-dot state-${state.agentState}`} aria-hidden="true" />
				{conversations ? (
					<>
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
					</>
				) : (
					<h1 className="assistant-name">
						<RoseGlyph />
						<span className="gradient-text">Gentle Dot</span>
					</h1>
				)}
				<button type="button" className="icon" aria-label="Accounts" title="Accounts" onClick={openAccounts}>
					<AccountsIcon />
				</button>
				<button type="button" className="icon" aria-label="Profiles" title="Profiles" onClick={openProfiles}>
					<ProfilesIcon />
				</button>
				<button
					type="button"
					className="icon"
					aria-label="Connectors"
					title="Connectors"
					onClick={openConnectors}
				>
					<ConnectorsIcon />
				</button>
				{conversations ? (
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
				) : null}
				{panelWindow ? (
					<>
						<RoseButton controls={panelWindow} />
						<FullscreenButton controls={panelWindow} />
					</>
				) : null}
				{onHide ? (
					<button type="button" className="icon" aria-label="Hide" title="Hide" onClick={onHide}>
						<MinusIcon />
					</button>
				) : null}
			</header>

			{computer?.session ? (
				<ComputerBanner session={computer.session} yolo={computer.yolo !== undefined} stop={computer.stop} />
			) : null}

			{conversations && showConversations ? (
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

			{state.connectors.open && !state.auth.open && !state.profiles.open ? (
				<main className="chat-body">
					<ConnectorsPanel
						connectors={state.connectors}
						send={send}
						dispatch={dispatch}
						openUrl={openUrl}
						{...(computer?.available ? { computer } : {})}
					/>
				</main>
			) : null}

			<main className="chat-body" hidden={covered}>
				{/* In the chat's own flow, so messages start below it instead of sliding under it. */}
				{needsAccount(state) ? (
					<div className="onboarding">
						<p>To start, connect the AI service you use (a subscription or an API key).</p>
						<button type="button" className="primary" onClick={openAccounts}>
							Connect an AI account
						</button>
					</div>
				) : null}
				<MessageList
					messages={state.messages}
					queued={[...state.queue.steering, ...state.queue.followUp]}
					hasEarlier={state.hasEarlier}
					onShowEarlier={() => {
						const first = state.messages[0];
						if (first) send({ type: "get_earlier", before: first.id });
					}}
				/>
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
				{(state.connectors.drafts ?? []).map((draft) => (
					<ConnectorDraftCard
						key={draft.draftId}
						draft={draft}
						send={send}
						// Its secrets are asked in the Connectors screen.
						approved={() => dispatch({ type: "connector_started", connectorId: draft.name })}
					/>
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

function RoseButton({ controls }: { controls: PanelWindowControls }) {
	const label = controls.roseHidden ? "Show the rose" : "Hide the rose";
	return (
		<button
			type="button"
			className="icon"
			aria-label={label}
			title={label}
			onClick={() => controls.setRoseHidden(!controls.roseHidden)}
		>
			{controls.roseHidden ? <EyeIcon /> : <EyeOffIcon />}
		</button>
	);
}

function FullscreenButton({ controls }: { controls: PanelWindowControls }) {
	const label = controls.fullscreen ? "Exit full screen" : "Full screen";
	return (
		<button
			type="button"
			className="icon"
			aria-label={label}
			title={`${label} (⌘⇧F)`}
			aria-pressed={controls.fullscreen}
			onClick={() => controls.setFullscreen(!controls.fullscreen)}
		>
			{controls.fullscreen ? <CollapseIcon /> : <ExpandIcon />}
		</button>
	);
}
