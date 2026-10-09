import type { ReactNode } from "react";

/** One stroke icon set for the header: 18 px, drawn in the button's text color. */
function Icon({ children }: { children: ReactNode }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{children}
		</svg>
	);
}

/** Two chat bubbles: earlier conversations. */
export function ConversationsIcon() {
	return (
		<Icon>
			<path d="M14 9a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z" />
			<path d="M18 9h1a2 2 0 0 1 2 2v9l-3-3h-6a2 2 0 0 1-2-2v-1" />
		</Icon>
	);
}

/** A key: sign-ins and API keys. */
export function AccountsIcon() {
	return (
		<Icon>
			<circle cx="7.5" cy="15.5" r="4.5" />
			<path d="m10.7 12.3 9.8-9.8" />
			<path d="m16 7 3 3" />
			<path d="m19 4 2 2" />
		</Icon>
	);
}

/** A plug: the apps the assistant can use. */
export function ConnectorsIcon() {
	return (
		<Icon>
			<path d="M9 2v5" />
			<path d="M15 2v5" />
			<path d="M6 7h12v4a6 6 0 0 1-12 0z" />
			<path d="M12 17v5" />
		</Icon>
	);
}

/** Sliders: which model does what. */
export function ProfilesIcon() {
	return (
		<Icon>
			<path d="M4 21v-7" />
			<path d="M4 10V3" />
			<path d="M12 21v-9" />
			<path d="M12 8V3" />
			<path d="M20 21v-5" />
			<path d="M20 12V3" />
			<path d="M2 14h4" />
			<path d="M10 8h4" />
			<path d="M18 16h4" />
		</Icon>
	);
}

export function PlusIcon() {
	return (
		<Icon>
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</Icon>
	);
}

/** An arrow up, for the composer's send button. */
export function SendIcon() {
	return (
		<Icon>
			<path d="M12 19V5" />
			<path d="m5 12 7-7 7 7" />
		</Icon>
	);
}

/** A microphone: talk to the assistant. */
export function MicIcon() {
	return (
		<Icon>
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0" />
			<path d="M12 18v3" />
		</Icon>
	);
}

/** A paper clip: attach files (S31.1). */
export function PaperclipIcon() {
	return (
		<Icon>
			<path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />
		</Icon>
	);
}

/** A speaker: spoken replies are on. */
export function SpeakerIcon() {
	return (
		<Icon>
			<path d="M4 9v6h4l5 4V5L8 9Z" />
			<path d="M16.5 8.5a5 5 0 0 1 0 7" />
			<path d="M19 6a8.5 8.5 0 0 1 0 12" />
		</Icon>
	);
}

/** A crossed speaker: spoken replies are muted. */
export function SpeakerOffIcon() {
	return (
		<Icon>
			<path d="M4 9v6h4l5 4V5L8 9Z" />
			<path d="m17 9 5 6" />
			<path d="m22 9-5 6" />
		</Icon>
	);
}

/** The rose (the app's favicon drawing): who the user is talking to. */
export function RoseGlyph() {
	return (
		<svg
			className="rose-glyph"
			width="18"
			height="18"
			viewBox="0 0 18 18"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.25"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M6.6 11.1C4.2 10.3 3 8.3 3.1 5.3L5.4 6.5" />
			<path d="M11.4 11.1C13.8 10.3 15 8.3 14.9 5.3L12.6 6.5" />
			<path d="M5.4 6.5C5.5 3.9 7.1 2.5 9 2.5S12.5 3.9 12.6 6.5" />
			<path d="M5.4 6.5C5.8 9.6 7.2 11.2 9 11.6C10.8 11.2 12.2 9.6 12.6 6.5" />
			<path d="M9.05 8.7C7.7 8.7 7.2 7.3 7.9 6.5C8.6 5.8 9.9 6 10.1 6.95C10.25 7.6 9.7 8 9.15 7.8" />
			<path d="M9 11.6C9 13.6 8.6 15.1 7.5 16.6" />
			<path d="M8.85 13.7C10.1 12.6 12.2 12.6 13.1 13.5C12 14.6 10.2 14.7 8.85 13.7Z" />
		</svg>
	);
}

export function MinusIcon() {
	return (
		<Icon>
			<path d="M5 12h14" />
		</Icon>
	);
}

/** An eye: show the floating rose again. */
export function EyeIcon() {
	return (
		<Icon>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
			<circle cx="12" cy="12" r="3" />
		</Icon>
	);
}

/** A crossed-out eye: hide the floating rose. */
export function EyeOffIcon() {
	return (
		<Icon>
			<path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1" />
			<path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
			<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
			<path d="m2 2 20 20" />
		</Icon>
	);
}

/** Corners pointing out: fill the screen. */
export function ExpandIcon() {
	return (
		<Icon>
			<path d="M15 3h6v6" />
			<path d="M9 21H3v-6" />
			<path d="M21 3l-7 7" />
			<path d="M3 21l7-7" />
		</Icon>
	);
}

/** Corners pointing in: back to the panel's size. */
export function CollapseIcon() {
	return (
		<Icon>
			<path d="M4 14h6v6" />
			<path d="M20 10h-6V4" />
			<path d="M14 10l7-7" />
			<path d="M3 21l7-7" />
		</Icon>
	);
}

/** A gear: the panel's settings (S33.1). */
export function SettingsIcon() {
	return (
		<Icon>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</Icon>
	);
}
