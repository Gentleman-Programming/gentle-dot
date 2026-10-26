import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// Exact UTF-8 bytes observed from the official v3.4.0 checksums.txt via PS5.
// This is recorded network evidence, not a claim that fixtures download an archive.
const observedListing = `3c5bdc73d226af5629cf4f4a781e223142e37c1ebb443c4b596f2e284352e381  engram_3.4.0_darwin_amd64.tar.gz
d0aa59c9a83d17ae3fc7f5dd31fdab6a26fd8c00fc5e692195753cd0719294f7  engram_3.4.0_darwin_arm64.tar.gz
715fda625556e46d65ddb4526bb7f88a3fee5339ca3c44ce44cc652f17fa57f1  engram_3.4.0_linux_amd64.tar.gz
3309e9c0bbb539d183fd5aa9f9a13cd7aa0e81ec2512b5bedefb8b2bdd35b3e5  engram_3.4.0_linux_arm64.tar.gz
3065736ec7ff8137eb3fc607275f542ea13bb743a5157318c8a8770f11ce3289  engram_3.4.0_windows_amd64.zip
7463872a85a5e5434cf958bdffc71dda1926bced30d3b6b38c80fec9bb98fbba  engram_3.4.0_windows_arm64.zip
`;

function checksumRegressionScript(download) {
	return `
$ErrorActionPreference = 'Stop'
${download}
$env:RUNNER_TEMP = [IO.Path]::Combine([IO.Path]::GetTempPath(), [guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($env:RUNNER_TEMP) | Out-Null
$script:listing = $null
$script:archiveBytes = 'abc'
$script:downloads = 0
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile)
    if ($OutFile) {
        $script:downloads++
        [IO.File]::WriteAllText($OutFile, $script:archiveBytes, [Text.Encoding]::ASCII)
        return
    }
    return @{ Content = $script:listing }
}
function Check-Rejection($archive, $message, $downloads) {
    $script:downloads = 0
    $returned = $null
    $caught = $null
    try { $returned = DownloadVerified 'https://fixture.invalid' $archive 'checksums.txt' }
    catch { $caught = $_.Exception.Message }
    if ($caught -ne $message) { throw "Expected '$message'; got '$caught'" }
    if ($returned -or $script:downloads -ne $downloads) { throw 'Invalid rejection effects' }
    # Only verified return values may reach the staging consumer.
    $staged = Join-Path $env:RUNNER_TEMP 'staged.zip'
    if ($returned) { [IO.File]::Copy($returned, $staged) }
    if ([IO.File]::Exists($staged)) { throw 'Rejected archive staged' }
}
try {
    $script:listing = [Convert]::FromBase64String('${Buffer.from(observedListing).toString("base64")}')
    Check-Rejection 'engram_3.4.0_windows_amd64.zip' 'Checksum mismatch: engram_3.4.0_windows_amd64.zip' 1
    $validListing = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  archive.zip' + [char]10
    foreach ($content in @($validListing, [Text.Encoding]::UTF8.GetBytes($validListing))) {
        $script:listing = $content
        $script:archiveBytes = 'abc'
        $script:downloads = 0
        $valid = DownloadVerified 'https://fixture.invalid' 'archive.zip' 'checksums.txt'
        if ([IO.File]::ReadAllText($valid) -ne 'abc' -or $script:downloads -ne 1) { throw 'Verified bytes lost' }
        $script:archiveBytes = 'tampered'
        Check-Rejection 'archive.zip' 'Checksum mismatch: archive.zip' 1
        Check-Rejection 'missing.zip' 'Missing checksum for missing.zip' 0
        if ([IO.File]::Exists((Join-Path $env:RUNNER_TEMP 'missing.zip'))) { throw 'Missing entry downloaded' }
    }
    [Console]::WriteLine('PS5 checksum regression passed')
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally { [IO.Directory]::Delete($env:RUNNER_TEMP, $true) }
`;
}

test("stage handles observed PS5 checksum bytes and fails closed", {
	skip: process.platform !== "win32",
}, () => {
	const source = readFileSync(new URL("../stage.ps1", import.meta.url), "utf8");
	const download = source.slice(source.indexOf("function DownloadVerified("), source.indexOf("if (-not $env:RUNNER_TEMP)"));
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"],
	{ input: checksumRegressionScript(download), encoding: "utf8", timeout: 30_000, windowsHide: true });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, `stdout=${result.stdout}; stderr=${result.stderr}`);
	assert.equal(result.stdout.trim(), "PS5 checksum regression passed");
	assert.equal(result.stderr, "");
});

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
