import type { ConnectorInfo } from "@gentle-dot/protocol";
import { useCallback, useEffect, useState } from "react";
import {
	type ComputerPermission,
	type ComputerPermissions,
	type ComputerPlatform,
	type ComputerSession,
	type ComputerYolo,
	UNKNOWN_PLATFORM,
	timeLeft,
} from "../computer.ts";

/** Computer control in the desktop panel (S24.5, S24.6); the web page never gets it. */
export interface ComputerControls {
	/** The app has a helper, so the Connectors screen offers it. */
	available: boolean;
	/** What this build may claim: platform, policy and the real Stop shortcut (T5d). */
	platform?: ComputerPlatform;
	/** The session the user allowed, while it lasts. */
	session?: ComputerSession;
	/** Yolo mode, while it is on (S24.9). */
	yolo?: ComputerYolo;
	stop: () => void;
	/** Asks the app; its native confirmation decides, and the state follows. */
	setYolo: (enabled: boolean) => Promise<unknown>;
	permissions: () => Promise<ComputerPermissions>;
	requestPermission: (kind: ComputerPermission) => Promise<unknown>;
}

const PERMISSIONS: [ComputerPermission, string][] = [
	["accessibility", "Accessibility"],
	["screenRecording", "Screen Recording"],
];

export const DEBUG_BUILD_NOTE =
	"Debug builds lose these permissions on every rebuild because macOS ties them to the app's signature; grant them again after updating.";

/** Yolo mode's own note, naming the Stop this build really has (T5d); no key, no broken grammar. */
export function yoloNote(stopShortcut: string): string {
	const stop = stopShortcut ? `Stop and ${stopShortcut}` : "Stop";
	const still = stopShortcut ? "still work" : "still works";
	return `Yolo mode lets the assistant send, pay, delete, and submit without asking you first. It turns itself off after 1 hour or when the app quits; ${stop} ${still}.`;
}

/**
 * Linux has no Accessibility and no Screen Recording, so the panel must not list them; what it must
 * say instead is the truth of desktop-global control: no per-app exclusion is promised.
 */
export const GLOBAL_CONTROL_NOTE =
	"Desktop-global control: every visible app can receive input, and there is no reliable per-app exclusion.";

/**
 * The daemon's connector metadata says "on this Mac", which is false of a Linux panel; the panel
 * composes the true sentence from the platform it already has instead, so macOS keeps the daemon's
 * words byte for byte (T18).
 */
export const DESKTOP_SENDS_NOTE =
	"Click, type, and open apps on this desktop during that session. The app asks you again only when it detects a risky action.";
const NO_IMAGES_NOTE =
	"The current model does not accept images, so the assistant cannot see your screen. Choose a model that does in Profiles.";

interface ComputerBannerProps {
	session: ComputerSession;
	yolo: boolean;
	stop: () => void;
	/** What this build may claim (T5d); an unknown build keeps the macOS wording it had. */
	platform?: ComputerPlatform;
}

/** "Controlling your Mac · mm:ss left" with a Stop button, while a session is active. */
export function ComputerBanner({ session, yolo, stop, platform = UNKNOWN_PLATFORM }: ComputerBannerProps) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const left = session.endsAt === undefined ? "" : ` · ${timeLeft(session.endsAt, now)} left`;
	// Linux has no "Mac" to name, and the same session covers the whole desktop; a build that
	// did not say what it is gets the neutral word rather than a claim.
	const what = platform.os === "macos" ? "Mac" : platform.os === "linux" ? "desktop" : "screen";
	return (
		<section className="computer-banner" aria-label="Computer control">
			<span className="computer-banner-light" aria-hidden="true" />
			<span>Controlling your {what}{left}</span>
			{yolo ? (
				<span className="chip computer-yolo-chip" title="Risky actions run without asking you first">
					Yolo
				</span>
			) : null}
			<button type="button" className="primary" onClick={stop}>
				Stop
			</button>
		</section>
	);
}

interface ComputerEntryProps {
	/** The daemon's built-in entry, once the helper is registered. */
	info?: ConnectorInfo;
	controls: ComputerControls;
}

/** The built-in Computer connector: the permissions and the control this build really offers. */
export function ComputerEntry({ info, controls }: ComputerEntryProps) {
	const { permissions, requestPermission, yolo, setYolo } = controls;
	const platform = controls.platform ?? UNKNOWN_PLATFORM;
	// macOS is the only platform with Accessibility and Screen Recording; listing them elsewhere
	// would offer a Grant button that cannot work.
	const macos = platform.os === "macos";
	// Only desktop-global control has no per-app exclusion to promise.
	const global = platform.policy === "desktopGlobal";
	const [granted, setGranted] = useState<ComputerPermissions>();
	const check = useCallback(() => {
		if (!macos) return;
		permissions().then(setGranted, () => setGranted(undefined));
	}, [macos, permissions]);
	useEffect(check, [check]);

	return (
		<li className="computer-entry" aria-labelledby="connector-computer">
			<div className="provider-name">
				<b id="connector-computer">Computer</b>
				<span className="chip connector-connected">Built in</span>
			</div>
			{info ? (
				<>
					<p className="connector-note">{info.reads}</p>
					{/* Only macOS may claim a Mac. An unknown build gets the desktop sentence, which is
					    true on both, rather than a Mac the user may not have. */}
					<p className="connector-note">{macos ? info.sends : DESKTOP_SENDS_NOTE}</p>
				</>
			) : null}
			<ul className="computer-permissions">
				{macos
					? PERMISSIONS.map(([kind, label]) => {
					const allowed = granted?.[kind] === true;
					const id = `computer-permission-${kind}`;
					return (
						<li key={kind} aria-labelledby={id}>
							<span id={id}>{label}</span>
							<span className={`chip ${allowed ? "connector-connected" : "connector-needs_setup"}`}>
								{granted === undefined ? "Checking…" : allowed ? "Allowed" : "Not allowed"}
							</span>
							{granted !== undefined && !allowed ? (
								<button
									type="button"
									className="primary"
									aria-label={`Grant ${label}`}
									onClick={() => {
										requestPermission(kind).then(check, check);
									}}
								>
									Grant
								</button>
							) : null}
						</li>
					);
						})
					: null}
			</ul>
			{global ? <p className="connector-note">{GLOBAL_CONTROL_NOTE}</p> : null}
			<div className="provider-actions">
				{macos ? (
					<button type="button" onClick={check}>
						Check again
					</button>
				) : null}
			</div>
			<div className="computer-yolo">
				<span id="computer-yolo-label">Yolo mode</span>
				<button
					type="button"
					role="switch"
					className="switch"
					aria-checked={yolo !== undefined}
					aria-labelledby="computer-yolo-label"
					onClick={() => {
						setYolo(yolo === undefined).catch(() => {});
					}}
				>
					<span className="switch-knob" aria-hidden="true" />
				</button>
			</div>
			<p className="connector-note">{yoloNote(platform.stopShortcut)}</p>
			{macos ? <p className="connector-note">{DEBUG_BUILD_NOTE}</p> : null}
			{info?.noImages ? <p className="connector-note computer-warning">{NO_IMAGES_NOTE}</p> : null}
		</li>
	);
}
