# Hosted staged diagnostic only; no public parameters or caller-selected paths.
function New-StagedOwnerReceiver {
    $socket = [Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,
        [Net.Sockets.SocketType]::Dgram, [Net.Sockets.ProtocolType]::Udp)
    try {
        $socket.ExclusiveAddressUse = $true
        $socket.Blocking = $false
        $socket.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 43193))
        return $socket
    } catch { $socket.Dispose(); throw }
}

function Read-StagedOwnerReceiver($Socket, [string]$Id) {
    # Called once, synchronously before Job cleanup; never poll or read after the cutoff.
    if ($Socket.Blocking -or -not $Socket.ExclusiveAddressUse -or
        $Socket.SocketType -ne [Net.Sockets.SocketType]::Dgram -or $Socket.LocalEndPoint.Port -ne 43193 -or
        -not $Socket.LocalEndPoint.Address.Equals([Net.IPAddress]::Loopback)) { return 'inconclusive' }
    $buffer = [byte[]]::new(64)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $sender = $null; $launch = $null; $status = $null
    try {
        for ($i = 0; $i -lt 128 -and $clock.ElapsedMilliseconds -lt 1000; $i++) {
            if (-not $Socket.Poll(0, [Net.Sockets.SelectMode]::SelectRead)) {
                if ($launch -ceq 'resumed' -and -not $status) { return 'resumed-status-inconclusive' }
                if ($status) { return $status }
                if ($launch) { return $launch }
                break
            }
            [Net.EndPoint]$peer = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
            $length = $Socket.ReceiveFrom($buffer, [ref]$peer)
            if ($length -lt 34 -or $length -ge $buffer.Length -or -not $peer.Address.Equals([Net.IPAddress]::Loopback)) { break }
            $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $length)
            if (-not $text.StartsWith("$Id ", [StringComparison]::Ordinal)) { break }
            $event = $text.Substring(33)
            if ($null -eq $sender) {
                if ($event -cne 'begin') { break }
                $sender = $peer.Port
            } elseif ($peer.Port -ne $sender) { break }
            elseif ($null -eq $launch -and $event -cmatch '\A(?:prepare-failed|create-failed|assign-failed|verify-failed|record-failed|publish-failed|resume-failed|resumed)\z') {
                $launch = $event
            } elseif ($launch -ceq 'resumed' -and $null -eq $status -and $event -cmatch '\A(?:exit-zero|exit-nonzero|status-failed)\z') {
                $status = $event
            } else { break }
        }
    } catch { } # WouldBlock after poll, truncation or any receiver error: never project partial evidence.
    return 'inconclusive'
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $failure = 'owner-observation-host-refused'
    $socket = $null
    try {
        . "$PSScriptRoot/../test-staged-desktop-startup.ps1"
        if ($args.Count -or -not (Test-StagedOwnerObservationHost)) { throw 'host' }
        $failure = 'owner-observation-input-refused'
        $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
        $runtime = Join-Path $repo 'build/windows/runtime'
        $manifest = Join-Path $runtime 'WINDOWS-INTEGRITY.json'
        $desktop = Join-Path $repo 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/gentle-dot.exe'
        if ($env:STAGED_OWNER_RUNTIME_SHA256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            $env:STAGED_OWNER_DESKTOP_SHA256 -cnotmatch '\A[a-f0-9]{64}\z' -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant() -cne $env:STAGED_OWNER_RUNTIME_SHA256) { throw 'identity' }
        node (Join-Path $PSScriptRoot '../runtime-integrity.mjs') verify $runtime $manifest windows-x64 >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'inventory' }

        $selectors = @{}
        $phase = 'inconclusive'
        try {
            $socket = New-StagedOwnerReceiver
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try {
                $bytes = [byte[]]::new(16)
                $random.GetBytes($bytes)
                $id = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
            } finally { $random.Dispose() }
            $selectors = @{ OwnerPort = '43193'; OwnerId = $id; OwnerReceiver = $socket; OwnerEvidence = [ref]$phase }
        } catch { } # Diagnostic outage must not suppress or alter the staged run.

        $failure = 'owner-observation-staged-failed'
        $startup = Invoke-StagedDesktopStartup -Runtime $runtime -Desktop $desktop `
            -DesktopSha256 $env:STAGED_OWNER_DESKTOP_SHA256 @selectors 2>$null 3>$null 4>$null 5>$null 6>$null
        if ($startup -isnot [string] -or $startup -cnotmatch '\Astaged-desktop-startup-(?:passed|timeout|earlyexit|failed|cleanup-failed|node-version|preflight-(?:syntax|self-check|addon)(?:-cleanup-failed)?|desktop-identity|invalid-runtime|owner-refused|not-ci)\z') { throw 'startup' }
        "owner-observation-$phase"
        $startup
        if ($startup -ceq 'staged-desktop-startup-passed') { exit 0 }
        exit 1
    } catch { $failure; exit 1 }
    finally { if ($null -ne $socket) { $socket.Dispose() } }
}
