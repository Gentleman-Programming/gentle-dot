# CI only. Never execute installers or start the application.
param([switch]$DeveloperChild, [switch]$Help)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Help) {
    Write-Output 'usage: build-mars-ci.ps1 [-Help] (GitHub Windows 2022 CI only; -DeveloperChild is internal)'
    return
}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Hosted Windows CI required.' }
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $repo
$root = Join-Path $repo 'build/mars-ci'
$cache = Join-Path $root 'cache'
$artifacts = Join-Path $root 'artifacts'
function Run([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)" }
}
function NativeTool([string]$Name) {
    # Application lookup can return multiple PATH matches even without -All.
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $path = (Resolve-Path -LiteralPath $command.Source -ErrorAction Stop).ProviderPath
    if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf) -or
        $path -match '[;\r\n"]') { throw "Invalid native tool path: $Name" }
    return [string]$path
}
function AssertNativeTools {
    # The unchanged producer invokes bare names, so absolute Run paths alone are insufficient.
    foreach ($name in @('node.exe','pnpm.cmd','go.exe','rustup.exe','rustc.exe','cargo.exe','git.exe','tar.exe','cmd.exe')) {
        $null = NativeTool $name
    }
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Json([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
}
# stage.ps1's DownloadVerified is private to its executable producer. Do not dot-source it.
# Use the same official list/hash pattern here, but reject duplicate exact entries too.
function DownloadNodeInput([string]$Name, [string]$Listing) {
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($Name) + '\r?$'
    $entries = [regex]::Matches($Listing, $pattern)
    if ($entries.Count -ne 1) { throw "Expected one checksum entry for $Name" }
    $file = Join-Path $cache ([IO.Path]::GetFileName($Name))
    Invoke-WebRequest "https://nodejs.org/dist/v24.15.0/$Name" -OutFile $file
    if ((Hash $file) -ne $entries[0].Groups[1].Value.ToLowerInvariant()) { throw "Checksum mismatch: $Name" }
    return $file
}
if (-not $DeveloperChild) {
    foreach ($path in @('node_modules', 'build/windows/runtime', 'build/mars-ci/artifacts',
        'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release')) {
        if (Test-Path (Join-Path $repo $path)) { throw "Fresh checkout required: $path exists" }
    }
    $nodeDir = Split-Path -LiteralPath (NativeTool 'node.exe')
    $pnpmDir = Split-Path -LiteralPath (NativeTool 'pnpm.cmd')
    $goDir = Split-Path -LiteralPath (NativeTool 'go.exe')
    $rustDir = Split-Path -LiteralPath (NativeTool 'rustup.exe')
    $gitDir = Split-Path -LiteralPath (NativeTool 'git.exe')
    foreach ($dir in @($cache, $artifacts, "$cache/temp", "$cache/home", "$cache/ps")) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # Hosted child processes only; no machine/user environment or local session control changes.
    $env:PATH = @(
        $nodeDir
        $pnpmDir
        $goDir
        $rustDir
        $gitDir
        "$env:SystemRoot/System32"
        $env:SystemRoot
        $PSHOME
    ) -join ';'
    AssertNativeTools
    $env:HOME = "$cache/home"
    $env:USERPROFILE = $env:HOME
    $env:APPDATA = "$cache/home/AppData/Roaming"
    $env:LOCALAPPDATA = "$cache/home/AppData/Local"
    $env:TEMP = "$cache/temp"
    $env:TMP = $env:TEMP
    $env:TMPDIR = $env:TEMP
    $env:RUNNER_TEMP = $env:TEMP
    $env:PSModuleAnalysisCachePath = "$cache/ps/ModuleAnalysisCache"
    $env:npm_config_userconfig = "$cache/user.npmrc"
    $env:npm_config_globalconfig = "$cache/global.npmrc"
    [IO.File]::WriteAllText($env:npm_config_userconfig, '')
    [IO.File]::WriteAllText($env:npm_config_globalconfig, '')
    $env:npm_config_cache = "$cache/npm"
    $env:npm_config_registry = 'https://registry.npmjs.org/'
    $env:npm_config_update_notifier = 'false'
    $env:PNPM_HOME = "$cache/pnpm-home"
    $env:PNPM_CONFIG_STORE_DIR = "$cache/pnpm-store"
    $env:PNPM_CONFIG_CACHE_DIR = "$cache/pnpm-cache"
    $env:PNPM_CONFIG_STATE_DIR = "$cache/pnpm-state"
    $env:PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE = '["gentle-pi@4.7.0"]'
    $env:GOPATH = "$cache/go"
    $env:GOMODCACHE = "$cache/go-mod"
    $env:GOCACHE = "$cache/go-build"
    $env:GOENV = 'off'
    $env:GOTOOLCHAIN = 'local'
    $env:CARGO_HOME = "$cache/cargo"
    $env:RUSTUP_HOME = "$cache/rustup"
    $env:RUSTUP_TOOLCHAIN = '1.96.1'
    $env:GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED = '1'
    Run node.exe @('-e', 'if(process.version!=="v24.15.0"||process.arch!=="x64")process.exit(1)')
    Run pnpm.cmd @('--version')
    $pnpmVersion = & pnpm.cmd --version
    if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.5.0') { throw 'pnpm pin mismatch' }
    $goVersion = & go.exe version
    if ($LASTEXITCODE -ne 0 -or $goVersion -ne 'go version go1.25.10 windows/amd64') { throw 'Go pin mismatch' }
    Run rustup.exe @('toolchain', 'install', '1.96.1', '--profile', 'minimal', '--target', 'x86_64-pc-windows-msvc')
    $vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
    if (-not (Test-Path $vswhere -PathType Leaf)) { throw 'vswhere missing' }
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or @($vs).Count -ne 1) { throw 'MSVC installation not unique' }
    $vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
    if (-not (Test-Path $vcvars -PathType Leaf)) { throw 'vcvars64 missing' }
    # CMD initializes INCLUDE/LIB, then PS inherits them; never dump the environment with `set`.
    $command = 'call "{0}" >nul && "{1}" -NoProfile -File "{2}" -DeveloperChild' -f $vcvars, "$PSHOME/pwsh.exe", $PSCommandPath
    Run "$env:SystemRoot/System32/cmd.exe" @('/d', '/s', '/c', $command)
    return
}
if (-not $env:INCLUDE -or -not $env:LIB -or $env:GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED -ne '1') {
    throw 'Developer environment or packaged-required marker missing'
}
AssertNativeTools
$compiler = NativeTool 'cl.exe'
$listing = (Invoke-WebRequest 'https://nodejs.org/dist/v24.15.0/SHASUMS256.txt').Content
if ($listing -is [byte[]]) { $listing = [Text.Encoding]::UTF8.GetString($listing) }
$headersArchive = DownloadNodeInput 'node-v24.15.0-headers.tar.gz' $listing
$nodeLib = DownloadNodeInput 'win-x64/node.lib' $listing
# Both inputs have been verified before extraction or compilation.
Run tar.exe @('-xzf', $headersArchive, '-C', $cache)
$headers = Join-Path $cache 'node-v24.15.0/include/node'
Run node.exe @('packages/daemon/scripts/build-windows-stop.mjs', '--compiler', $compiler,
    '--headers', $headers, '--node-lib', $nodeLib)
$addon = Join-Path $repo 'packages/daemon/native/windows-stop.node'
$loadOnly = 'require(process.argv[1]); console.log("windows-stop-load-ok")'
Run node.exe @('-e', $loadOnly, $addon)
# Workspace allowBuilds remains authoritative. This is not the staged npm production install.
Run pnpm.cmd @('install', '--frozen-lockfile', '--ignore-scripts=false')
Run node.exe @('-e', 'if(require("./packages/daemon/node_modules/gentle-pi/package.json").version!=="4.7.0")process.exit(1)')
Run rustc.exe @('--version')
# Existing producer owns fresh staging, currentUser NSIS, path hook and runtime sealing.
& "$PSScriptRoot/package.ps1" -Target windows-x64
if ($LASTEXITCODE -ne 0) { throw 'Windows producer failed' }
$runtime = Join-Path $repo 'build/windows/runtime'
$manifest = Join-Path $runtime 'WINDOWS-INTEGRITY.json'
Run (Join-Path $runtime 'node/node.exe') @('-e', $loadOnly, (Join-Path $runtime 'daemon/native/windows-stop.node'))
Run node.exe @("$PSScriptRoot/runtime-integrity.mjs", 'verify', $runtime, $manifest, 'windows-x64')
$config = Get-Content 'build/windows/bundle.json' -Raw | ConvertFrom-Json
if ($config.bundle.windows.nsis.installMode -ne 'currentUser' -or
    $config.bundle.windows.nsis.installerHooks -ne (Join-Path $repo 'build/windows/installer-path-hooks.nsh') -or
    -not (Test-Path 'build/windows/installer-path-hooks.nsh' -PathType Leaf)) { throw 'NSIS path hook contract missing' }
$output = 'apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release'
$buildOutputs = @(Get-ChildItem "$output/build/gentle-dot-*/output" -File)
$markerOutputs = @($buildOutputs | Where-Object {
    (Get-Content $_.FullName -Raw).Contains('cargo:rustc-env=GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED=1')
})
if ($markerOutputs.Count -lt 1) { throw 'Packaged-required build output evidence missing' }
$installers = @(Get-ChildItem "$output/bundle/nsis/*-setup.exe" -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows x64 NSIS installer' }
$installer = $installers[0]
Copy-Item -LiteralPath $installer.FullName -Destination $artifacts
$checksum = Hash (Join-Path $artifacts $installer.Name)
[IO.File]::WriteAllText((Join-Path $artifacts 'SHA256SUMS.txt'), "$checksum  $($installer.Name)`n")
$revision = & git.exe rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -ne $env:GITHUB_SHA) { throw 'Candidate revision mismatch' }
Json (Join-Path $artifacts 'provenance.json') @{
    schema = 1; repository = $env:GITHUB_REPOSITORY; revision = $revision; ref = $env:GITHUB_REF
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; target = 'windows-x64'
    host = @{ node = '24.15.0'; pnpm = '11.5.0'; go = '1.25.10'; rust = '1.96.1' }
    bundled = @{ node = '24.14.1'; engram = '3.4.0' }
    inputs = @{ headersSha256 = (Hash $headersArchive); nodeLibSha256 = (Hash $nodeLib) }
    installer = @{ name = $installer.Name; sha256 = $checksum; bytes = $installer.Length }
    packagedRequired = '1'; buildOutputSha256 = @($markerOutputs | ForEach-Object { Hash $_.FullName })
    pathHookSha256 = (Hash 'build/windows/installer-path-hooks.nsh'); runtimeIntegritySha256 = (Hash $manifest)
    addonHostLoad = $true; addonStagedLoad = $true; runtimeIntegrityVerified = $true
    unsignedTestArtifact = $true; installed = $false; applicationStarted = $false; stableAcceptance = $false
}
