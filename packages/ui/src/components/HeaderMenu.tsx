import { type ReactNode, useEffect, useRef } from "react";
import type { PanelWindowControls } from "../usePanelWindow.ts";
import type { VoiceControls } from "../useVoice.ts";
import {
	AccountsIcon,
	CloseIcon,
	CollapseIcon,
	ConnectorsIcon,
	ConversationsIcon,
	ExpandIcon,
	EyeIcon,
	EyeOffIcon,
	MenuIcon,
	MinusIcon,
	PlusIcon,
	ProfilesIcon,
	SettingsIcon,
	SpeakerIcon,
	SpeakerOffIcon,
} from "./icons.tsx";

/** What one drawer row does; every row closes the drawer when it acts. */
export interface HeaderMenuProps {
	onClose: () => void;
	conversations?: boolean;
	ready?: boolean;
	showConversations?: boolean;
	onNewConversation?: () => void;
	onToggleConversations?: () => void;
	openAccounts: () => void;
	openProfiles: () => void;
	openConnectors: () => void;
	settings?: boolean;
	settingsShown?: boolean;
	openSettings?: () => void;
	voice: VoiceControls;
	panelWindow?: PanelWindowControls;
	onHide?: () => void;
	/** The screen each rail marks as open, so the drawer shows where you are. */
	accountsOpen?: boolean;
	profilesOpen?: boolean;
	connectorsOpen?: boolean;
}

function Row({
	icon,
	label,
	hint,
	active,
	pressed,
	disabled,
	onClick,
	children,
}: {
	icon: ReactNode;
	label: string;
	hint?: string;
	active?: boolean;
	pressed?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	children?: ReactNode;
}) {
	return (
		<button
			type="button"
			className={`menu-row${active ? " active" : ""}`}
			aria-pressed={pressed}
			disabled={disabled}
			title={label}
			onClick={onClick}
		>
			{icon}
			<span className="menu-row-label">{label}</span>
			{hint ? <span className="menu-row-hint">{hint}</span> : null}
			{children}
		</button>
	);
}

/** The panel's hamburger menu (design/ui-header-menu/02-cajon-lateral.html): one drawer from
 * the right edge grouping every header action, so the header itself stays just the rose, the
 * name and the menu button. Rows the variant does not have are left out entirely; a screen the
 * user is on is marked with the active rail. */
export function PanelMenuDrawer({
	onClose,
	conversations,
	ready,
	showConversations,
	onNewConversation,
	onToggleConversations,
	openAccounts,
	openProfiles,
	openConnectors,
	settings,
	settingsShown,
	openSettings,
	voice,
	panelWindow,
	onHide,
	accountsOpen,
	profilesOpen,
	connectorsOpen,
}: HeaderMenuProps) {
	const close = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		close.current?.focus();
	}, []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<>
			<div className="header-menu-scrim" role="presentation" onClick={onClose} aria-hidden="true" />
			<nav className="header-menu" aria-label="Panel menu">
				<div className="header-menu-head">
					<span>Menu</span>
					<button ref={close} type="button" className="icon" aria-label="Close menu" onClick={onClose}>
						<CloseIcon />
					</button>
				</div>
				<section>
					<div className="menu-group">Conversation</div>
					{conversations ? (
						<>
							<Row
								icon={<PlusIcon />}
								label="New conversation"
								disabled={!ready}
								onClick={() => {
									onClose();
									onNewConversation?.();
								}}
							/>
							<Row
								icon={<ConversationsIcon />}
								label="Conversations"
								pressed={showConversations}
								onClick={() => {
									onClose();
									onToggleConversations?.();
								}}
							/>
						</>
					) : settings && openSettings ? (
						<Row
							icon={<ConversationsIcon />}
							label="Conversations"
							hint="Settings"
							onClick={() => {
								onClose();
								openSettings();
							}}
						/>
					) : null}
				</section>
				<section>
					<div className="menu-group">Integrations</div>
					<Row
						icon={<AccountsIcon />}
						label="Accounts"
						active={accountsOpen}
						onClick={() => {
							onClose();
							openAccounts();
						}}
					/>
					<Row
						icon={<ProfilesIcon />}
						label="Profiles"
						active={profilesOpen}
						onClick={() => {
							onClose();
							openProfiles();
						}}
					/>
					<Row
						icon={<ConnectorsIcon />}
						label="Connectors"
						active={connectorsOpen}
						onClick={() => {
							onClose();
							openConnectors();
						}}
					/>
				</section>
				<section>
					<div className="menu-group">Panel</div>
					{settings ? (
						<Row
							icon={<SettingsIcon />}
							label="Settings"
							active={settingsShown}
							onClick={() => {
								onClose();
								openSettings?.();
							}}
						/>
					) : null}
					{voice.mic ? (
						<Row
							icon={voice.muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
							label={voice.muted ? "Unmute spoken replies" : "Mute spoken replies"}
							pressed={voice.muted}
							onClick={() => voice.setMuted(!voice.muted)}
						/>
					) : null}
					{panelWindow ? (
						<Row
							icon={panelWindow.roseHidden ? <EyeIcon /> : <EyeOffIcon />}
							label={panelWindow.roseHidden ? "Show the rose" : "Hide the rose"}
							pressed={panelWindow.roseHidden}
							onClick={() => panelWindow.setRoseHidden(!panelWindow.roseHidden)}
						/>
					) : null}
					{panelWindow ? (
						<Row
							icon={panelWindow.fullscreen ? <CollapseIcon /> : <ExpandIcon />}
							label={panelWindow.fullscreen ? "Exit full screen" : "Full screen"}
							pressed={panelWindow.fullscreen}
							onClick={() => panelWindow.setFullscreen(!panelWindow.fullscreen)}
						/>
					) : null}
					{onHide ? (
						<Row
							icon={<MinusIcon />}
							label="Hide"
							onClick={() => {
								onClose();
								onHide();
							}}
						/>
					) : null}
				</section>
			</nav>
		</>
	);
}

/** The in-header button. It lives inside the header even though the drawer does not: the
 * header's backdrop-filter re-anchors fixed descendants to the header box, so the drawer is
 * rendered by the caller as a sibling of the header instead. */
export function MenuToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			className="icon"
			aria-label="Panel menu"
			title="Panel menu"
			aria-expanded={open}
			onClick={onToggle}
		>
			<MenuIcon />
		</button>
	);
}
