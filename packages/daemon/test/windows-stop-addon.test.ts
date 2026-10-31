import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { windowsStopArtifact } from "../src/windows-stop.ts";

const artifact = windowsStopArtifact();
// Windows CI must fail, not skip, if its preceding addon build did not produce the artifact.
const skipReason =
	process.platform !== "win32"
		? "real addon requires Windows"
		: !existsSync(artifact) && !process.env.CI
			? "build native/windows-stop.node to run locally"
			: undefined;

interface StopListener {
	capability: Buffer;
	close(): Promise<void>;
}

/** Windows PowerShell 5.1 (always present on the runners) runs one script and prints one line. */
function powershell(script: string): string {
	return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
	}).trim();
}

/**
 * The stop record identifies the process that reads it: PID plus the process creation FILETIME
 * (100 ns ticks since 1601), which `Get-Process .StartTime.ToFileTimeUtc()` reproduces exactly.
 */
function recordIdentity(): { sid: string; ticks: string } {
	const sid = powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
	const ticks = powershell(`(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`);
	return { sid, ticks };
}

/** The reader accepts only a protected DACL whose every explicit ACE allows the owner alone. */
function protectRecord(path: string, sid: string): void {
	powershell(
		`$sid = New-Object System.Security.Principal.SecurityIdentifier('${sid}'); ` +
			`$acl = New-Object System.Security.AccessControl.FileSecurity; ` +
			`$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow'); ` +
			`$acl.SetOwner($sid); $acl.SetAccessRule($rule); $acl.SetAccessRuleProtection($true, $false); ` +
			`[System.IO.File]::SetAccessControl('${path.replaceAll("\\", "\\\\")}', $acl)`,
	);
}

/** Five lines, trailing newline: format, PID, creation ticks, pipe id, 32-byte capability hex. */
function writeRecord(
	dir: string,
	id: string,
	capability: Buffer,
	identity: { sid: string; ticks: string },
): string {
	const path = join(dir, `stop-${id}.record`);
	writeFileSync(
		path,
		`gentle-dot-stop-v1\n${process.pid}\n${identity.ticks}\n${id}\n${capability.toString("hex")}\n`,
	);
	protectRecord(path, identity.sid);
	return path;
}

describe.skipIf(Boolean(skipReason))(`real Windows stop listener addon (${skipReason ?? "built"})`, () => {
	const require = createRequire(import.meta.url);
	const dir = join(tmpdir(), `gentle-dot-stop-addon-${process.pid}-${Date.now()}`);
	const listeners: StopListener[] = [];

	afterEach(async () => {
		await Promise.all(listeners.splice(0).map((listener) => listener.close().catch(() => {})));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("refuses a second exclusive listener on the same record", () => {
		mkdirSync(dir, { recursive: true });
		const addon = require(fileURLToPath(artifact)) as {
			createStopListener(path: string, callback: (frame: Buffer) => void): StopListener;
		};
		const record = writeRecord(dir, randomBytes(16).toString("hex"), randomBytes(32), recordIdentity());
		const first = addon.createStopListener(record, () => {});
		listeners.push(first);
		expect(first.capability).toHaveLength(32);
		// FILE_FLAG_FIRST_PIPE_INSTANCE with nMaxInstances 1: the record's pipe admits one
		// listener per launch, so a second CreateNamedPipeW on it must refuse startup.
		expect(() => addon.createStopListener(record, () => {})).toThrow("Cannot exclusively own stop pipe");
	});

	it("delivers one authenticated frame end to end through the real pipe", async () => {
		mkdirSync(dir, { recursive: true });
		const addon = require(fileURLToPath(artifact)) as {
			createStopListener(path: string, callback: (frame: Buffer) => void): StopListener;
		};
		const id = randomBytes(16).toString("hex");
		const capability = randomBytes(32);
		const record = writeRecord(dir, id, capability, recordIdentity());
		const delivered = new Promise<Buffer>((resolve) => {
			const listener = addon.createStopListener(record, (frame) => resolve(Buffer.from(frame)));
			listeners.push(listener);
		});
		const client = connect(`\\\\.\\pipe\\gentle-dot-stop-${id}`);
		try {
			await new Promise<void>((resolve, reject) => {
				client.once("connect", resolve);
				client.once("error", reject);
			});
			client.write(Buffer.concat([Buffer.from("GDS1"), capability]));
			const frame = await Promise.race([
				delivered,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("frame not delivered")), 10_000)),
			]);
			expect(frame.subarray(0, 4).toString()).toBe("GDS1");
			expect(frame.subarray(4)).toEqual(capability);
		} finally {
			client.destroy();
		}
	});
});
