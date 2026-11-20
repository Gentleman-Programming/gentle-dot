# Hosted diagnostic only. No caller-selected paths, binaries, or output destinations.
$script:StartupTracePhases = 'entry config-start config-ready stop-start stop-refused stop-ready fd3-start fd3-refused fd3-ready daemon-start channel-refused preview-memory-start preview-memory-refused preview-memory-ready claim-start claim-refused claim-ready providers-ready token-ready workspace-ready memory-ready http-bind http-refused http-listening startup-failed' -split ' '

function New-TraceReceiver {
    $socket = [Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,
        [Net.Sockets.SocketType]::Dgram, [Net.Sockets.ProtocolType]::Udp)
    try {
        $socket.ExclusiveAddressUse = $true
        $socket.Blocking = $false
        $socket.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
        return $socket
    } catch { $socket.Dispose(); throw }
}

function Read-TraceReceiver($Socket, [string]$Id) {
    # Drain only the bounded kernel queue after the owned job has stopped.
    $buffer = [byte[]]::new(64)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $rank = -1; $sender = $null; $last = 'no-evidence'
    for ($i = 0; $i -lt 128 -and $clock.ElapsedMilliseconds -lt 1000; $i++) {
        if (-not $Socket.Poll(0, [Net.Sockets.SelectMode]::SelectRead)) { break }
        [Net.EndPoint]$peer = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
        try { $length = $Socket.ReceiveFrom($buffer, [ref]$peer) }
        catch [Net.Sockets.SocketException] {
            if ($_.Exception.SocketErrorCode -eq [Net.Sockets.SocketError]::MessageSize) { continue }
            if ($_.Exception.SocketErrorCode -eq [Net.Sockets.SocketError]::WouldBlock) { break }
            throw
        }
        if ($length -lt 34 -or $length -ge $buffer.Length -or -not $peer.Address.Equals([Net.IPAddress]::Loopback) -or
            ($null -ne $sender -and $peer.Port -ne $sender)) { continue }
        $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $length)
        if (-not $text.StartsWith("$Id ", [StringComparison]::Ordinal)) { continue }
        $phase = $text.Substring(33)
        $next = [Array]::IndexOf($script:StartupTracePhases, $phase)
        if ($next -le $rank) { continue }
        $rank = $next; $sender = $peer.Port; $last = $phase
        if ($phase -clike '*-refused' -or $phase -ceq 'startup-failed') { break }
    }
    return $last
}

function Assert-TraceOrdinary([string]$Path) {
    if ([IO.File]::GetAttributes($Path) -band ([IO.FileAttributes]'ReparsePoint, Device')) { throw 'ordinary' }
}

function Assert-TraceTree([string]$Path) {
    for ($dir = [IO.DirectoryInfo]::new($Path); $null -ne $dir; $dir = $dir.Parent) {
        Assert-TraceOrdinary $dir.FullName
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    while ($pending.Count) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
            $attributes = [IO.File]::GetAttributes($entry)
            if ($attributes -band ([IO.FileAttributes]'ReparsePoint, Device')) { throw 'ordinary' }
            if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($entry) }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $failure = 'trace-host-failed'
    $socket = $null
    try {
        . "$PSScriptRoot/../test-staged-desktop-startup.ps1"
        if ($args.Count -or -not (Test-StagedStartupTraceHost)) { throw 'host' }
        $failure = 'trace-input-failed'
        $temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
        if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($temp)).DriveType -ne 'Fixed') { throw 'drive' }
        $root = Join-Path $temp 'windows-storage-diagnostic-44794993333'
        $original = Join-Path $root 'runtime'
        $manifest = Join-Path $root 'qa/runtime-manifest.json'
        $transfer = Join-Path $root 'transfer/windows-runtime.tar'
        $desktop = Join-Path $root 'desktop/gentle-dot.exe'
        foreach ($name in @('qa', 'transfer', 'desktop')) { Assert-TraceTree (Join-Path $root $name) }
        Assert-TraceTree $original
        $desktopHash = '122f315f652cebc8d9a5d5e21658fac8e8253fa27c1bcfcbec59938e35adf4f4'
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $desktop).Hash.ToLowerInvariant() -cne $desktopHash) { throw 'desktop' }
        $verify = Join-Path $PSScriptRoot '../runtime-integrity.mjs'
        node $verify verify $original $manifest >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'original' }

        $failure = 'trace-bundle-failed'
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $bytes = [byte[]]::new(16)
            $random.GetBytes($bytes)
            $suffix = [Convert]::ToHexString($bytes).ToLowerInvariant()
            $random.GetBytes($bytes)
            $id = [Convert]::ToHexString($bytes).ToLowerInvariant()
        } finally { $random.Dispose() }
        $bundleDir = Join-Path ([IO.Path]::GetTempPath()) "gentle-dot-startup-trace-$suffix"
        node (Join-Path $PSScriptRoot 'startup-phase-bundle.mjs') --out-dir $bundleDir >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'bundle' }
        Assert-TraceTree $bundleDir
        $bundle = Join-Path $bundleDir 'startup-phase-cli.mjs'

        $failure = 'trace-runtime-failed'
        $stage = Join-Path $root "trace-$suffix"
        New-Item -ItemType Directory -Path $stage | Out-Null
        tar -xf $transfer -C $stage >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'restore' }
        $runtime = Join-Path $stage 'runtime'
        Assert-TraceTree $runtime
        node $verify verify $runtime $manifest >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'restore' }
        # The inventory excludes this embedded manifest; pin its original bytes separately.
        $embedded = 'WINDOWS-INTEGRITY.json'
        $embeddedHash = (Get-FileHash -LiteralPath (Join-Path $original $embedded)).Hash
        $expected = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json -AsHashtable
        $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash.ToLowerInvariant()
        if ($digest -ceq $expected.files['daemon/cli.mjs']) { throw 'unmodified' }
        $expected.files['daemon/cli.mjs'] = $digest
        Copy-Item -LiteralPath $bundle -Destination (Join-Path $runtime 'daemon/cli.mjs') -Force
        $traceManifest = Join-Path $stage 'trace-manifest.json'
        $expected | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $traceManifest -Encoding utf8NoBOM
        node $verify verify $runtime $traceManifest >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'trace' }
        node $verify verify $original $manifest >$null 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'original' }
        foreach ($tree in @($original, $runtime)) {
            if ((Get-FileHash -LiteralPath (Join-Path $tree $embedded)).Hash -cne $embeddedHash) { throw 'embedded' }
        }

        $failure = 'trace-receiver-failed'
        $socket = New-TraceReceiver
        $failure = 'trace-launch-failed'
        $startup = Invoke-StagedDesktopStartup -Runtime $runtime -Desktop $desktop -DesktopSha256 $desktopHash `
            -TracePort $socket.LocalEndPoint.Port -TraceId $id 2>$null 3>$null 4>$null 5>$null 6>$null
        if ($startup -cnotmatch '\Astaged-desktop-startup-(?:passed|timeout|earlyexit|failed|cleanup-failed|node-version|preflight-(?:syntax|self-check|addon)(?:-cleanup-failed)?|desktop-identity|invalid-runtime|trace-refused|not-ci)\z') { throw 'startup' }
        $failure = 'trace-receiver-failed'
        $phase = Read-TraceReceiver $socket $id
        "trace-$phase"
        $startup
        if ($startup -ceq 'staged-desktop-startup-passed' -and $phase -ceq 'http-listening') { exit 0 }
        exit 1
    } catch { $failure; exit 1 }
    finally { if ($null -ne $socket) { $socket.Dispose() } }
}
