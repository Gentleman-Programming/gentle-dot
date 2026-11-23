# Read only immediate version directories under the hosted runner's tool cache.
function Get-RunnerTempNodeCandidates {
    param(
        [string]$Cache,
        [scriptblock]$List = { param($Path) [IO.Directory]::EnumerateDirectories($Path) | ForEach-Object { [IO.Path]::GetFileName($_) } },
        [scriptblock]$Attributes = { param($Path) [IO.File]::GetAttributes($Path) }
    )
    if ($Cache -notmatch '\A[A-Z]:\\') { return }
    $unsafe = [IO.FileAttributes]'ReparsePoint, Device'
    $directory = [IO.FileAttributes]::Directory
    $root = [IO.Path]::Combine([IO.Path]::GetFullPath($Cache), 'node')
    for ($dir = [IO.DirectoryInfo]::new($root); $null -ne $dir; $dir = $dir.Parent) {
        $flags = & $Attributes $dir.FullName
        if (($flags -band $unsafe) -or -not ($flags -band $directory)) { return }
    }
    $candidates = foreach ($name in (& $List $root)) {
        if ($name -cnotmatch '\A24\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\z') { continue }
        $versionPath = [IO.Path]::Combine($root, $name)
        $archPath = [IO.Path]::Combine($versionPath, 'x64')
        $exe = [IO.Path]::Combine($archPath, 'node.exe')
        try {
            foreach ($path in @($versionPath, $archPath)) {
                $flags = & $Attributes $path
                if (($flags -band $unsafe) -or -not ($flags -band $directory)) { throw 'directory' }
            }
            if ((& $Attributes $exe) -band ($unsafe -bor $directory)) { continue }
        } catch { continue }
        [pscustomobject]@{ Version = [version]$name; Exact = $name -ceq '24.14.1'; Executable = $exe }
    }
    $candidates | Sort-Object -Property Exact, Version -Descending
}

function Read-RunnerTempNodeResult([int]$Code, [string]$Output, [string]$Stderr, [string]$Expected) {
    if ($Stderr -cne '') { return 'node-unexpected-stderr' }
    if ($Code -eq 1 -and $Output -cmatch '\A(node-(?:host|runtime)-refused)\r?\n\z') { return $Matches[1] }
    if ($Code -eq 0 -and $Output -cmatch '\A(node-runtime-(?:exact|alternate-24))\r?\n(node-(?:path-(?:root|component)|ancestry-refused|canonical-refused|outside-repo-refused|file-id-refused|drive-(?:spawn-error|nonfixed|malformed|fixed)))\r?\n\z' -and
        $Matches[1] -ceq $Expected) { return $Matches[1], $Matches[2] }
    'node-invocation-refused'
}

function Invoke-RunnerTempNode([string]$Executable, [string]$Script, [string]$Expected) {
    $child = [Diagnostics.Process]::new()
    $stdoutBytes = [IO.MemoryStream]::new()
    $stderrBytes = [IO.MemoryStream]::new()
    try {
        $start = $child.StartInfo
        $start.FileName = $Executable
        # The script is a fixed file under the checkout. Win32 paths cannot contain quotes.
        $start.Arguments = '"' + $Script + '"'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.EnvironmentVariables.Remove('NODE_OPTIONS')
        $start.EnvironmentVariables.Remove('NODE_PATH')
        if (-not $child.Start()) { return 'node-invocation-refused' }
        # Decode the bytes ourselves so neither PowerShell stream formatting nor BOM detection
        # can disguise unexpected output (including an otherwise empty stream with a BOM).
        $output = $child.StandardOutput.BaseStream.CopyToAsync($stdoutBytes)
        $stderr = $child.StandardError.BaseStream.CopyToAsync($stderrBytes)
        if (-not $child.WaitForExit(15000)) {
            $child.Kill()
            return 'node-invocation-refused'
        }
        if (-not $output.Wait(1000) -or -not $stderr.Wait(1000)) { return 'node-invocation-refused' }
        $utf8 = [Text.Encoding]::UTF8
        Read-RunnerTempNodeResult $child.ExitCode ($utf8.GetString($stdoutBytes.ToArray())) ($utf8.GetString($stderrBytes.ToArray())) $Expected
    } catch { 'node-invocation-refused' }
    finally {
        $child.Dispose()
        $stdoutBytes.Dispose()
        $stderrBytes.Dispose()
    }
}
