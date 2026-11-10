param([string]$Target = 'windows-x64', [switch]$Help)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Help) { [Console]::WriteLine('usage: package.ps1 [-Target <windows-x64|windows-arm64>] [-Help]'); return }
# Validate through the stager before icon generation or any output writes.
& "$PSScriptRoot/stage.ps1" -Target $Target -CheckHost
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$rustTarget = if ($Target -eq 'windows-arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$rustHost = & rustc -vV
if ($LASTEXITCODE -ne 0 -or $rustHost -notcontains "host: $rustTarget") {
    [Console]::Error.WriteLine("Run on native $Target with matching Node, Go and Rust toolchains."); exit 2
}
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
New-Item -ItemType Directory -Path (Join-Path $repo 'build/windows') -Force | Out-Null
Push-Location $repo
try {
    & pnpm.cmd --filter '@gentle-dot/desktop' exec tauri icon src-tauri/icons/icon.png --output ../../build/windows/icons
    if ($LASTEXITCODE -ne 0) { throw 'Windows icon generation failed.' }
} finally { Pop-Location }
& "$PSScriptRoot/stage.ps1" -Target $Target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$runtime = Join-Path $repo 'build/windows/runtime'
$config = Join-Path $repo 'build/windows/bundle.json'
$hooks = Join-Path $repo 'build/windows/installer-path-hooks.nsh'
& node "$PSScriptRoot/installer-path-guard.mjs" hook $runtime $hooks $Target
if ($LASTEXITCODE -ne 0) { throw 'Installer path guard generation failed; bundle not built.' }
$resources = @{}
$resources[$runtime] = 'runtime'
$json = @{ bundle = @{ targets = @('nsis'); icon = @((Join-Path $repo 'build/windows/icons/icon.ico')); resources = $resources; windows = @{ nsis = @{ installMode = 'currentUser'; installerHooks = $hooks } } } } | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($config,$json,[Text.UTF8Encoding]::new($false))
Push-Location $repo
try {
    # Explicit targets use Tauri's target-specific output; the default keeps its historic path.
    $targetArgs = if ($PSBoundParameters.ContainsKey('Target')) { @('--target', $rustTarget) } else { @() }
    & pnpm.cmd --filter '@gentle-dot/desktop' exec tauri build --config $config --bundles nsis @targetArgs
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
} finally { Pop-Location }
