# Both callers must verify the restored runtime before entering this fixed probe.
$ErrorActionPreference = 'Stop'
function Assert-OrdinaryDirectories([string]$path) {
    if ($path -notmatch '^[A-Z]:\\[^\\]' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($path)).DriveType -ne 'Fixed') { throw 'directory' }
    for ($dir = [IO.DirectoryInfo]::new($path); $null -ne $dir; $dir = $dir.Parent) {
        $attributes = [IO.File]::GetAttributes($dir.FullName)
        if (($attributes -band ([IO.FileAttributes]'ReparsePoint, Device')) -or
            -not ($attributes -band [IO.FileAttributes]::Directory)) { throw 'directory' }
    }
}

$result = 'wrapper-host-failed'
$child = $null
try {
    $diagnostic = $env:GITHUB_WORKFLOW -ceq 'Windows storage diagnostic 44794993333'
    if (-not $IsWindows -or $args.Count -ne 0 -or $env:CI -cne 'true' -or
        $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_JOB -cne 'checks' -or
        $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:GITHUB_REPOSITORY -cne 'Gentleman-Programming/gentle-dot' -or
        (-not $diagnostic -and $env:GITHUB_WORKFLOW -cne 'Windows installer prerelease') -or
        ($diagnostic -and ($env:GITHUB_EVENT_NAME -cne 'push' -or
            $env:GITHUB_REF -cne 'refs/heads/qa/windows-storage-diagnostic-44794993333'))) { throw 'host' }

    $result = 'wrapper-paths-failed'
    $temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    $workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    $runtime = if ($diagnostic) { Join-Path $temp 'windows-storage-diagnostic-44794993333/runtime' }
        else { Join-Path $workspace 'build/windows/runtime' }
    $entry = Join-Path $workspace 'scripts/windows/test/packaged-storage-admission.mjs'
    $node = Join-Path $runtime 'node/node.exe'
    $helper = Join-Path $runtime 'bin/private-storage.exe'
    Assert-OrdinaryDirectories $temp
    foreach ($image in @($node, $helper, $entry)) {
        Assert-OrdinaryDirectories ([IO.Path]::GetDirectoryName($image))
    }

    $result = 'wrapper-image-failed'
    foreach ($image in @($node, $helper, $entry)) {
        $attributes = [IO.File]::GetAttributes($image)
        if ($attributes -band ([IO.FileAttributes]'Directory, ReparsePoint, Device')) { throw 'image' }
    }

    $result = 'wrapper-launch-failed'
    $info = [Diagnostics.ProcessStartInfo]::new($node)
    $info.ArgumentList.Add($entry)
    $info.WorkingDirectory = $runtime
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment.Clear()
    foreach ($name in @('CI', 'GITHUB_ACTIONS', 'GITHUB_JOB', 'GITHUB_WORKFLOW', 'RUNNER_ENVIRONMENT',
            'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'SystemRoot')) {
        $info.Environment[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    $info.Environment['RUNNER_TEMP'] = $temp
    $child = [Diagnostics.Process]::Start($info)
    $discard = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $output = $child.StandardOutput.ReadToEnd().TrimEnd([char[]]"`r`n")
    $child.WaitForExit()
    $discard.GetAwaiter().GetResult()

    $result = 'wrapper-parse-failed'
    $phase = '(?:ok|timeout|launch-failed|helper-failed|invocation-failed|unexpected-effect|skipped)'
    if (($child.ExitCode -eq 0 -and $output -ceq 'ok ok ok ok') -or
        ($child.ExitCode -eq 1 -and $output -cne 'ok ok ok ok' -and
            $output -cmatch "\A(?:entry-(?:host|paths|image|probe)-failed|$phase(?: $phase){3})\z")) { $result = $output }
} catch { } finally { if ($null -ne $child) { $child.Dispose() } }

if ($env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_STEP_SUMMARY) {
    "Windows packaged storage (ordinary / verbatim / ensure / write-readback): **$result** (not an acceptance gate)." >> $env:GITHUB_STEP_SUMMARY
} else { $result }
if ($result -cne 'ok ok ok ok') { exit 1 }
