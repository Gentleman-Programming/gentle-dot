# Hosted staged diagnostic only. Dot-source for inert tests and the stage environment builder.
function Test-StagedDaemonPhaseHost {
    return ($env:OS -ceq 'Windows_NT' -and
        [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ceq 'X64' -and
        $env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and
        $env:RUNNER_ENVIRONMENT -ceq 'github-hosted' -and $env:RUNNER_OS -ceq 'Windows' -and
        $env:RUNNER_ARCH -ceq 'X64' -and $env:GITHUB_RUN_ATTEMPT -ceq '1' -and
        $env:GITHUB_JOB -ceq 'observe' -and $env:GITHUB_REPOSITORY -ceq 'Gentleman-Programming/gentle-dot' -and
        $env:GITHUB_WORKFLOW -ceq 'Windows staged daemon phases 44794993333' -and $env:GITHUB_EVENT_NAME -ceq 'push' -and
        $env:GITHUB_REF -ceq 'refs/heads/qa/windows-private-memory-reasons-45201908966' -and
        $env:GITHUB_WORKFLOW_REF -ceq 'Gentleman-Programming/gentle-dot/.github/workflows/windows-staged-daemon-phases-44794993333.yml@refs/heads/qa/windows-private-memory-reasons-45201908966')
}

function New-StagedDaemonPhaseBuildInfo([string]$Shell) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Shell
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment.Clear()
    # stage.ps1 -> pnpm.cmd -> build:runtime inherits this explicit map. Neither a
    # shell startup profile nor ambient package-manager settings enter this process.
    foreach ($key in @('OS','Path','PATHEXT','COMSPEC','SystemDrive','SystemRoot','WINDIR',
        'ProgramFiles','ProgramFiles(x86)','ProgramData','CommonProgramFiles','USERPROFILE','HOME','LOCALAPPDATA','APPDATA',
        'TEMP','TMP','RUNNER_TEMP','INCLUDE','LIB','LIBPATH','VCToolsInstallDir','WindowsSdkDir',
        'CI','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','RUNNER_ARCH','GITHUB_RUN_ATTEMPT',
        'GITHUB_JOB','GITHUB_REPOSITORY','GITHUB_EVENT_NAME','GITHUB_REF','GITHUB_WORKFLOW','GITHUB_WORKFLOW_REF')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value) { $info.Environment[$key] = $value }
    }
    $info.Environment['GENTLE_DOT_CI_DAEMON_PHASE_BUILD'] = '1'
    return $info
}

function New-StagedDaemonPhaseReceiver {
    $socket = [Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,
        [Net.Sockets.SocketType]::Dgram, [Net.Sockets.ProtocolType]::Udp)
    try {
        $socket.ExclusiveAddressUse = $true
        $socket.Blocking = $false
        $socket.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 43194))
        return $socket
    } catch { $socket.Dispose(); throw }
}

# In A-M wire order; only the terminal status byte of stage 4 can use these reasons.
function Get-StagedDaemonPrivateMemoryReasons {
    'config-reread','preview-prerequisites','invalid-port','query-spawn','query-timeout','query-nonzero',
    'query-stderr','query-parse','multiple-listeners','identity-missing','identity-mismatch','recheck-changed','recheck-unverified'
}

function Read-StagedDaemonPhaseReceiver($Socket, [string]$Id) {
    if ($Socket.Blocking -or -not $Socket.ExclusiveAddressUse -or
        $Socket.SocketType -ne [Net.Sockets.SocketType]::Dgram -or $Socket.LocalEndPoint.Port -ne 43194 -or
        -not $Socket.LocalEndPoint.Address.Equals([Net.IPAddress]::Loopback) -or
        $Id -cnotmatch '\A[a-f0-9]{32}\z') { return 'inconclusive' }
    $stages = @('configuration','managed-stop','fd3','private-memory')
    $buffer = [byte[]]::new(36) # exactly 35 bytes required; truncation is rejection
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $sender = $null; $projection = 'inconclusive'; $terminal = $false
    try {
        # At most four frames; the fifth probe detects excess, not another checkpoint.
        for ($i = 0; $i -le 4 -and $clock.ElapsedMilliseconds -lt 1000; $i++) {
            if (-not $Socket.Poll(0, [Net.Sockets.SelectMode]::SelectRead)) { return $projection }
            if ($i -eq 4 -or $terminal) { break }
            [Net.EndPoint]$peer = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
            $length = $Socket.ReceiveFrom($buffer, [ref]$peer)
            if ($length -ne 35 -or -not $peer.Address.Equals([Net.IPAddress]::Loopback)) { break }
            if ($null -eq $sender) { $sender = $peer.Port }
            elseif ($peer.Port -ne $sender) { break }
            $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $length)
            if (-not $text.StartsWith("$Id $($i + 1)", [StringComparison]::Ordinal)) { break }
            switch -CaseSensitive ($text[34]) {
                '+' { $projection = "$($stages[$i])-completed" }
                '-' { $projection = "$($stages[$i])-failed"; $terminal = $true }
                default {
                    $index = 'ABCDEFGHIJKLM'.IndexOf([char]$text[34])
                    if ($i -ne 3 -or $index -lt 0) { return 'inconclusive' }
                    $projection = "private-memory-failed-$((Get-StagedDaemonPrivateMemoryReasons)[$index])"
                    $terminal = $true
                }
            }
        }
    } catch { } # WouldBlock, truncation or receiver failure cannot project a partial prefix.
    return 'inconclusive'
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $socket = $null
    $failure = 'daemon-phases-host-refused'
    try {
        if ($args.Count -or -not (Test-StagedDaemonPhaseHost)) { throw 'host' }
        $failure = 'daemon-phases-input-refused'
        . "$PSScriptRoot/../test-staged-desktop-startup.ps1"
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
        $runtime = Join-Path $repo 'build/windows/runtime'
        $manifest = Join-Path $runtime 'WINDOWS-INTEGRITY.json'
        $desktop = Join-Path $env:RUNNER_TEMP 'windows-staged-daemon-phases-44794993333/desktop/gentle-dot.exe'
        $digest = '122f315f652cebc8d9a5d5e21658fac8e8253fa27c1bcfcbec59938e35adf4f4'
        if ($env:STAGED_PHASE_RUNTIME_SHA256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant() -cne $env:STAGED_PHASE_RUNTIME_SHA256) { throw 'identity' }
        node (Join-Path $PSScriptRoot '../runtime-integrity.mjs') verify $runtime $manifest windows-x64 >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'inventory' }
        $phase = 'inconclusive'
        $selectors = @{}
        try {
            $socket = New-StagedDaemonPhaseReceiver
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $bytes = [byte[]]::new(16)
                $random.GetBytes($bytes)
                $id = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
            } finally { $random.Dispose() }
            $selectors = @{ PhasePort = '43194'; PhaseId = $id; PhaseReceiver = $socket; PhaseEvidence = [ref]$phase }
        } catch { } # Do not gate staged startup on observer availability.
        $failure = 'daemon-phases-staged-failed'
        $startup = Invoke-StagedDesktopStartup -Runtime $runtime -Desktop $desktop -DesktopSha256 $digest @selectors 2>$null 3>$null 4>$null 5>$null 6>$null
        if ($startup -isnot [string] -or $startup -cnotmatch '\Astaged-desktop-startup-(?:passed|timeout|earlyexit|failed|cleanup-failed|node-version|preflight-(?:syntax|self-check|addon)(?:-cleanup-failed)?|desktop-identity|invalid-runtime|phases-refused|not-ci)\z') { throw 'startup' }
        if ($phase -cnotmatch '\A(?:inconclusive|(?:configuration|managed-stop|fd3|private-memory)-(?:completed|failed))\z' -and
            @(Get-StagedDaemonPrivateMemoryReasons | ForEach-Object { "private-memory-failed-$_" }) -cnotcontains $phase) { throw 'phase' }
        "daemon-phases-$phase"
        $startup
        if ($startup -ceq 'staged-desktop-startup-passed') { exit 0 }
        exit 1
    } catch { $failure; exit 1 }
    finally { if ($null -ne $socket) { $socket.Dispose() } }
}
