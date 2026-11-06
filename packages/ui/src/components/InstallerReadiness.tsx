import { useEffect, useState } from "react";
import { inDesktop, installerReadiness, type InstallerSnapshot } from "../desktop.ts";

type Result = { kind: "loading" } | { kind: "error" } | { kind: "report"; report: InstallerSnapshot };

/** A one-shot native query plus explicit refresh; never an installer or a readiness verdict. */
export function InstallerReadiness() {
	const desktop = inDesktop();
	const [revision, setRevision] = useState(0);
	const [result, setResult] = useState<Result>({ kind: "loading" });
	useEffect(() => {
		if (!desktop) return;
		let live = true;
		setResult({ kind: "loading" });
		installerReadiness().then(
			(report) => { if (live) setResult({ kind: "report", report }); },
			() => { if (live) setResult({ kind: "error" }); },
		);
		return () => { live = false; };
	}, [desktop, revision]);
	if (!desktop) return null;
	const report = result.kind === "report" ? result.report : undefined;
	return (
		<section className="provider-section" aria-label="Bundled runtime diagnostics" aria-busy={result.kind === "loading"}>
			<h3>Bundled runtime diagnostics</h3>
			<p className="muted">Read-only local file presence, not installation readiness or publisher verification.</p>
			{result.kind === "loading" ? <p aria-live="polite">Checking bundled files…</p> : null}
			{result.kind === "error" ? <p className="settings-error" role="alert">Bundled-file checks unavailable.</p> : null}
			{report ? <div aria-live="polite">
				<p>App process OS: {report.processOs}. Compiled architecture: {report.compiledArch}.</p>
				<p>Packaged runtime target: {report.runtimeTarget ?? "Unknown (unsupported mapping)"}.</p>
				<ul>{report.checks.map((check) => <li key={check.path}>
					{check.path} — {check.status === "present" ? "Present" : check.status === "missing" ? "Missing" : "Unknown"}
				</li>)}</ul>
			</div> : null}
			<p className="muted">OS version, physical CPU and system prerequisites: Unknown. Component versions and signatures are not checked. This cannot diagnose requirements before the native UI starts.</p>
			<button type="button" disabled={result.kind === "loading"} onClick={() => setRevision((value) => value + 1)}>
				Refresh bundled-file checks
			</button>
		</section>
	);
}
