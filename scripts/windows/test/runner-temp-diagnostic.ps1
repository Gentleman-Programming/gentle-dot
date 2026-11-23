# Hosted-only, read-only projection of Get-TraceRunnerTemp. No caller inputs.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($args.Count -or -not $IsWindows -or $env:CI -cne 'true' -or $env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_JOB -cne 'checks' -or
    $env:GITHUB_REPOSITORY -cne 'Gentleman-Programming/gentle-dot' -or
    $env:GITHUB_WORKFLOW -cne 'Windows runner temp diagnostic 44810128936' -or
    $env:GITHUB_EVENT_NAME -cne 'push' -or $env:GITHUB_REF -cne 'refs/heads/qa/windows-runner-temp-44810128936' -or
    $env:GITHUB_WORKFLOW_REF -cne 'Gentleman-Programming/gentle-dot/.github/workflows/windows-runner-temp-diagnostic.yml@refs/heads/qa/windows-runner-temp-44810128936') {
    'wrapper-host-refused'
    exit 1
}

$stage = 'wrapper-path-root'
try {
    $raw = ([string]$env:RUNNER_TEMP).Replace('/', '\')
    if ($raw -notmatch '\A[a-z]:\\') { throw 'root' }
    $stage = 'wrapper-path-component'
    foreach ($part in ($raw.Substring(3) -replace '\\\z' -split '\\')) {
        if (-not $part -or $part -match '[. ]\z|[\x00-\x1f:<>"|?*]|\A(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|\z)') { throw 'component' }
    }
    $stage = 'wrapper-path-normalize'
    $temp = [IO.Path]::GetFullPath($raw).TrimEnd('\')
    $stage = 'wrapper-drive-refused'
    if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($temp)).DriveType -ne 'Fixed') { throw 'drive' }
    $stage = 'wrapper-ancestry-refused'
    for ($dir = [IO.DirectoryInfo]::new($temp); $null -ne $dir; $dir = $dir.Parent) {
        if ([IO.File]::GetAttributes($dir.FullName) -band ([IO.FileAttributes]'ReparsePoint, Device')) { throw 'ordinary' }
        if (-not $dir.Exists) { throw 'directory' }
    }
    $stage = 'wrapper-ok'
} catch { }
$stage

# Run the independently guarded Node check even if the wrapper refused, using the original
# environment in that case; on success pass the same normalized value as the old wrapper.
$nodeOutput = @('node-runtime-refused')
try {
    . "$PSScriptRoot/runner-temp-diagnostic-cache.ps1"
    $candidate = Get-RunnerTempNodeCandidates $env:RUNNER_TOOL_CACHE | Select-Object -First 1
    if ($null -ne $candidate) {
        $previous = $env:RUNNER_TEMP
        $nodeOutput = @('node-invocation-refused')
        try {
            if ($stage -ceq 'wrapper-ok') { $env:RUNNER_TEMP = $temp }
            $expected = if ($candidate.Exact) { 'node-runtime-exact' } else { 'node-runtime-alternate-24' }
            $nodeOutput = @(Invoke-RunnerTempNode $candidate.Executable "$PSScriptRoot/runner-temp-diagnostic.mjs" $expected)
        } finally { $env:RUNNER_TEMP = $previous }
    }
} catch { }
$nodeOutput
if ($nodeOutput.Count -ne 2) { exit 1 }
exit 0
