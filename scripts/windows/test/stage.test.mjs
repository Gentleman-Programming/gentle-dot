import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync('C:/Users/maicolj/AppData/Local/Temp/gentle-dot-windows-es-verify/stage-');
const env = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
	const name = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase());
	if (name) env[key] = process.env[name];
}
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR']) {
	env[key] = join(root, key);
	mkdirSync(env[key], { recursive: true });
}
env.OS = 'Windows_NT';
env.PROCESSOR_ARCHITECTURE = 'AMD64';
import test from "node:test";

test("stage verifies archive bytes with SHA256 on available PowerShell hosts", {
	skip: process.platform !== "win32",
}, async (t) => {
	const source = readFileSync(new URL("../stage.ps1", import.meta.url), "utf8");
	const download = source.slice(
		source.indexOf("function DownloadVerified("),
		source.indexOf("if (-not $env:RUNNER_TEMP)"),
	);
	// Invoke the real download/checksum function offline; only the network is a fixture.
	const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${download}
$env:RUNNER_TEMP = [IO.Path]::Combine([IO.Path]::GetTempPath(), [guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($env:RUNNER_TEMP) | Out-Null
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile)
    if ($OutFile) { [IO.File]::WriteAllText($OutFile, 'abc', [Text.Encoding]::ASCII); return }
    return @{ Content = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad archive.zip' }
}
try {
    $valid = DownloadVerified 'https://fixture.invalid' 'archive.zip' 'checksums.txt'
    if ([IO.File]::ReadAllText($valid) -ne 'abc') { throw 'Verified bytes lost' }
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing, $Uri, $OutFile)
        if ($OutFile) { [IO.File]::WriteAllText($OutFile, 'tampered'); return }
        return @{ Content = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad archive.zip' }
    }
    $rejected = $false
    try { DownloadVerified 'https://fixture.invalid' 'archive.zip' 'checksums.txt' | Out-Null }
    catch { if ($_.Exception.Message -notlike 'Checksum mismatch:*') { throw }; $rejected = $true }
    if (-not $rejected) { throw 'Accepted tampered archive' }
} finally { # Retain fixture bytes for parent-authorized cleanup.
}
`;
	for (const host of ["powershell.exe", "pwsh.exe"]) {
		const unavailable = host === 'pwsh.exe' && spawnSync(host, ['-NoProfile', '-Command', 'exit 0'],
			{ env, windowsHide: true, timeout: 30_000 }).error?.code === 'ENOENT';
		await t.test(host, { skip: unavailable ? 'pwsh.exe unavailable; PowerShell 7 not verified' : false }, () => {
			const result = spawnSync(
				host,
				["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
				{ env, encoding: "utf8", timeout: 30_000, windowsHide: true },
			);
			assert.equal(result.error, undefined, `${host}: ${result.error}`);
			assert.equal(result.status, 0, `${host}: ${result.stderr}`);
			assert.equal(result.stdout, '');
			assert.equal(result.stderr, '');
		});
	}
});
