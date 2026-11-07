import type { ConnectorInfo } from "@gentle-dot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ComputerPermission,
	type ComputerPermissions,
	type ComputerSession,
	type ComputerYolo,
	timeLeft,
} from "../computer.ts";
import { computerCopy, computerPlatform, computerReadiness } from "../computer-capabilities.ts";
import { useLocale } from "../i18n.tsx";

/** Computer control in the desktop panel (S24.5, S24.6); the web page never gets it. */
export interface ComputerControls {
	/** A helper is registered, not necessarily ready or allowed to act. */
	available: boolean;
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

const PERMISSIONS = [
	["accessibility", "computer.accessibility"],
	["screenRecording", "computer.screenRecording"],
] as const;

export const DEBUG_BUILD_NOTE =
	"Debug builds lose these permissions on every rebuild because macOS ties them to the app's signature; grant them again after updating.";

interface ComputerBannerProps {
	session: ComputerSession;
	yolo: boolean;
	stop: () => void;
}

/** Native session authority, independent of transport or prerequisite status. */
export function ComputerBanner({ session, yolo, stop }: ComputerBannerProps) {
	const { t } = useLocale();
	const platform = computerPlatform(navigator.userAgent);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const left =
		session.endsAt === undefined
			? ""
			: ` · ${t("computer.left").replace("{time}", timeLeft(session.endsAt, now))}`;
	return (
		<section className="computer-banner" aria-label={t("computer.control")}>
			<span className="computer-banner-light" aria-hidden="true" />
			<span>
				{t(`computer.${platform}.banner`)}
				{left}
			</span>
			{yolo ? (
				<span className="chip computer-yolo-chip" title={t("computer.yoloRisk")}>
					Yolo
				</span>
			) : null}
			<button type="button" className="primary" onClick={stop}>
				{t("computer.stop")}
			</button>
		</section>
	);
}

interface ComputerEntryProps {
	/** The daemon's built-in entry, once the helper is registered. */
	info?: ConnectorInfo;
	controls: ComputerControls;
}

/** Current native prerequisites (including screenshot support), never session or Yolo consent. */
export function ComputerEntry({ info, controls }: ComputerEntryProps) {
	const { permissions, requestPermission, yolo, setYolo } = controls;
	const platform = computerPlatform(navigator.userAgent);
	const { t } = useLocale();
	// Only the existing pure helper supplies accelerator bytes; guidance is display-local.
	const panic = platform === "unknown" ? t("computer.unknown.panic") : computerCopy(platform).panic;
	const [granted, setGranted] = useState<ComputerPermissions>();
	const [checking, setChecking] = useState(true);
	const generation = useRef(0);
	const live = useRef(false);
	const check = useCallback(() => {
		if (!live.current) return;
		const request = ++generation.current;
		setGranted(undefined);
		setChecking(true);
		const finish = (value?: ComputerPermissions) => {
			if (!live.current || request !== generation.current) return;
			// Reject incomplete or malformed native responses, not just false prerequisites.
			const valid =
				value &&
				typeof value.accessibility === "boolean" &&
				typeof value.screenRecording === "boolean" &&
				typeof value.screenshotsSupported === "boolean";
			setGranted(valid ? value : undefined);
			setChecking(false);
		};
		permissions().then(finish, () => finish());
	}, [permissions]);
	useEffect(() => {
		live.current = true;
		check();
		return () => {
			live.current = false;
			generation.current++;
		};
	}, [check]);
	const ready = computerReadiness(granted);

	return (
		<li className="computer-entry" aria-labelledby="connector-computer">
			<div className="provider-name">
				<b id="connector-computer">{t("computer.name")}</b>
				<span className="chip connector-connected">{t("computer.builtIn")}</span>
			</div>
			{info ? (
				<>
					<p className="connector-note">{info.reads}</p>
					<p className="connector-note">{info.sends}</p>
				</>
			) : null}
			<p className="connector-note">
				{t("computer.registered")}
				{" · "}
				{t(
					checking
						? "computer.checkingPrerequisites"
						: ready
							? "computer.prerequisitesMet"
							: "computer.prerequisitesUnavailable",
				)}
			</p>
			<p className="connector-note">{t(`computer.${platform}.prerequisites`)}</p>
			<ul className="computer-permissions">
				{(platform === "mac" ? PERMISSIONS : []).map(([kind, labelKey]) => {
					const label = t(labelKey);
					const allowed = granted?.[kind] === true;
					const id = `computer-permission-${kind}`;
					return (
						<li key={kind} aria-labelledby={id}>
							<span id={id}>{label}</span>
							<span className={`chip ${allowed ? "connector-connected" : "connector-needs_setup"}`}>
								{t(
									checking
										? "computer.checking"
										: granted === undefined
											? "computer.unable"
											: allowed
												? "computer.allowed"
												: "computer.notAllowed",
								)}
							</span>
							{granted !== undefined && !allowed ? (
								<button
									type="button"
									className="primary"
									aria-label={`${t("computer.grant")} ${label}`}
									onClick={() => {
										requestPermission(kind).then(check, check);
									}}
								>
									{t("computer.grant")}
								</button>
							) : null}
						</li>
					);
				})}
				<li>
					<span>{t("computer.captureInput")}</span>
					<span className={`chip ${ready ? "connector-connected" : "connector-needs_setup"}`}>
						{t(checking ? "computer.checking" : ready ? "computer.currentlyMet" : "computer.unavailable")}
					</span>
				</li>
			</ul>
			<div className="provider-actions">
				<button type="button" onClick={check}>
					{t("computer.checkAgain")}
				</button>
			</div>
			{platform === "windows" && granted?.screenshotsSupported === false ? (
				<p className="connector-note computer-warning">
					{t(
						granted.screenshotsUnsupported === "unknownVersion"
							? "computer.windows.unknownVersion"
							: "computer.windows.screenshotsUnsupported",
					)}
				</p>
			) : null}
			<div className="computer-yolo">
				<span id="computer-yolo-label">{t("computer.yoloMode")}</span>
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
			<p className="connector-note">
				{t("computer.yoloNote")} {granted?.panicShortcut === true && platform !== "unknown"
					? t("computer.panicNote").replace("{panic}", panic)
					: t("computer.stopNote")}
			</p>
			<p className="connector-note">{t(`computer.${platform}.limits`)}</p>
			{platform === "mac" ? <p className="connector-note">{t("computer.debug")}</p> : null}
			{info?.noImages ? <p className="connector-note computer-warning">{t("computer.noImages")}</p> : null}
		</li>
	);
}
