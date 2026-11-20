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

$result = 'prerequisite-failed'
try {
    Set-Location (Join-Path $PSScriptRoot '../../..')
    $node = (Get-Command node.exe -CommandType Application).Source
    # Recheck the checkout addon built from verified Node inputs, not the staged copy.
    $identity = @(& $node -p "require('./packages/daemon/native/windows-stop.node'); process.platform + '-' + process.arch + '-' + process.version" 2>$null)
    if ($LASTEXITCODE -eq 0 -and $identity.Count -eq 1 -and $identity[0] -ceq 'win32-x64-v24.14.1' -and
        (Test-Path -LiteralPath 'packages/ui/dist/app/index.html' -PathType Leaf)) {
        $env:GENTLE_ADMISSION_NODE = $node
        Set-Location 'apps/desktop/src-tauri'
        # Match the producer target, release profile and Tauri protocol feature so Cargo
        # can reuse its build-script outputs, including the linked Sherpa static inputs.
        $result = 'fixture-failed'
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
    }
} catch {
    # Keep the current fixed failure category; exception text may contain paths or environment data.
}
"result=$result" >> $env:GITHUB_OUTPUT
if ($result -cne 'orderly') { exit 1 }
