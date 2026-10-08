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

export function MinusIcon() {
	return (
		<Icon>
			<path d="M5 12h14" />
		</Icon>
	);
}
