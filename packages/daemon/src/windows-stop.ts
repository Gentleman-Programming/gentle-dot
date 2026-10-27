/** Source lives in src/, while the bundle lives directly in daemon/. */
export function windowsStopArtifact(entry = new URL(import.meta.url)): URL {
	return new URL(
		entry.pathname.endsWith(".ts") ? "../native/windows-stop.node" : "./native/windows-stop.node",
		entry,
	);
}
