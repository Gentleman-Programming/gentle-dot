# PS5-compatible; no product binaries, fixtures, or native adapter initialization.
$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot 'run-staged-owner-observation.ps1'
$staged = Join-Path $PSScriptRoot '../test-staged-desktop-startup.ps1'
foreach ($path in @($wrapper, $staged, $PSCommandPath)) {
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'PowerShell AST parse failed' }
}

$workflow = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../../.github/workflows/windows-staged-owner-44794993333.yml'))
$blocks = [regex]::Matches($workflow, '(?m)^        run: \|\r?\n((?:^ {10}[^\r\n]*\r?\n)+)')
if ($blocks.Count -ne 4) { throw 'unexpected number of PowerShell workflow blocks' }
foreach ($block in $blocks) {
    $tokens = $null; $errors = $null
    $null = [Management.Automation.Language.Parser]::ParseInput(($block.Groups[1].Value -replace '(?m)^ {10}', ''), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'workflow PowerShell AST parse failed' }
}

$env:CI = 'true'; $env:GITHUB_ACTIONS = 'true'; $env:RUNNER_ENVIRONMENT = 'self-hosted'
. $staged
. $wrapper
function Initialize-DaemonStartupOwner { throw 'native adapter is not allowed' }
$id = '0123456789abcdef0123456789abcdef'
if ((Invoke-StagedDesktopStartup -OwnerPort '43193' -OwnerId $id) -cne 'staged-desktop-startup-owner-refused') { throw 'internal host gate failed' }

if ($env:OS -ceq 'Windows_NT' -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ceq 'X64') {
    $context = @{
        CI = 'true'; GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; RUNNER_OS = 'Windows'; RUNNER_ARCH = 'X64'
        GITHUB_RUN_ATTEMPT = '1'; GITHUB_JOB = 'observe'; GITHUB_REPOSITORY = 'Gentleman-Programming/gentle-dot'
        GITHUB_WORKFLOW = 'Windows staged owner 44794993333'; GITHUB_EVENT_NAME = 'push'
        GITHUB_REF = 'refs/heads/qa/windows-staged-owner-44794993333'
        GITHUB_WORKFLOW_REF = 'Gentleman-Programming/gentle-dot/.github/workflows/windows-staged-owner-44794993333.yml@refs/heads/qa/windows-staged-owner-44794993333'
    }
    foreach ($key in $context.Keys) { [Environment]::SetEnvironmentVariable($key, $context[$key]) }
    if (-not (Test-StagedOwnerObservationHost)) { throw 'expected exact hosted context' }
    foreach ($key in $context.Keys) {
        [Environment]::SetEnvironmentVariable($key, 'wrong')
        if (Test-StagedOwnerObservationHost) { throw 'incorrect context was admitted' }
        [Environment]::SetEnvironmentVariable($key, $context[$key])
    }
    $receiver = New-StagedOwnerReceiver
    try {
        $evidence = 'inconclusive'
        $sink = @{ OwnerReceiver = $receiver; OwnerEvidence = [ref]$evidence }
        foreach ($selection in @(@{OwnerPort='43193'}, @{OwnerId=$id}, @{OwnerPort='043193';OwnerId=$id},
            @{OwnerPort='43193';OwnerId=$id.ToUpperInvariant()}, @{OwnerPort='43193';OwnerId=$id;DiagnosticsPath='unused'})) {
            if ((Invoke-StagedDesktopStartup @selection @sink) -cne 'staged-desktop-startup-owner-refused') { throw 'invalid selectors admitted' }
        }
        if ((Invoke-StagedDesktopStartup -OwnerPort '43193' -OwnerId $id) -cne 'staged-desktop-startup-owner-refused') { throw 'missing evidence sink admitted' }
        if ((Invoke-StagedDesktopStartup -OwnerPort '43193' -OwnerId $id @sink) -cne 'staged-desktop-startup-invalid-runtime') { throw 'valid selection did not reach unchanged input validation' }
    } finally { $receiver.Dispose() }
}

function Assert-Projection([string[]]$Frames, [string]$Expected, [switch]$SecondSender) {
    $rx = New-StagedOwnerReceiver
    $tx = $null; $other = $null
    try {
        if ($rx.LocalEndPoint.Port -ne 43193 -or -not $rx.LocalEndPoint.Address.Equals([Net.IPAddress]::Loopback) -or
            -not $rx.ExclusiveAddressUse -or $rx.Blocking) { throw 'unexpected receiver identity' }
        $tx = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
        foreach ($frame in $Frames) {
            $bytes = [Text.Encoding]::ASCII.GetBytes($frame)
            $null = $tx.Send($bytes, $bytes.Length, $rx.LocalEndPoint)
        }
        if ($SecondSender) {
            $other = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
            $bytes = [Text.Encoding]::ASCII.GetBytes("$id begin")
            $null = $other.Send($bytes, $bytes.Length, $rx.LocalEndPoint)
        }
        if ((Read-StagedOwnerReceiver $rx $id) -cne $Expected) { throw "incorrect projection for expected $Expected" }
    } finally { if ($other) { $other.Dispose() }; if ($tx) { $tx.Dispose() }; $rx.Dispose() }
}
Assert-Projection @() 'inconclusive'
Assert-Projection @("$id begin") 'inconclusive'
Assert-Projection @("$id resumed", "$id exit-zero") 'inconclusive'
Assert-Projection @("$id begin", "$id resumed") 'resumed-status-inconclusive'
Assert-Projection @("$id begin", "$id resumed", "$id exit-zero") 'inconclusive' -SecondSender
Assert-Projection @("$id begin", "$id resumed", "$id exit-zero", "$id exit-zero") 'inconclusive'
Assert-Projection @("$id begin", "$id resumed", ('0' * 32 + ' exit-zero')) 'inconclusive'
Assert-Projection @("$id begin", "$id resumed", "$id exit-23") 'inconclusive'
Assert-Projection @("$id begin", "$id resumed", "$id " + ('x' * 80)) 'inconclusive'
foreach ($status in @('exit-zero','exit-nonzero','status-failed')) { Assert-Projection @("$id begin", "$id resumed", "$id $status") $status }
foreach ($launch in @('prepare-failed','create-failed','assign-failed','verify-failed','record-failed','publish-failed','resume-failed')) {
    Assert-Projection @("$id begin", "$id $launch") $launch
    Assert-Projection @("$id begin", "$id $launch", "$id exit-zero") 'inconclusive'
}
# Stub the staged owner; inject the same UDP frame either side of whole-Job cleanup.
function Test-StagedOwnerObservationHost { $true }
function New-DaemonStartupScratch { $fixture }
function Get-DaemonStartupPort { 12345 + $script:port++ }
function New-DaemonStartupStartInfo {
    param($Runtime, $Environment)
    @{ FileName = ''; ArgumentList = [Collections.Generic.List[string]]::new(); Environment = $Environment.Clone() }
}
function Test-StagedNodeVersion { $true }
function Invoke-StagedPackagedPreflight { 'passed' }
function New-DaemonStartupOwner { @{ Stub = $true } }
function Test-DaemonStartupExited {
    if ($FailCutoff) { $rx.Dispose() }
    return $true
}
function Send-TestFrames([string[]]$Frames) {
    foreach ($frame in $Frames) {
        $bytes = [Text.Encoding]::ASCII.GetBytes("$id $frame")
        $null = $tx.Send($bytes, $bytes.Length, $rx.LocalEndPoint)
    }
}
function Stop-DaemonStartupProcess($Owner) {
    $script:cleanupCalls++
    if ($DuringCleanup) { Send-TestFrames @('exit-zero') }
    return $Clean
}
function Assert-Cutoff([string[]]$Before, [bool]$DuringCleanup, [bool]$Clean, [string]$Expected, [switch]$FailCutoff) {
    $rx = New-StagedOwnerReceiver
    $tx = $null
    try {
        $tx = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
        Send-TestFrames $Before
        $script:cleanupCalls = 0; $script:port = 0
        $phase = 'inconclusive'
        $actual = Invoke-StagedDesktopStartup -Runtime $fixture -Desktop $desktop -DesktopSha256 $digest `
            -OwnerId $id -OwnerPort '43193' -OwnerReceiver $rx -OwnerEvidence ([ref]$phase)
        $expectedOutcome = if ($Clean) { 'earlyexit' } else { 'cleanup-failed' }
        if ($script:cleanupCalls -ne 1 -or $actual -cne "staged-desktop-startup-$expectedOutcome") { throw 'staged outcome or cleanup changed' }
        if ($phase -cne $Expected) { throw "cutoff: expected $Expected, got $phase" }
    } finally { if ($tx) { $tx.Dispose() }; $rx.Dispose() }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('owner-observation-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($name in @('node', 'daemon')) { $null = [IO.Directory]::CreateDirectory((Join-Path $fixture $name)) }
    $desktop = Join-Path $fixture 'desktop.exe'
    foreach ($file in @($desktop, (Join-Path $fixture 'node/node.exe'), (Join-Path $fixture 'daemon/cli.mjs'))) {
        [IO.File]::WriteAllText($file, 'inert; never executed')
    }
    $digest = (Get-FileHash -LiteralPath $desktop -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Cutoff @('begin','resumed') $true $true 'resumed-status-inconclusive'
    Assert-Cutoff @('begin','resumed','exit-zero') $false $true 'exit-zero'
    Assert-Cutoff @('begin','resumed','exit-zero') $false $false 'inconclusive'
    Assert-Cutoff @('begin','exit-zero','resumed') $false $true 'inconclusive'
    Assert-Cutoff @('begin','resumed','exit-zero') $false $true 'inconclusive' -FailCutoff
} finally { [IO.Directory]::Delete($fixture, $true) }
'owner-observation-contract: passed'
