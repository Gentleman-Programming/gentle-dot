Set-StrictMode -Version Latest

function Select-SmokeEnum($Value, $Allowed, $Fallback) {
    foreach ($item in $Allowed) { if ($Value -is [string] -and $Value -ceq $item) { return $item } }
    return $Fallback
}

function Get-SmokeErrorKind($Exception) {
    if ($Exception -is [System.TimeoutException]) { return 'timeout' }
    if ($Exception -is [System.Net.WebException] -or $Exception -is [System.Net.Http.HttpRequestException]) { return 'transport' }
    return 'other'
}

function New-SmokeDiagnostic {
    param($Outcome, $Alive, $ExitCode, $PollCount, $Reachable, $HttpStatus, $Health, $ErrorKind)
    $shape = 'other'; $ok = $null; $state = 'unknown'
    if ($null -eq $Health) { $shape = 'missing' }
    elseif ($Health -is [array]) { $shape = 'array' }
    elseif ($Health -is [System.Management.Automation.PSCustomObject]) {
        $shape = 'object'
        $property = $Health.PSObject.Properties['ok']
        if ($null -ne $property -and $property.Value -is [bool]) { $ok = $property.Value }
        $property = $Health.PSObject.Properties['agentState']
        if ($null -ne $property) {
            $state = Select-SmokeEnum $property.Value @('starting','idle','thinking','working','needs_you','restarting','error') 'unknown'
        }
    }
    $aliveValue = $null; $exitValue = $null; $reachableValue = $null; $statusValue = $null; $pollValue = 0
    if ($Alive -is [bool]) { $aliveValue = $Alive }
    if ($ExitCode -is [int]) { $exitValue = $ExitCode }
    if ($Reachable -is [bool]) { $reachableValue = $Reachable }
    if ($HttpStatus -is [int] -and $HttpStatus -ge 100 -and $HttpStatus -le 599) { $statusValue = $HttpStatus }
    if ($PollCount -is [int] -and $PollCount -ge 0 -and $PollCount -le 10000) { $pollValue = $PollCount }
    [ordered]@{
        schema = 1
        outcome = Select-SmokeEnum $Outcome @('success','timeout','earlyexit','agenterror') 'other'
        processAlive = $aliveValue
        exitCode = $exitValue
        pollCount = $pollValue
        listenerReachable = $reachableValue
        httpStatus = $statusValue
        healthShape = $shape
        healthOk = $ok
        agentState = $state
        errorKind = Select-SmokeEnum $ErrorKind @('none','timeout','transport') 'other'
    }
}

function Write-SmokeDiagnostic {
    param([string]$Path, [System.Collections.IDictionary]$Diagnostic)
    # Re-project, never serialize arbitrary caller properties or nested content.
    $safe = New-SmokeDiagnostic -Outcome $Diagnostic.outcome -Alive $Diagnostic.processAlive -ExitCode $Diagnostic.exitCode -PollCount $Diagnostic.pollCount -Reachable $Diagnostic.listenerReachable -HttpStatus $Diagnostic.httpStatus -ErrorKind $Diagnostic.errorKind
    $safe.healthShape = Select-SmokeEnum $Diagnostic.healthShape @('missing','array','object') 'other'
    if ($Diagnostic.healthOk -is [bool]) { $safe.healthOk = $Diagnostic.healthOk }
    $safe.agentState = Select-SmokeEnum $Diagnostic.agentState @('starting','idle','thinking','working','needs_you','restarting','error') 'unknown'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($safe | ConvertTo-Json -Compress))
    if ($bytes.Length -gt 1024 -or [IO.Path]::GetExtension($Path) -cne '.json') { throw 'Invalid diagnostic request' }
    # CreateNew refuses existing files; validation never alters stored data.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}

Export-ModuleMember -Function New-SmokeDiagnostic, Get-SmokeErrorKind, Write-SmokeDiagnostic
