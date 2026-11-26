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
    if ($zip -and !(Test-Path -LiteralPath $zip)) { throw 'Selected ZIP does not exist.' }
    if (!$zip) {
        Write-Host '[1/4] Checking for Windows QA updates...'
        $repo = 'Maicololiveras/gentle-dot'
        $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=100"
        $release = $releases | Where-Object { $_.prerelease -and !$_.draft -and $_.tag_name -match '^qa-preview-[0-9a-f]{12}$' } | Sort-Object published_at -Descending | Select-Object -First 1
        $asset = @($release.assets | Where-Object { $_.name -eq $name })
        if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'No verified Windows QA release is available.' }
        $expected = $asset[0].digest.Substring(7)
        $cache = Join-Path $env:LOCALAPPDATA 'GentleDotQA/packages'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        $zip = Join-Path $cache "$expected.zip"
        if (!(Test-Path -LiteralPath $zip) -or (Get-FileHash -LiteralPath $zip).Hash -ne $expected) {
            Write-Host "Available version: $($release.tag_name)"
            if ((Read-Host 'Download and open this version? [Y/N]') -notmatch '^(y|yes|s|si)$') { exit 0 }
            $uri = "https://github.com/$repo/releases/download/$($release.tag_name)/$name"
            $partial = Join-Path $work 'download.zip'
            Invoke-WebRequest -UseBasicParsing $uri -OutFile $partial
            if ((Get-FileHash -LiteralPath $partial).Hash -ne $expected) { throw 'Release checksum mismatch.' }
            Copy-Item -LiteralPath $partial -Destination $zip -Force
        }
    } else {
        $expected = '58d85e18cba7ee2901e3bea4f0b03bf16048757c2215364700b2e290c47b26d3'
    }
    Write-Host '[2/4] Verifying SHA-256...'
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($hash -eq 'dbc705f98020981034e205affea19e6f00539f2025474c2cebb19b798c834f63') {
        & tar.exe -xf $zip -C $work $name
        if ($LASTEXITCODE) { throw 'Could not unpack the GitHub artifact.' }
        $zip = Join-Path $work $name
        $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    }
    if ($hash -ne $expected) { throw 'Unexpected QA ZIP checksum.' }
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
