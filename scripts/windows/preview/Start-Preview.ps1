$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'Gentle Dot Preview.exe'
$runtime = Join-Path $PSScriptRoot 'runtime'
foreach ($file in @($exe, "$runtime/node/node.exe", "$runtime/daemon/cli.mjs")) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing preview component: $file" }
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('gentle-dot-preview-' + [guid]::NewGuid().ToString('N'))
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
try {
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
} finally {
    $listener.Stop()
}
if ($port -eq 4317) { throw 'Preview requires a separate port. Run the launcher again.' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $exe
$start.WorkingDirectory = $PSScriptRoot
$start.UseShellExecute = $false
$start.EnvironmentVariables.Clear()
$start.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
$start.EnvironmentVariables['WINDIR'] = $env:SystemRoot
$start.EnvironmentVariables['ComSpec'] = Join-Path $env:SystemRoot 'System32/cmd.exe'
$start.EnvironmentVariables['PATH'] = "$runtime\bin;$runtime\node;$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$start.EnvironmentVariables['GENTLE_DOT_DATA_DIR'] = $root
$start.EnvironmentVariables['GENTLE_DOT_PORT'] = [string]$port
$start.EnvironmentVariables['GENTLE_DOT_RUNTIME_DIR'] = $runtime
$child = [Diagnostics.Process]::Start($start)
Write-Host "QA preview PID $($child.Id), profile $root"
$child.WaitForExit()
exit $child.ExitCode
