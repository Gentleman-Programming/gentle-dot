# No filesystem fixtures, no hosted environment, and no diagnostic child process.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/runner-temp-diagnostic-cache.ps1"

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected $Expected, got $Actual" }
}

$cache = 'C:\runner-cache'
$list = {
    param($Root)
    Assert-Equal $Root 'C:\runner-cache\node'
    '24.0.0', '24.9.9', '24.14.1', '24.99.0', '24.100.0', '24.101.0', '24.102.0', '24.103.0', '24.01.0', '24.999.0-rc.1', '25.0.0', '22.9.0'
}
$attrs = {
    param($Path)
    if ($Path -like '*\24.103.0\x64') { return [IO.FileAttributes]'Directory, ReparsePoint' }
    if ($Path -like '*\24.102.0\x64\node.exe') { return [IO.FileAttributes]::Directory }
    if ($Path -like '*\24.101.0\x64\node.exe') { throw 'missing' }
    if ($Path -like '*\node.exe') { return [IO.FileAttributes]::Archive }
    [IO.FileAttributes]::Directory
}
$found = @(Get-RunnerTempNodeCandidates $cache $list $attrs)
Assert-Equal ($found.Version -join ',') '24.14.1,24.100.0,24.99.0,24.9.9,24.0.0'
Assert-Equal $found[0].Executable 'C:\runner-cache\node\24.14.1\x64\node.exe'
$alternate = @(Get-RunnerTempNodeCandidates $cache { '24.9.9', '24.10.0' } $attrs)
Assert-Equal $alternate[0].Version '24.10.0'
Assert-Equal (@(Get-RunnerTempNodeCandidates '..\cache' { throw 'must not enumerate' } $attrs).Count) 0

Assert-Equal ((Read-RunnerTempNodeResult 0 "node-runtime-exact`nnode-drive-fixed`n" '' 'node-runtime-exact') -join ',') 'node-runtime-exact,node-drive-fixed'
Assert-Equal ((Read-RunnerTempNodeResult 0 "node-runtime-alternate-24`r`nnode-ancestry-refused`r`n" '' 'node-runtime-alternate-24') -join ',') 'node-runtime-alternate-24,node-ancestry-refused'
Assert-Equal (Read-RunnerTempNodeResult 0 "node-runtime-exact`nnode-drive-fixed`n" 'not emitted' 'node-runtime-exact') 'node-unexpected-stderr'
Assert-Equal (Read-RunnerTempNodeResult 0 "node-runtime-alternate-24`nnode-drive-fixed`n" '' 'node-runtime-exact') 'node-invocation-refused'
Assert-Equal (Read-RunnerTempNodeResult 1 "node-runtime-refused`n" '' 'node-runtime-exact') 'node-runtime-refused'
'3 contract groups passed'
