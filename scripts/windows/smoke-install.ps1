<#
.SYNOPSIS
Runs the explicitly authorized NSIS lifecycle with repo-local isolated test data.
.PARAMETER Installer
Path to the setup executable. Destination must fit the verified staged runtime budget.
.PARAMETER DiagnosticsPath
Optional new JSON file for bounded sanitized startup metadata (no logs or profile contents).
Omit to retain the existing invocation without diagnostic output.
#>
param([Parameter(Mandatory=$true)][string]$Installer, [string]$DiagnosticsPath = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$outcome = 'other'; $pollCount = 0; $health = $null
$alive = $null; $exitCode = $null; $reachable = $null; $httpStatus = $null; $errorKind = 'none'; $probe = $null
try {
if ($DiagnosticsPath) { Import-Module "$PSScriptRoot/smoke-diagnostics.psm1" -Force }
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
$scratch = Join-Path $repo ('build/windows/qa-' + [guid]::NewGuid().ToString('N'))
$destination = Join-Path $scratch 'Installed Gentle Dot'
$runtime = Join-Path $repo 'build/windows/runtime'
# Refuse before any QA writes; do not fall back to paths outside the repository.
$checkedDestination = & node "$PSScriptRoot/installer-path-guard.mjs" destination $runtime $destination
if ($LASTEXITCODE -ne 0) { throw 'Repository-local QA destination cannot fit the staged payload; see exact budget above.' }
$destination = [string]$checkedDestination
$data = Join-Path $scratch 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$canary = Join-Path $data 'upgrade-canary.txt'
Set-Content $canary 'preserve-user-data'
$manifest = Join-Path $repo 'build/windows/runtime/WINDOWS-INTEGRITY.json'
function Install {
    # NSIS consumes the final /D argument verbatim, including spaces (do not quote its value).
    $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $destination) -WindowStyle Hidden -PassThru
    if (-not $setup.WaitForExit(180000)) { $setup.Kill(); throw 'Installer timeout' }
    if ($setup.ExitCode -ne 0) { throw "Installer exit $($setup.ExitCode)" }
}
function VerifyRuntime {
    & node "$PSScriptRoot/runtime-integrity.mjs" verify (Join-Path $destination 'runtime') $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime differs from the staged tree' }
}
Install
VerifyRuntime
$binary = Join-Path $destination 'gentle-dot.exe'
if (-not (Test-Path $binary)) { throw 'Installed desktop executable is missing' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$names = @('GENTLE_DOT_DATA_DIR','GENTLE_DOT_PORT','GENTLE_DOT_ENGRAM','HOME','ENGRAM_BIN','ENGRAM_URL','ENGRAM_STARTUP_POLICY','GENTLE_PI_GENTLE_AI_DEV_BINARY')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$app = $null
try {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
    $env:GENTLE_DOT_DATA_DIR = $data
    $env:GENTLE_DOT_PORT = [string]$port
    $env:GENTLE_DOT_ENGRAM = 'private'
    $app = Start-Process -FilePath $binary -WorkingDirectory $destination -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(240)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($app.HasExited) { $outcome = 'earlyexit'; throw "Installed app exited early: $($app.ExitCode)" }
        $pollCount++
        $httpStatus = $null; $reachable = $null
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
            $reachable = $true; $errorKind = 'none'
        } catch {
            $health = $null
            if ($DiagnosticsPath) {
                # Exception type and numeric status only; never serialize the error record.
                try {
                    $errorKind = Get-SmokeErrorKind $_.Exception
                    $response = $_.Exception.PSObject.Properties['Response']
                    if ($null -ne $response -and $null -ne $response.Value) {
                        $httpStatus = [int]$response.Value.StatusCode
                        $reachable = $true
                    }
                } catch { $errorKind = 'other' }
            }
        }
        if ($null -ne $health -and $health.agentState -eq 'error') { $outcome = 'agenterror'; throw 'Agent startup returned error' }
        if ($null -ne $health -and $health.agentState -eq 'idle') { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { $outcome = 'timeout'; throw 'Installed app did not reach agentState=idle within 240 seconds' }
    VerifyRuntime
} finally {
    # One bounded diagnostic-only observation after the readiness decision, before cleanup.
    # It must never become a readiness input or replace the original failure.
    if ($DiagnosticsPath) {
        try { $probe = Get-SmokeObservation -Port $port } catch { $probe = @{} }
        try {
            if ($null -ne $app) {
                $alive = -not $app.HasExited
                if (-not $alive) { $exitCode = $app.ExitCode }
            }
        } catch { $alive = $null; $exitCode = $null }
    }
    # CI cleanup, NOT evidence of the product's graceful shutdown or panic-stop behavior.
    if ($null -ne $app -and -not $app.HasExited) {
        & taskkill.exe /PID $app.Id /T /F | Out-Null
        if ($LASTEXITCODE -ne 0 -and -not $app.HasExited) { Write-Warning 'Owned test process cleanup failed' }
    }
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}
# Reinstall only after cleanup: upgrading while running remains a separate acceptance check.
Install
VerifyRuntime
if ((Get-Content $canary -Raw).Trim() -ne 'preserve-user-data') { throw 'Reinstall modified user data' }
$uninstall = Join-Path $destination 'uninstall.exe'
if (-not (Test-Path $uninstall)) { throw 'Uninstaller missing' }
$process = Start-Process -FilePath $uninstall -ArgumentList '/S' -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Uninstall timeout' }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path $binary) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (Test-Path $binary) { throw 'Uninstall left the desktop executable installed' }
if (-not (Test-Path $canary)) { throw 'Uninstall removed user data' }
$outcome = 'success'
Write-Output 'Installation, runtime hashes, daemon readiness, stopped-app reinstall and uninstall passed.'
} finally {
    if ($DiagnosticsPath) {
        try {
            $diagnostic = New-SmokeDiagnostic -Outcome $outcome -Alive $alive -ExitCode $exitCode -PollCount $pollCount -Reachable $reachable -HttpStatus $httpStatus -Health $health -ErrorKind $errorKind -Probe $probe
            Write-SmokeDiagnostic -Path $DiagnosticsPath -Diagnostic $diagnostic
        } catch { Write-Warning 'Sanitized smoke diagnostics unavailable' -WarningAction Continue }
    }
}
