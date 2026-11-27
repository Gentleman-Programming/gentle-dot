import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { hidePanel, type StartupReadiness, startupReadiness } from "../desktop.ts";

type RowState = readonly [status: string, detail: string, tone?: "ok" | "warning" | "failure"];
const unknown = ["Unknown", "Could not verify this step."] as const;
const checking = ["Checking", "Waiting for startup metadata."] as const;
const runtime: Record<StartupReadiness["runtime"], RowState> = {
	present: ["Ready", "The bundled runtime was found.", "ok"],
	missing: ["Missing", "The bundled runtime could not be found. Ask your administrator or support to check this installation.", "warning"],
	unknown,
};
const profile: Record<StartupReadiness["profile"], RowState> = {
	"no-conflict-found": ["No conflict found", "Selected metadata shows no conflict. Not a full profile audit.", "ok"],
	new: ["New profile", "No existing profile was found at the selected location.", "ok"],
	"owner-mismatch": ["Ownership mismatch", "The selected profile did not match the expected owner.", "failure"],
	unsafe: ["Unsafe", "The selected profile location did not pass the metadata safety check.", "failure"],
	unknown: ["Unknown", "Could not determine whether the selected profile has an ownership or safety conflict."],
};
const service: Record<StartupReadiness["service"], RowState> = {
	starting: ["Starting", "Wait for the assistant to connect or refresh the checks."],
	ready: ["Previously started", "The last owned startup succeeded. The panel is still waiting to connect."],
	blocked: ["Blocked", "Resolve the reported blocker before trying again. Do not restart to bypass it.", "warning"],
	failed: ["Failed", "The service did not start.", "failure"],
	unknown: ["Unknown", "The service state could not be determined. This does not mean it failed."],
};

function Step({ title, state: [status, detail, tone], children }: {
	title: string;
	state: RowState;
	children?: ReactNode;
}) {
	return (
		<li className="card">
			<div className="startup-row">
				<h2>{title}</h2>
				<span className={tone ? `chip ${tone}` : "chip"}>{status}</span>
			</div>
			<p>{detail}</p>
			{children}
		</li>
	);
}

export function StartupChecklist({ connectionFailed, children }: {
	connectionFailed: boolean;
	children: ReactNode;
}) {
	const [result, setResult] = useState<Awaited<ReturnType<typeof startupReadiness>>>();
	const generation = useRef(0);
	const refresh = useCallback(() => {
		const attempt = ++generation.current;
		setResult(undefined);
		void startupReadiness().then((next) => {
			if (attempt === generation.current) setResult(next);
		});
	}, []);
	useEffect(() => {
		refresh();
		return () => {
			generation.current++;
		};
	}, [refresh, connectionFailed]); // Re-read metadata when a pending connection is refused.

	// Only explicit lack of native support restores the legacy screen and its connection reason.
	if (result === null) return children;
	const data = result === "unavailable" ? undefined : result;
	const unchecked = result === undefined ? checking : unknown;
	const offerFreshProfile = data && data.profile !== "no-conflict-found" && data.profile !== "new";
	const serviceRow: RowState = !data ? unchecked : data.service === "ready" && connectionFailed
		? ["Not connected", "The last owned startup succeeded, but the panel could not connect.", "failure"]
		: service[data.service];
	const checkStatus = result === undefined
		? "Checking startup metadata…"
		: result === "unavailable" ? "Startup checks are unavailable." : "Startup metadata checked.";
	return (
		<main className="chat chat-panel startup-panel" aria-labelledby="startup-title">
			<div className="startup-content">
				<p className="eyebrow">Gentle Dot · Windows</p>
				<h1 id="startup-title" className="gradient-text">Startup checklist</h1>
				<p role="status">
					{connectionFailed ? "The assistant could not connect." : "Waiting for the assistant to connect."}{" "}
					<span>{checkStatus}</span>
				</p>
				<div className="startup-row">
					<button type="button" onClick={refresh}>Refresh checks</button>
					<button type="button" onClick={hidePanel}>Hide panel</button>
				</div>
				<p className="muted">Refresh checks only reads startup status. It does not restart the service or change your profile.</p>
				<ol>
					<Step title="Runtime" state={data ? runtime[data.runtime] : unchecked} />
					<Step title="Data profile" state={data ? profile[data.profile] : unchecked}>
						{offerFreshProfile && (
							<p>
								To try a new profile, quit Gentle Dot from its tray. In a fresh Command Prompt, use
								{" "}<code>{'set "GENTLE_DOT_DATA_DIR=C:\\path\\to\\unused-folder"'}</code>, replacing the example with the
								absolute path of a new, unused local folder. Launch the installed <code>Gentle Dot.exe</code> from that
								same prompt for this launch only, then close the prompt. Do not delete or modify the original profile.
							</p>
						)}
					</Step>
					<Step title="Service" state={serviceRow}>
						{data?.service === "failed" && (
							<p>Resolve any runtime or profile blocker first. Quit and relaunch Gentle Dot to retry the service without reinstalling.</p>
						)}
						{data?.service === "blocked" && (
							<p>Once the blocker is resolved, quit and relaunch Gentle Dot to retry the service.</p>
						)}
					</Step>
					<Step title="Provider" state={["Optional · Not checked", "Configure a provider from chat when it is available."]} />
				</ol>
			</div>
		</main>
	);
}
