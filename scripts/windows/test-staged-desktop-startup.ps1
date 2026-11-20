<#
.SYNOPSIS
CI-only startup check of the same-build native desktop and already verified staged runtime, without NSIS.
After verifying Node version, quietly preflights CLI syntax, CLI self-check and addon loading before managed startup.
.PARAMETER Runtime
Explicit staged runtime previously verified against the producer runtime manifest.
.PARAMETER Desktop
Exact desktop executable transferred separately from the same producer.
.PARAMETER DesktopSha256
Lowercase SHA-256 from the producer, checked before execution.
.PARAMETER DiagnosticsPath
Optional new .json file for allowlisted outcome, exit code and probe metadata only.
After a failed startup decision, the final loopback sample does not require an owned listener.
#>
param([string]$Runtime = '', [string]$Desktop = '', [string]$DesktopSha256 = '', [string]$DiagnosticsPath = '')

. "$PSScriptRoot/test-daemon-startup.ps1" -Runtime $Runtime -DiagnosticsPath $DiagnosticsPath

function Test-StagedNodeVersion($Info) {
    Initialize-DaemonStartupOwner
    $owner = [GentleDot.CI.OwnedDaemon]::CheckNodeVersion($Info.FileName, $Info.WorkingDirectory, $Info.Environment)
    try {
        $clock = New-DaemonStartupClock
        while (-not $owner.HasExited -and $clock.ElapsedMilliseconds -lt 5000) { Wait-DaemonStartupPoll }
        $passed = $owner.ExitCode -eq 0
    } finally { $clean = Stop-DaemonStartupProcess $owner }
    return ($passed -and $clean)
}

function Invoke-StagedPackagedPreflight($Info) {
    foreach ($stage in @('syntax','self-check','addon')) {
        $probeOwner = $null; $passed = $false; $clean = $true
        try {
            Initialize-DaemonStartupOwner
            $probeOwner = switch ($stage) {
                'syntax' { [GentleDot.CI.OwnedDaemon]::CheckCliSyntax($Info.WorkingDirectory, $Info.Environment) }
                'self-check' { [GentleDot.CI.OwnedDaemon]::CheckCliSelfCheck($Info.WorkingDirectory, $Info.Environment) }
                'addon' {
                    # The restored inventory is already verified. Require this exact regular
                    # file before Node can try extension or directory resolution fallbacks.
                    $addon = Join-Path $Info.WorkingDirectory 'daemon/native/windows-stop.node'
                    $attributes = [IO.File]::GetAttributes($addon)
                    if ($attributes -band ([IO.FileAttributes]'Directory, ReparsePoint, Device')) {
                        throw 'Packaged addon is not a regular file'
                    }
                    [GentleDot.CI.OwnedDaemon]::CheckWindowsAddon($Info.WorkingDirectory, $Info.Environment)
                }
            }
            $clock = New-DaemonStartupClock
            while ($clock.ElapsedMilliseconds -lt 5000 -and -not $probeOwner.HasExited) { Wait-DaemonStartupPoll }
            $passed = $clock.ElapsedMilliseconds -lt 5000 -and $probeOwner.ExitCode -eq 0
        } catch { $passed = $false }
        finally {
            if ($null -ne $probeOwner) {
                try { $clean = Stop-DaemonStartupProcess $probeOwner } catch { $clean = $false }
            }
        }
        if (-not $clean) { return "preflight-$stage-cleanup-failed" }
        if (-not $passed) { return "preflight-$stage" }
    }
    return 'passed'
}

function Get-StagedListenerPid($Owner, [int]$Port, [string]$NodePath) {
    # The health endpoint is public. Require an unambiguous IPv4 loopback listener
    # whose live process is the verified Node image and is in our private job.
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') })
    if ($listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1') {
        $listenerPid = $listeners[0].OwningProcess
        if ($Owner.OwnsLiveImage($listenerPid, $NodePath)) { return $listenerPid }
    }
}

function Test-StagedStartupTraceHost {
    return ($IsWindows -and $env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and
        $env:RUNNER_ENVIRONMENT -ceq 'github-hosted' -and $env:GITHUB_JOB -ceq 'checks' -and
        $env:GITHUB_REPOSITORY -ceq 'Gentleman-Programming/gentle-dot' -and
        $env:GITHUB_WORKFLOW -ceq 'Windows storage diagnostic 44794993333' -and
        $env:GITHUB_EVENT_NAME -ceq 'push' -and $env:GITHUB_REF -ceq 'refs/heads/qa/windows-storage-diagnostic-44794993333')
}

function Invoke-StagedDesktopStartup {
    param([string]$Runtime, [string]$Desktop, [string]$DesktopSha256, [string]$DiagnosticsPath = '',
        [int]$TracePort, [string]$TraceId)
    $ErrorActionPreference = 'Stop'
    if ($env:CI -cne 'true') { return 'staged-desktop-startup-not-ci' }
    # Internal opt-in only: the preview CLI exposes neither field.
    $trace = $PSBoundParameters.ContainsKey('TracePort') -or $PSBoundParameters.ContainsKey('TraceId')
    if ($trace -and (-not (Test-StagedStartupTraceHost) -or $TracePort -lt 1 -or $TracePort -gt 65535 -or
        $TraceId -cnotmatch '\A[a-f0-9]{32}\z' -or $DiagnosticsPath)) { return 'staged-desktop-startup-trace-refused' }
    try {
        if (-not $Runtime) { return 'staged-desktop-startup-invalid-runtime' }
        $Runtime = [IO.Path]::GetFullPath($Runtime)
        $nodePath = Join-Path $Runtime 'node/node.exe'
        if (-not [IO.File]::Exists($nodePath) -or -not [IO.File]::Exists((Join-Path $Runtime 'daemon/cli.mjs'))) {
            return 'staged-desktop-startup-invalid-runtime'
        }
    } catch { return 'staged-desktop-startup-invalid-runtime' }
    $image = $null
    try {
        if (-not $Desktop -or $DesktopSha256 -cnotmatch '^[0-9a-f]{64}\z') { return 'staged-desktop-startup-desktop-identity' }
        $Desktop = [IO.Path]::GetFullPath($Desktop)
        # Share only reads; pin these bytes against write/delete until after job cleanup.
        $image = [IO.File]::Open($Desktop, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ((Get-FileHash -Algorithm SHA256 -InputStream $image).Hash.ToLowerInvariant() -cne $DesktopSha256) {
            $image.Dispose()
            return 'staged-desktop-startup-desktop-identity'
        }
    } catch {
        if ($null -ne $image) { $image.Dispose() }
        return 'staged-desktop-startup-desktop-identity'
    }

    $owner = $null; $probe = $null; $alive = $null; $exitCode = $null; $pollCount = 0
    $kind = 'other'; $outcome = 'failed'; $listenerState = $null
    try {
        Import-Module "$PSScriptRoot/smoke-diagnostics.psm1" -Force
        $scratch = New-DaemonStartupScratch
        $port = Get-DaemonStartupPort
        $memoryPort = Get-DaemonStartupPort
        if ($port -eq $memoryPort) { throw 'Repeated ephemeral port' }
        $envMap = New-DaemonStartupEnvironment -Runtime $Runtime -Scratch $scratch -Port $port
        # The desktop forwards this same absolute staged override as GENTLE_DOT_RUNTIME
        # when it launches Node. Snapshot the typed allowlist before building the desktop's env.
        $preflightInfo = New-DaemonStartupStartInfo -Runtime $Runtime -Environment $envMap
        $envMap.Remove('GENTLE_DOT_RUNTIME')
        $envMap['GENTLE_DOT_RUNTIME_DIR'] = $Runtime
        $envMap['GENTLE_DOT_ENGRAM'] = 'private'
        $envMap['GENTLE_DOT_ENGRAM_PORT'] = [string]$memoryPort
        $envMap['GENTLE_DOT_PREVIEW_MEMORY_ADMISSION'] = '1'
        $envMap['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $scratch 'webview'
        foreach ($key in @('GENTLE_DOT_DATA_DIR','HOME','APPDATA','LOCALAPPDATA','TEMP','XDG_CACHE_HOME','WEBVIEW2_USER_DATA_FOLDER')) {
            [void][IO.Directory]::CreateDirectory($envMap[$key])
        }
        $info = New-DaemonStartupStartInfo -Runtime $Runtime -Environment $envMap
        if (-not (Test-StagedNodeVersion $info)) {
            $outcome = 'node-version'
        } elseif (($outcome = Invoke-StagedPackagedPreflight $preflightInfo) -eq 'passed') {
            $outcome = 'failed' # Only managed health below can declare success.
            $info.FileName = $Desktop
            $info.ArgumentList.Clear() # Genuine desktop manager; no raw Node CLI arguments.
            if ($trace) {
                # Add only after quiet preflights, to the already isolated desktop map.
                $info.Environment['CI'] = 'true'
                $info.Environment['GITHUB_ACTIONS'] = 'true'
                $info.Environment['GENTLE_DOT_CI_TRACE_PORT'] = [string]$TracePort
                $info.Environment['GENTLE_DOT_CI_TRACE_ID'] = $TraceId
            }
            $owner = New-DaemonStartupOwner $info
            $clock = New-DaemonStartupClock
            $outcome = 'timeout'; $kind = 'timeout'; $listenerState = 'notobserved'
            while ($clock.ElapsedMilliseconds -lt 30000) {
                if (Test-DaemonStartupExited $owner) { $outcome = 'earlyexit'; $kind = 'earlyexit'; break }
                $pollCount++
                $listener = Get-StagedListenerPid $owner $port $nodePath
                if ($null -ne $listener -and $clock.ElapsedMilliseconds -lt 30000) {
                    $listenerState = 'observed'
                    $probe = Get-DaemonStartupDiagnosticProbe -Port $port
                    if ($probe.tcpState -eq 'connected' -and $probe.httpState -eq 'response' -and
                        $probe.httpStatus -eq 200 -and $probe.jsonState -eq 'valid' -and $probe.healthState -eq 'valid' -and
                        (Get-StagedListenerPid $owner $port $nodePath) -eq $listener -and
                        $clock.ElapsedMilliseconds -lt 30000 -and -not (Test-DaemonStartupExited $owner)) {
                        $outcome = 'passed'; $kind = 'success'; break
                    }
                }
                Wait-DaemonStartupPoll
            }
        }
    } catch { $outcome = 'failed'; $kind = 'other' }
    finally {
        if ($null -ne $owner) {
            if ($DiagnosticsPath) {
                try {
                    $alive = -not (Test-DaemonStartupExited $owner)
                    if (-not $alive -and $null -ne $owner.ExitCode) { $exitCode = [int]$owner.ExitCode }
                } catch { $alive = $null; $exitCode = $null }
                if ($outcome -ne 'passed') {
                    # The decision is final. This snapshot does not establish ownership.
                    try { $probe = Get-DaemonStartupDiagnosticProbe -Port $port } catch { $probe = $null }
                }
            }
            try { if (-not (Stop-DaemonStartupProcess $owner)) { $outcome = 'cleanup-failed'; $kind = 'other' } }
            catch { $outcome = 'cleanup-failed'; $kind = 'other' }
        }
        $image.Dispose()
        if ($DiagnosticsPath) {
            try {
                $diagnostic = New-SmokeDiagnostic -Outcome $kind -Alive $alive -ExitCode $exitCode -PollCount $pollCount -ErrorKind 'none' -Probe $probe -StagedListenerState $listenerState
                Write-SmokeDiagnostic -Path $DiagnosticsPath -Diagnostic $diagnostic
            } catch { }
        }
    }
    return "staged-desktop-startup-$outcome"
}

if ($MyInvocation.InvocationName -ne '.') {
    $outcome = Invoke-StagedDesktopStartup -Runtime $Runtime -Desktop $Desktop -DesktopSha256 $DesktopSha256 -DiagnosticsPath $DiagnosticsPath
    Write-Output $outcome
    if ($outcome -eq 'staged-desktop-startup-passed') { exit 0 }
    exit 1
}
