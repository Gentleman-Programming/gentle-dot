@echo off
setlocal
set "DOT_QA_SELF=%~f0"
set "DOT_QA_ZIP=%~1"
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -Command "$source=[IO.File]::ReadAllText($env:DOT_QA_SELF); & ([ScriptBlock]::Create($source.Substring($source.LastIndexOf('# POWERSHELL_START')+18)))"
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
# POWERSHELL_START
$ErrorActionPreference = 'Stop'
$work = Join-Path $env:LOCALAPPDATA ('GentleDotQA\' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    $name = 'Gentle-Dot-Preview-x64.zip'
    $zip = $env:DOT_QA_ZIP
    if (!$zip) { $zip = Join-Path (Split-Path $env:DOT_QA_SELF) $name }
    if (!(Test-Path -LiteralPath $zip -PathType Leaf)) {
        Write-Host '[1/4] Downloading Windows x64 QA build 7268039...'
        $downloaded = $false
        if (Get-Command gh.exe -ErrorAction SilentlyContinue) {
            & gh.exe run download 45692750068 -R Maicololiveras/gentle-dot -n Gentle-Dot-Preview-Windows-x64 -D $work
            $downloaded = $LASTEXITCODE -eq 0
        }
        if ($downloaded) { $zip = Join-Path $work $name }
        else {
            Start-Process 'https://github.com/Maicololiveras/gentle-dot/actions/runs/45692750068/artifacts/15060246361'
            $zip = (Read-Host 'Sign in to GitHub, download the artifact, then paste the ZIP path here').Trim('"')
        }
    }
    Write-Host '[2/4] Verifying SHA-256...'
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($hash -eq 'dbc705f98020981034e205affea19e6f00539f2025474c2cebb19b798c834f63') {
        & tar.exe -xf $zip -C $work $name
        if ($LASTEXITCODE) { throw 'Could not unpack the GitHub artifact.' }
        $zip = Join-Path $work $name
        $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    }
    if ($hash -ne '58d85e18cba7ee2901e3bea4f0b03bf16048757c2215364700b2e290c47b26d3') { throw 'Unexpected ZIP checksum for build 7268039.' }
    Write-Host '[3/4] Extracting the verified preview and its runtime...'
    & tar.exe -xf $zip -C $work
    if ($LASTEXITCODE) { throw 'Preview extraction failed.' }
    Write-Host '[4/4] Starting the isolated preview...'
    & (Join-Path $work 'Start-Preview.ps1')
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
