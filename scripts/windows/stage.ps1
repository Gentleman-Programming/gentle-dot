# Build-host prerequisites only: Node 24, pnpm from package.json, Git and Go.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Run on native Windows x64.' }
# Use framework APIs rather than module-autoloaded Get-FileHash/Expand-Archive:
# build tools may launch PS5 with a module path inherited from a different host.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
$out = Join-Path $repo 'build/windows/runtime'
if (Test-Path $out) { throw "Staging already exists: $out. Use a clean checkout or remove only that generated folder." }
New-Item -ItemType Directory -Path $out -Force | Out-Null
function Run([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "Build command failed: $program (exit $LASTEXITCODE)" }
}
function DownloadVerified([string]$base, [string]$archive, [string]$checksums) {
    $listing = (Invoke-WebRequest -UseBasicParsing "$base/$checksums").Content
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($archive) + '\s*$'
    if ($listing -notmatch $pattern) { throw "Missing checksum for $archive" }
    $expected = $Matches[1]
    $destination = Join-Path $env:RUNNER_TEMP $archive
    Invoke-WebRequest -UseBasicParsing "$base/$archive" -OutFile $destination
    $stream = [IO.File]::OpenRead($destination)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-','') }
    finally { $sha256.Dispose(); $stream.Dispose() }
    if ($actual -ne $expected) { throw "Checksum mismatch: $archive" }
    return $destination
}
if (-not $env:RUNNER_TEMP) { $env:RUNNER_TEMP = [IO.Path]::GetTempPath() }
Push-Location $repo
try {
    # These releases are pinned; their upstream checksum lists verify the archive bytes.
    $nodeVersion = '24.14.1'
    $nodeArchive = DownloadVerified "https://nodejs.org/dist/v$nodeVersion" "node-v$nodeVersion-win-x64.zip" 'SHASUMS256.txt'
    $unpack = Join-Path $out '_node'
    [IO.Compression.ZipFile]::ExtractToDirectory($nodeArchive, $unpack)
    Move-Item (Join-Path $unpack "node-v$nodeVersion-win-x64") (Join-Path $out 'node')
    Remove-Item $unpack
    Run 'pnpm.cmd' @('--filter','@gentle-dot/daemon','build:runtime','--','--out',$out)
    $node = Join-Path $out 'node/node.exe'
    $npm = Join-Path $out 'node/node_modules/npm/bin/npm-cli.js'
    Push-Location (Join-Path $out 'daemon')
    try { Run $node @($npm,'install','--omit=dev','--no-bin-links','--no-audit','--no-fund','--foreground-scripts') }
    finally { Pop-Location }
    # build:runtime creates the relocatable launcher and scoped private-storage helper.
    $engramVersion = '3.4.0'
    $engramArchive = DownloadVerified "https://github.com/Gentleman-Programming/engram/releases/download/v$engramVersion" "engram_${engramVersion}_windows_amd64.zip" 'checksums.txt'
    $unpack = Join-Path $out '_engram'
    [IO.Compression.ZipFile]::ExtractToDirectory($engramArchive, $unpack)
    $binaries = @(Get-ChildItem $unpack -Filter engram.exe -File -Recurse)
    if ($binaries.Count -ne 1) { throw 'Expected one Engram executable in archive' }
    Move-Item $binaries[0].FullName (Join-Path $out 'bin/engram.exe')
    Remove-Item $unpack -Recurse
    Run 'pnpm.cmd' @('--filter','@gentle-dot/ui','build')
    Copy-Item (Join-Path $repo 'packages/ui/dist/app') (Join-Path $out 'ui') -Recurse
    Run $node @('--version')
    Run (Join-Path $out 'bin/pi.exe') @('--version')
    Run (Join-Path $out 'bin/engram.exe') @('version')
    Run $node @((Join-Path $PSScriptRoot 'runtime-integrity.mjs'),'seal',$out)
} finally { Pop-Location }
