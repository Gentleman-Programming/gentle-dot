import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

// The listener's pipe DACL grants exactly the desktop app's minimal access mask, which a Node
// socket cannot request (libuv opens GENERIC_READ|GENERIC_WRITE, which adds READ_CONTROL and
// write-attribute rights the DACL does not grant). The client role therefore runs the same
// CreateFileW mask the app uses, through P/Invoke: connect, write the 36-byte message, close.
// Everything else, from impersonation to delivery, stays on the real native path.
const pipeClientScript = String.raw`
param([string]$PipeId, [string]$CapabilityHex)
$ErrorActionPreference = 'Stop'
Add-Type -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string name, uint access, uint share, System.IntPtr security, uint disposition, uint flags, System.IntPtr template);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool WriteFile(Microsoft.Win32.SafeHandles.SafeFileHandle handle, byte[] buffer, uint count, out uint written, System.IntPtr overlapped);
'@ -Name StopPipeClient -Namespace GentleDot
# FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE: the pipe DACL's exact grant.
$handle = [GentleDot.StopPipeClient]::CreateFileW("\\.\pipe\gentle-dot-stop-$PipeId", 0x100083, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($handle.IsInvalid) { throw "CreateFileW failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
	$frame = [System.Collections.Generic.List[byte]]::new()
	$frame.AddRange([System.Text.Encoding]::ASCII.GetBytes('GDS1'))
	for ($i = 0; $i -lt $CapabilityHex.Length; $i += 2) { $frame.Add([Convert]::ToByte($CapabilityHex.Substring($i, 2), 16)) }
	$written = 0
	if (-not [GentleDot.StopPipeClient]::WriteFile($handle, $frame.ToArray(), [uint32]$frame.Count, [ref]$written, [IntPtr]::Zero)) { throw "WriteFile failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
	if ($written -ne 36) { throw "wrote $written of 36 bytes" }
} finally { $handle.Dispose() }
`;

function runPipeClient(dir: string, id: string, capability: Buffer): void {
	const script = join(dir, "stop-client.ps1");
	writeFileSync(script, pipeClientScript);
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			script,
			"-PipeId",
			id,
			"-CapabilityHex",
			capability.toString("hex"),
		],
		{ encoding: "utf8", windowsHide: true, timeout: 60_000 },
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

	it("delivers one authenticated frame end to end through the real pipe", { timeout: 60_000 }, async () => {
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
		runPipeClient(dir, id, capability);
		const frame = await Promise.race([
			delivered,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("frame not delivered")), 20_000)),
		]);
		expect(frame.subarray(0, 4).toString()).toBe("GDS1");
		expect(frame.subarray(4)).toEqual(capability);
	});
});
