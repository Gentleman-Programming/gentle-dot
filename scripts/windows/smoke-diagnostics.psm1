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

function Get-SmokeTcpState($Exception) {
    # PowerShell/.NET may wrap socket/cancellation exceptions; inspect types, never text.
    for ($depth = 0; $depth -lt 4 -and $null -ne $Exception; $depth++) {
        if ($Exception -is [TimeoutException] -or $Exception -is [OperationCanceledException]) { return 'connecttimeout' }
        if ($Exception -is [Net.Sockets.SocketException]) {
            switch ($Exception.SocketErrorCode) {
                ConnectionRefused { return 'refused' }
                TimedOut { return 'connecttimeout' }
                NetworkUnreachable { return 'unreachable' }
                HostUnreachable { return 'unreachable' }
            }
        }
        if ($Exception -isnot [Exception]) { break }
        $Exception = $Exception.InnerException
    }
    return 'other'
}

function ConvertTo-SmokeProbe([System.Collections.IDictionary]$Probe) {
    $status = $null
    if ($Probe['httpStatus'] -is [int] -and $Probe['httpStatus'] -ge 100 -and $Probe['httpStatus'] -le 599) { $status = $Probe['httpStatus'] }
    [ordered]@{
        tcpState = Select-SmokeEnum $Probe['tcpState'] @('connected','refused','connecttimeout','unreachable','other') 'unknown'
        httpState = Select-SmokeEnum $Probe['httpState'] @('notattempted','response','statuserror','timeout','failure') 'other'
        httpStatus = $status
        jsonState = Select-SmokeEnum $Probe['jsonState'] @('notattempted','valid','invalid','oversize') 'other'
        healthShape = Select-SmokeEnum $Probe['healthShape'] @('missing','array','object') 'other'
        healthState = Select-SmokeEnum $Probe['healthState'] @('notattempted','valid','invalidshape') 'other'
    }
}

function Get-SmokeObservation {
    param([Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$Port)
    # A single post-readiness snapshot, not a retry or a readiness input.
    $probe = [ordered]@{ tcpState='other'; httpState='notattempted'; httpStatus=$null; jsonState='notattempted'; healthShape='missing'; healthState='notattempted' }
    $tcp = [Net.Sockets.TcpClient]::new()
    # Windows can defer a loopback RST; allow its refusal code within this fixed cap.
    $connectDeadline = [Threading.CancellationTokenSource]::new(2500)
    try {
        $tcp.ConnectAsync([Net.IPAddress]::Loopback, $Port, $connectDeadline.Token).GetAwaiter().GetResult()
        $probe.tcpState = 'connected'
    } catch { $probe.tcpState = Get-SmokeTcpState $_.Exception }
    finally { $tcp.Dispose(); $connectDeadline.Dispose() }
    if ($probe.tcpState -ne 'connected') { return $probe }

    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false; $handler.UseCookies = $false; $handler.AllowAutoRedirect = $false
    $handler.MaxResponseHeadersLength = 8
    $client = [Net.Http.HttpClient]::new($handler)
    $deadline = [Threading.CancellationTokenSource]::new(500)
    $response = $null; $stream = $null
    try {
        $response = $client.GetAsync("http://127.0.0.1:$Port/health", [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
        $probe.httpStatus = [int]$response.StatusCode
        if (-not $response.IsSuccessStatusCode) { $probe.httpState = 'statuserror'; return $probe }
        $probe.httpState = 'response'
        $stream = $response.Content.ReadAsStreamAsync($deadline.Token).GetAwaiter().GetResult()
        # Read at most 4097 bytes to distinguish the 4096-byte body boundary.
        $buffer = [byte[]]::new(4097); $count = 0
        while ($count -lt $buffer.Length) {
            $read = $stream.ReadAsync($buffer, $count, $buffer.Length-$count, $deadline.Token).GetAwaiter().GetResult()
            if ($read -eq 0) { break }
            $count += $read
        }
        if ($count -gt 4096) { $probe.jsonState = 'oversize'; return $probe }
        try {
            $text = [Text.UTF8Encoding]::new($false, $true).GetString($buffer, 0, $count)
            if ([string]::IsNullOrWhiteSpace($text)) { $probe.jsonState = 'invalid'; return $probe }
            $health = ConvertFrom-Json -InputObject $text -Depth 16 -NoEnumerate -ErrorAction Stop
            $probe.jsonState = 'valid'
            $safe = New-SmokeDiagnostic -Health $health
            $probe.healthShape = $safe.healthShape
            $probe.healthState = 'invalidshape'
            if ($safe.healthShape -eq 'object' -and $null -ne $safe.healthOk -and $safe.agentState -ne 'unknown') { $probe.healthState = 'valid' }
        } catch { $probe.jsonState = 'invalid' }
    } catch {
        $probe.httpState = 'failure'
        if ((Get-SmokeTcpState $_.Exception) -eq 'connecttimeout') { $probe.httpState = 'timeout' }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $deadline.Dispose(); $client.Dispose()
    }
    return $probe
}

function New-SmokeDiagnostic {
    param($Outcome, $Alive, $ExitCode, $PollCount, $Reachable, $HttpStatus, $Health, $ErrorKind, $Probe)
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
    $diagnostic = [ordered]@{
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
    if ($Probe -is [System.Collections.IDictionary]) { $diagnostic['probe'] = ConvertTo-SmokeProbe $Probe }
    return $diagnostic
}

function Write-SmokeDiagnostic {
    param([string]$Path, [System.Collections.IDictionary]$Diagnostic)
    # Re-project, never serialize arbitrary caller properties or nested content.
    $safe = New-SmokeDiagnostic -Outcome $Diagnostic.outcome -Alive $Diagnostic.processAlive -ExitCode $Diagnostic.exitCode -PollCount $Diagnostic.pollCount -Reachable $Diagnostic.listenerReachable -HttpStatus $Diagnostic.httpStatus -ErrorKind $Diagnostic.errorKind
    $safe.healthShape = Select-SmokeEnum $Diagnostic.healthShape @('missing','array','object') 'other'
    if ($Diagnostic.healthOk -is [bool]) { $safe.healthOk = $Diagnostic.healthOk }
    $safe.agentState = Select-SmokeEnum $Diagnostic.agentState @('starting','idle','thinking','working','needs_you','restarting','error') 'unknown'
    if ($Diagnostic.Contains('probe') -and $Diagnostic['probe'] -is [System.Collections.IDictionary]) { $safe['probe'] = ConvertTo-SmokeProbe $Diagnostic['probe'] }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($safe | ConvertTo-Json -Compress))
    if ($bytes.Length -gt 1024 -or [IO.Path]::GetExtension($Path) -cne '.json') { throw 'Invalid diagnostic request' }
    # CreateNew refuses existing files; validation never alters stored data.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}

Export-ModuleMember -Function New-SmokeDiagnostic, Get-SmokeErrorKind, Write-SmokeDiagnostic, Get-SmokeObservation, Get-SmokeTcpState
