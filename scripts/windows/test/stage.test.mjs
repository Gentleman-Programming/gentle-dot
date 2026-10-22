import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("stage verifies archive bytes with SHA256 on both PowerShell hosts", {
	skip: process.platform !== "win32",
}, () => {
	const source = readFileSync(new URL("../stage.ps1", import.meta.url), "utf8");
	const download = source.slice(
		source.indexOf("function DownloadVerified("),
		source.indexOf("if (-not $env:RUNNER_TEMP)"),
	);
	// Invoke the real download/checksum function offline; only the network is a fixture.
	const script = `
$ErrorActionPreference = 'Stop'
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
} finally { [IO.Directory]::Delete($env:RUNNER_TEMP, $true) }
`;
	for (const host of ["powershell.exe", "pwsh.exe"]) {
		const result = spawnSync(
			host,
			["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
			{ encoding: "utf8", timeout: 30_000, windowsHide: true },
		);
		assert.equal(result.error, undefined, `${host}: ${result.error}`);
		assert.equal(result.status, 0, `${host}: ${result.stderr}`);
	}
});
