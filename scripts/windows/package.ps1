$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows is required.' }
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
New-Item -ItemType Directory -Path (Join-Path $repo 'build/windows') -Force | Out-Null
Push-Location $repo
try {
    & pnpm.cmd --filter '@gentle-dot/desktop' exec tauri icon src-tauri/icons/icon.png --output ../../build/windows/icons
    if ($LASTEXITCODE -ne 0) { throw 'Windows icon generation failed.' }
} finally { Pop-Location }
& "$PSScriptRoot/stage.ps1"
$runtime = Join-Path $repo 'build/windows/runtime'
$config = Join-Path $repo 'build/windows/bundle.json'
$resources = @{}
$resources[$runtime] = 'runtime'
$json = @{ bundle = @{ targets = @('nsis'); icon = @((Join-Path $repo 'build/windows/icons/icon.ico')); resources = $resources; windows = @{ nsis = @{ installMode = 'currentUser' } } } } | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($config,$json,[Text.UTF8Encoding]::new($false))
Push-Location $repo
try {
    & pnpm.cmd --filter '@gentle-dot/desktop' exec tauri build --config $config --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
} finally { Pop-Location }
