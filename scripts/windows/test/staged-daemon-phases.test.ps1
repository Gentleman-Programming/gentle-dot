$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot 'run-staged-daemon-phases.ps1'
$staged = Join-Path $PSScriptRoot '../test-staged-desktop-startup.ps1'
foreach ($file in @($wrapper, $staged, $PSCommandPath)) {
    $tokens = $null; $errors = $null
    if (-not [IO.File]::Exists($file)) { throw 'daemon phases observer is not implemented' }
    $null = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'PowerShell AST parse failed' }
}
$workflow = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../../.github/workflows/windows-staged-daemon-phases-44794993333.yml'))
$blocks = [regex]::Matches($workflow, '(?m)^        run: \|\r?\n((?:^ {10}[^\r\n]*\r?\n)+)')
if ($blocks.Count -ne 4) { throw 'unexpected PowerShell block count' }
foreach ($block in $blocks) {
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseInput(($block.Groups[1].Value -replace '(?m)^ {10}', ''), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'workflow PowerShell AST parse failed' }
}
. $staged
. $wrapper
$env:CI = 'true'; $env:RUNNER_ENVIRONMENT = 'self-hosted'
if ((Invoke-StagedDesktopStartup -PhasePort '43194') -cne 'staged-desktop-startup-phases-refused') { throw 'wrong host admitted' }
$env:GH_TOKEN = 'inert'; $env:AMBIENT_SENTINEL = 'inert'; $env:NODE_OPTIONS = 'inert'
$stageInfo = New-StagedDaemonPhaseBuildInfo 'inert'
foreach ($key in @('GH_TOKEN','AMBIENT_SENTINEL','NODE_OPTIONS','GENTLE_DOT_CI_DAEMON_PHASE_ID')) {
    if ($stageInfo.Environment.ContainsKey($key)) { throw 'ambient environment inherited' }
}
if ($stageInfo.Environment['GENTLE_DOT_CI_DAEMON_PHASE_BUILD'] -cne '1') { throw 'compile selector missing' }
$id = '0123456789abcdef0123456789abcdef'
function Send-TestPhase($Tx, $Rx, [string]$Id, [string]$Event) {
    $bytes = [Text.Encoding]::ASCII.GetBytes("$Id $Event")
    $null = $Tx.Send($bytes, $bytes.Length, $Rx.LocalEndPoint)
}
function Assert-Projection([string[]]$Events, [string]$Expected, [switch]$Conflict, [switch]$SecondSender) {
    $rx = New-StagedDaemonPhaseReceiver
    $tx = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
    try {
        foreach ($event in $Events) { Send-TestPhase $tx $rx $id $event }
        if ($Conflict) { Send-TestPhase $tx $rx ('0' * 32) '2+' }
        if ($SecondSender) {
            $other = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
            try { Send-TestPhase $other $rx $id '2+' } finally { $other.Dispose() }
        }
        if ((Read-StagedDaemonPhaseReceiver $rx $id) -cne $Expected) { throw "projection: expected $Expected" }
    } finally { $tx.Dispose(); $rx.Dispose() }
}
Assert-Projection @() 'inconclusive'
Assert-Projection @('2-') 'inconclusive'
Assert-Projection @('1-', '1+') 'inconclusive'
Assert-Projection @('1+', '1+') 'inconclusive'
Assert-Projection @('1+', ('x' * 80)) 'inconclusive'
Assert-Projection @('1+') 'inconclusive' -Conflict
Assert-Projection @('1+') 'inconclusive' -SecondSender
Assert-Projection @('1+', '2+', '3+', '4+', '4+') 'inconclusive'
$prior = @(); $i = 0
foreach ($stage in @('configuration','managed-stop','fd3','private-memory')) {
    $i++
    Assert-Projection ($prior + "$i-") "$stage-failed"
    $prior += "$i+"
    Assert-Projection $prior "$stage-completed"
}

# Never run a desktop or Node: preflight, owner, and termination are all inert replacements.
$env:CI = 'true'
function Test-StagedDaemonPhaseHost { $true }
function Initialize-DaemonStartupOwner { throw 'native owner not allowed' }
function New-DaemonStartupScratch { $fixture }
function Get-DaemonStartupPort { 12345 + $script:port++ }
function New-DaemonStartupStartInfo {
    param($Runtime, $Environment)
    @{ FileName = ''; ArgumentList = [Collections.Generic.List[string]]::new(); Environment = $Environment.Clone() }
}
function Assert-NoPhase($Info) {
    if ($Info.Environment.ContainsKey('GENTLE_DOT_CI_DAEMON_PHASE_ID') -or
        $Info.Environment.ContainsKey('GENTLE_DOT_CI_DAEMON_PHASE_PORT')) { throw 'selector leaked into preflight' }
}
function Test-StagedNodeVersion($Info) { Assert-NoPhase $Info; $true }
function Invoke-StagedPackagedPreflight($Info) { Assert-NoPhase $Info; 'passed' }
function New-DaemonStartupOwner($Info) {
    if ($Info.Environment['GENTLE_DOT_CI_DAEMON_PHASE_ID'] -cne $id -or
        $Info.Environment['GENTLE_DOT_CI_DAEMON_PHASE_PORT'] -cne '43194') { throw 'selector not isolated to desktop' }
    Send-TestPhase $tx $rx $id '1+'
    return @{ Stub = $true }
}
function Test-DaemonStartupExited { $true }
function Stop-DaemonStartupProcess($Owner) {
    $script:stops++
    Send-TestPhase $tx $rx $id '2-'
    return $clean
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('daemon-phases-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($name in @('node','daemon')) { $null = [IO.Directory]::CreateDirectory((Join-Path $fixture $name)) }
    $desktop = Join-Path $fixture 'desktop.exe'
    foreach ($file in @($desktop, (Join-Path $fixture 'node/node.exe'), (Join-Path $fixture 'daemon/cli.mjs'))) {
        [IO.File]::WriteAllText($file, 'inert; never executed')
    }
    $digest = (Get-FileHash -LiteralPath $desktop -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($clean in @($true, $false)) {
        $rx = New-StagedDaemonPhaseReceiver
        $tx = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
        try {
            $script:port = 0; $script:stops = 0; $phase = 'not-set'
            foreach ($bad in @(@{PhasePort='043194';PhaseId=$id}, @{PhasePort='43194';PhaseId=$id.ToUpperInvariant()}, @{PhasePort='43194';PhaseId=$id;DiagnosticsPath='never'})) {
                $refused = Invoke-StagedDesktopStartup -PhaseReceiver $rx -PhaseEvidence ([ref]$phase) @bad
                if ($refused -cne 'staged-desktop-startup-phases-refused' -or $phase -cne 'not-set' -or $script:stops) { throw 'invalid selector changed state' }
            }
            $result = Invoke-StagedDesktopStartup -Runtime $fixture -Desktop $desktop -DesktopSha256 $digest `
                -PhasePort '43194' -PhaseId $id -PhaseReceiver $rx -PhaseEvidence ([ref]$phase)
            $expected = if ($clean) { 'staged-desktop-startup-earlyexit' } else { 'staged-desktop-startup-cleanup-failed' }
            $expectedPhase = if ($clean) { 'configuration-completed' } else { 'inconclusive' }
            if ($script:stops -ne 1 -or $result -cne $expected -or $phase -cne $expectedPhase) { throw 'cutoff or cleanup contract failed' }
        } finally { $tx.Dispose(); $rx.Dispose() }
    }
} finally { [IO.Directory]::Delete($fixture, $true) }
'daemon-phases-contract: passed'
