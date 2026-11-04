$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
    $repo = (Resolve-Path "$PSScriptRoot/../..").Path
    $runtime = Join-Path $repo 'build/windows/runtime'
    $explicitRuntime = $false
    $skipStage = $false
    $check = $false
    $bundles = 'nsis,msi'
    for ($i = 0; $i -lt $args.Count; $i++) {
        $option = $args[$i]
        switch -CaseSensitive ($option) {
            '--help' {
                [Console]::Out.WriteLine('Usage: package.ps1 [--runtime PATH] [--skip-stage] [--check] [--bundles nsis,msi|nsis|msi] [--help]')
                [Console]::Out.WriteLine('Stages the default runtime unless --skip-stage or --runtime is supplied.')
                [Console]::Out.WriteLine('--check validates only: no staging, icon generation, or installer build.')
                exit 0
            }
            '--skip-stage' { $skipStage = $true }
            '--check' { $check = $true }
            { $_ -ceq '--runtime' -or $_ -ceq '--bundles' } {
                $i++
                if ($i -ge $args.Count -or $args[$i].StartsWith('--')) { throw "Missing value for $option" }
                if ($option -ceq '--runtime') {
                    $runtime = [IO.Path]::GetFullPath($args[$i])
                    $explicitRuntime = $true
                } else { $bundles = $args[$i] }
            }
            default { throw "Unknown option: $option" }
        }
    }
    if ($bundles -cnotin @('nsis', 'msi', 'nsis,msi')) { throw 'Bundles must be nsis, msi, or nsis,msi.' }
    if ($env:OS -ne 'Windows_NT') { throw 'Native Windows is required.' }
    if (-not $check -and -not $skipStage -and -not $explicitRuntime) {
        & "$PSScriptRoot/stage.ps1"
        if (-not $?) { throw 'Windows runtime staging failed.' }
    }
    if (-not (Test-Path -LiteralPath $runtime -PathType Container)) { throw "Runtime directory is missing: $runtime" }
    # Validate with the build-host Node, never execute unverified runtime binaries.
    # PS5 represents native stderr as ErrorRecord; capture it without its host stack formatting.
    $ErrorActionPreference = 'Continue'
    $validation = & node.exe "$PSScriptRoot/package-plan.mjs" $runtime 2>&1
    $validationExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($validationExit -ne 0) { throw (($validation | ForEach-Object { $_.ToString() }) -join "`n") }
    if ($check) {
        [Console]::Out.WriteLine("Windows runtime verified: $runtime")
        exit 0
    }
    New-Item -ItemType Directory -Path (Join-Path $repo 'build/windows') -Force | Out-Null
    Push-Location $repo
    try {
        & pnpm.cmd --filter '@gentle-dot/desktop' exec tauri icon src-tauri/icons/icon.png --output ../../build/windows/icons
        if ($LASTEXITCODE -ne 0) { throw 'Windows icon generation failed.' }
    } finally { Pop-Location }
    $config = Join-Path $repo 'build/windows/bundle.json'
    $resources = @{}
    $resources[$runtime] = 'runtime'
    $json = @{ bundle = @{ targets = @($bundles.Split(',')); icon = @((Join-Path $repo 'build/windows/icons/icon.ico')); resources = $resources; windows = @{ nsis = @{ installMode = 'currentUser' } } } } | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($config,$json,[Text.UTF8Encoding]::new($false))
    Push-Location $repo
    try {
        & pnpm.cmd --filter '@gentle-dot/desktop' exec tauri build --config $config --bundles $bundles
        if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }
    } finally { Pop-Location }
} catch {
    [Console]::Error.WriteLine("Windows packaging: $($_.Exception.Message)")
    exit 1
}
