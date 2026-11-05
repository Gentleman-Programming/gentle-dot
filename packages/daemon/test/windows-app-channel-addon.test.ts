import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { windowsStopArtifact } from "../src/windows-stop.ts";

const artifact = windowsStopArtifact();
const fixture = new URL("./fixtures/windows-app-channel-refuse.mjs", import.meta.url);
// Windows CI must fail, not skip, if its preceding addon build did not produce the artifact.
const skipReason =
	process.platform !== "win32"
		? "real addon requires Windows"
		: !existsSync(artifact) && !process.env.CI
			? "build native/windows-stop.node to run locally"
			: undefined;
// Failure enum in native/windows-app-channel.h (zero-based).
const NODE_IPC_COLLISION = 1;
const NOT_PIPE = 4;

function refuse(mode: "ipc" | "file" | "twice") {
	expect(existsSync(artifact), "Windows CI requires the built windows-stop.node artifact").toBe(true);
	// Inherit a regular file as fd3, never a pipe. No temporary file or cleanup race.
	const fd = openSync(fixture, "r");
	try {
		const env = { ...process.env };
		delete env.NODE_CHANNEL_FD;
		const child = spawnSync(process.execPath, [fileURLToPath(fixture), fileURLToPath(artifact), mode], {
			env,
			stdio: ["ignore", "pipe", "pipe", fd],
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(child.error).toBeUndefined();
		expect(child.signal).toBeNull();
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		return JSON.parse(child.stdout);
	} finally {
		closeSync(fd);
	}
}
function expectRefusal(result: unknown, failure: number) {
	expect(result).toEqual({
		message: "App channel adoption failed; refuse startup",
		evidence: {
			failure,
			win32Error: expect.any(Number),
			ntStatus: 0,
			uvError: 0,
			streamError: 0,
			originalRemoved: false,
		},
	});
}

describe.skipIf(Boolean(skipReason))(`real Windows app-channel addon (${skipReason ?? "built"})`, () => {
	it("refuses visible NODE_CHANNEL_FD=3 with collision evidence", () => {
		const [result] = refuse("ipc");
		expectRefusal(result, NODE_IPC_COLLISION);
		expect(result.evidence.win32Error).toBe(0);
	});
	it("refuses a regular file at fd3 with not_pipe evidence", () => {
		const [result] = refuse("file");
		expectRefusal(result, NOT_PIPE);
		// GetFileType answered FILE_TYPE_DISK without failing: there is no error code to record.
		expect(result.evidence.win32Error).toBe(0);
	});
	it("refuses a second adoption attempt even after the first failed", () => {
		const [first, second] = refuse("twice");
		expectRefusal(first, NOT_PIPE);
		expect(second).toEqual({
			message: "Process app channel adoption already attempted",
			code: "ERR_APP_CHANNEL_ADOPTION",
		});
	});
});
