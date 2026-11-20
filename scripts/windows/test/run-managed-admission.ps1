$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest

# This process is only the diagnostic step. In particular, inherited Node IPC settings
# must not make Node claim fd3 before the production Windows admission code sees it.
foreach ($name in @(
    'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_OPTIONS', 'NODE_PATH',
    'NODE_REDIRECT_WARNINGS', 'NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE', 'NODE_DEBUG',
    'NODE_DEBUG_NATIVE', 'NODE_EXTRA_CA_CERTS', 'NODE_NO_WARNINGS', 'NODE_TLS_REJECT_UNAUTHORIZED'
)) {
    [Environment]::SetEnvironmentVariable($name, [NullString]::Value, 'Process')
}

$result = 'checkout-unavailable'
try {
    Set-Location -LiteralPath (Join-Path $PSScriptRoot '../../..')
    $result = 'node-unavailable'
    # Application discovery can return multiple PATH entries. Match the producer's
    # normal PATH precedence rather than invoking an array of executable paths.
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $result = 'node-probe-failed'
    $identity = @(& $node -p "process.platform + '-' + process.arch + '-' + process.version" 2>$null)
    if ($LASTEXITCODE -ne 0 -or $identity.Count -ne 1) { throw $result }
    $result = 'node-identity-mismatch'
    if ($identity[0] -cne 'win32-x64-v24.14.1') { throw $result }

    # Require the exact regular checkout addon before Node can try resolution fallbacks.
    $result = 'checkout-addon-invalid'
    $addon = Join-Path $PWD.Path 'packages/daemon/native/windows-stop.node'
    if ([IO.File]::GetAttributes($addon) -band ([IO.FileAttributes]'Directory, ReparsePoint, Device')) { throw $result }
    $result = 'checkout-addon-load-failed'
    $null = & $node -e "require('./packages/daemon/native/windows-stop.node')" 2>$null
    if ($LASTEXITCODE -ne 0) { throw $result }

    $result = 'frontend-missing'
    if (-not (Test-Path -LiteralPath 'packages/ui/dist/app/index.html' -PathType Leaf)) { throw $result }
    $result = 'fixture-failed'
    $env:GENTLE_ADMISSION_NODE = $node
    Set-Location -LiteralPath 'apps/desktop/src-tauri'
    # Match the producer target, release profile and Tauri protocol feature so Cargo
    # can reuse its build-script outputs, including the linked Sherpa static inputs.
    $output = @(& cargo test --offline --locked --release --target x86_64-pc-windows-msvc --features tauri/custom-protocol --lib daemon::windows::native::admission_fixture::production_managed_admission -- --exact --ignored --nocapture 2>$null)
    $exitCode = $LASTEXITCODE
    $onePassed = @($output -cmatch '^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [0-9]+\.[0-9]+s$').Count -eq 1
    if ($exitCode -eq 0 -and $onePassed -and $output -ccontains 'admission-result:orderly') {
        $result = 'orderly'
    } elseif ($exitCode -eq 0 -and ($output -cmatch '^running 0 tests$')) {
        $result = 'zero-tests'
    } else {
        # Never forward compiler output, panic text, or an arbitrary marker suffix.
        $categories = @('node-not-configured', 'record-directory-failed', 'fixture-path-failed',
            'sink-failed', 'channel-failed', 'spawn-failed', 'cleanup-failed', 'early-clean-exit',
            'unsupported-node', 'import-failed', 'stop-listener-failed', 'fd3-adoption-failed',
            'callback-exchange-failed', 'other-exit', 'reader-start-failed', 'status-failed',
            'channel-io-failed', 'ack-mismatch', 'reader-disconnected', 'deadline',
            'orderly-stop-unconfirmed', 'scratch-random-failed', 'scratch-create-failed', 'scratch-retained')
        $reported = @($categories | Where-Object { $output -ccontains "admission-result:$_" })
        if ($reported.Count -eq 1) { $result = $reported[0] }
    }
} catch {
    # Keep the current fixed failure category; exception text may contain paths or environment data.
}
"result=$result" >> $env:GITHUB_OUTPUT
if ($result -cne 'orderly') { exit 1 }
