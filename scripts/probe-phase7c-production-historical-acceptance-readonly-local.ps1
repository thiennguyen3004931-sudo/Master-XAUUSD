param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$ExpectedMainCommit,
    [ValidateRange(3, 30)] [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedMainCommit = $ExpectedMainCommit.Trim().ToLowerInvariant()
$ReferenceCount = 10
$RequiredSampleCount = 3
$Timeframe = 'M5'

Write-Host '============================================================================='
Write-Host '=== PHASE7C PRODUCTION HISTORICAL ACCEPTANCE — STRICT READ-ONLY V1 ==='
Write-Host '============================================================================='
Write-Host 'READ_ONLY=TRUE'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'GIT_MUTATION=NONE'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'PROCESS_MUTATION=NONE'
Write-Host 'LIFECYCLE_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'
Write-Host 'BRIDGE_RESTART=NONE'
Write-Host 'SECRET_VALUES_PRINTED=FALSE'
Write-Host 'TIMEFRAME=M5'
Write-Host 'SAMPLE_COUNT=3'

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "ProjectRoot does not exist: $ProjectRoot"
}
if ($ExpectedMainCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'ExpectedMainCommit must be an exact 40-character Git SHA.'
}

$CanonicalPreflightPath = Join-Path $ProjectRoot 'scripts\preflight-phase7c-production-readonly-local.ps1'
if (-not (Test-Path -LiteralPath $CanonicalPreflightPath -PathType Leaf)) {
    throw "Canonical production read-only preflight is missing: $CanonicalPreflightPath"
}
$currentPowerShellPath = (Get-Process -Id $PID).Path
if ([string]::IsNullOrWhiteSpace($currentPowerShellPath)) {
    throw 'Unable to resolve the current PowerShell executable for canonical preflight reuse.'
}

$canonicalPreflightOutput = @(
    & $currentPowerShellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
        -File $CanonicalPreflightPath `
        -ProjectRoot $ProjectRoot `
        -ExpectedMainCommit $ExpectedMainCommit `
        -TimeoutSeconds $TimeoutSeconds 2>&1
)
$canonicalPreflightExitCode = $LASTEXITCODE
$canonicalPreflightPassMarker = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'PHASE7C_PRODUCTION_READONLY_PREFLIGHT_V2=PASS'
    }
).Count -eq 1
$canonicalNoRecoveryRequired = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'PREFLIGHT_CLASSIFICATION=NO_RECOVERY_REQUIRED'
    }
).Count -eq 1
$canonicalRecoveryNotRequired = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'RECOVERY_REQUIRED=False'
    }
).Count -eq 1
$canonicalNoNonExactComponents = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'RUNTIME_SOURCE_NON_EXACT_COMPONENTS=NONE'
    }
).Count -eq 1
$canonicalLiveAccount = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'ACCOUNT_MODE=LIVE'
    }
).Count -eq 1
$canonicalBridgeAccountModeMatch = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'BRIDGE_ACCOUNT_MODE_MATCH=True'
    }
).Count -eq 1
$canonicalBridgeAccountIdentityMatch = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'BRIDGE_ACCOUNT_IDENTITY_MATCH=True'
    }
).Count -eq 1
$canonicalLiveAuthorizationValid = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'LIVE_AUTHORIZATION_VALID=True'
    }
).Count -eq 1
$canonicalNoMutatingRequests = @(
    $canonicalPreflightOutput | Where-Object {
        ([string]$_).Trim() -eq 'UNRESOLVED_MUTATING_REQUESTS=0'
    }
).Count -eq 1
$canonicalPreflightPass = $canonicalPreflightExitCode -eq 0 -and $canonicalPreflightPassMarker
$canonicalRuntimeExact = $canonicalPreflightPass -and
    $canonicalNoRecoveryRequired -and
    $canonicalRecoveryNotRequired -and
    $canonicalNoNonExactComponents
$canonicalLiveProductionIdentity = $canonicalLiveAccount -and
    $canonicalBridgeAccountModeMatch -and
    $canonicalBridgeAccountIdentityMatch -and
    $canonicalLiveAuthorizationValid
foreach ($line in $canonicalPreflightOutput) {
    Write-Host "[CANONICAL_PREFLIGHT] $line"
}

function Resolve-ConfigPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Invoke-ApiGet([string]$Path) {
    return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
}

function Read-BridgeArray([string]$Path) {
    $response = Invoke-WebRequest `
        -Uri "$BridgeBase$Path" `
        -Headers $BridgeHeaders `
        -Method Get `
        -UseBasicParsing `
        -TimeoutSec $TimeoutSeconds
    $raw = ([string]$response.Content).Trim()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') {
        return @()
    }
    $parsed = $raw | ConvertFrom-Json
    return @($parsed | Where-Object { $null -ne $_ })
}

function Get-Int64Field($Row, [string]$Name) {
    $property = $Row.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "Missing required candle field: $Name"
    }
    $value = 0L
    if (-not [long]::TryParse(
        [string]$property.Value,
        [Globalization.NumberStyles]::Integer,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$value
    )) {
        throw "Invalid Int64 candle field: $Name"
    }
    return $value
}

function Get-DecimalField($Row, [string]$Name) {
    $property = $Row.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "Missing required candle field: $Name"
    }
    $value = 0D
    if (-not [decimal]::TryParse(
        [string]$property.Value,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$value
    )) {
        throw "Invalid decimal candle field: $Name"
    }
    return $value
}

function Write-SafeStateEvidence(
    [string]$Mode,
    [string]$Arm,
    [bool]$LiveExecutionArmed,
    [int]$PositionCount,
    [int]$PendingOrderCount
) {
    if ($Mode -eq 'PAUSE') { Write-Host 'MODE=PAUSE' }
    else { Write-Host "MODE=$Mode" }

    if ($Arm -eq 'DISARMED') { Write-Host 'ARM=DISARMED' }
    else { Write-Host "ARM=$Arm" }

    if ($LiveExecutionArmed) { Write-Host 'LIVE_EXECUTION_ARMED=True' }
    else { Write-Host 'LIVE_EXECUTION_ARMED=False' }

    if ($PositionCount -eq 0) { Write-Host 'XAUUSD_POSITIONS=0' }
    else { Write-Host "XAUUSD_POSITIONS=$PositionCount" }

    if ($PendingOrderCount -eq 0) { Write-Host 'XAUUSD_PENDING_ORDERS=0' }
    else { Write-Host "XAUUSD_PENDING_ORDERS=$PendingOrderCount" }
}

$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ProjectRoot 'scripts\lib\phase7c-account-mode.ps1'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Executor task config missing: $ConfigPath"
}
if (-not (Test-Path -LiteralPath $AccountLibrary -PathType Leaf)) {
    throw "Account-mode library missing: $AccountLibrary"
}
. $AccountLibrary

$config = Get-Content -LiteralPath $ConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    throw "Control API must be loopback-only. value=$ControlApiUrl"
}
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$configAccountMode = ([string]$config.accountMode).Trim().ToUpperInvariant()
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $configAccountMode
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$modeSnapshot = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
$armSnapshot = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
$positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
$pendingOrders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')

$botMode = ([string]$modeSnapshot.state.mode).Trim().ToUpperInvariant()
$arm = ([string]$armSnapshot.liveArmStatus).Trim().ToUpperInvariant()
$liveExecutionArmed = [bool]$armSnapshot.liveExecutionArmed
$safeState = $botMode -eq 'PAUSE' -and
    $arm -eq 'DISARMED' -and
    -not $liveExecutionArmed -and
    $positions.Count -eq 0 -and
    $pendingOrders.Count -eq 0

Write-Host '=== CANONICAL PREFLIGHT ==='
Write-Host "CANONICAL_PREFLIGHT_RESULT=$(if ($canonicalPreflightPass) { 'PASS' } else { 'FAIL' })"
Write-Host "CANONICAL_PREFLIGHT_EXIT_CODE=$canonicalPreflightExitCode"
Write-Host "CANONICAL_NO_RECOVERY_REQUIRED=$canonicalNoRecoveryRequired"
Write-Host "CANONICAL_LIVE_ACCOUNT=$canonicalLiveAccount"
Write-Host "CANONICAL_BRIDGE_ACCOUNT_MODE_MATCH=$canonicalBridgeAccountModeMatch"
Write-Host "CANONICAL_BRIDGE_ACCOUNT_IDENTITY_MATCH=$canonicalBridgeAccountIdentityMatch"
Write-Host "CANONICAL_LIVE_AUTHORIZATION_VALID=$canonicalLiveAuthorizationValid"
Write-Host "CANONICAL_NO_MUTATING_REQUESTS=$canonicalNoMutatingRequests"
if ($canonicalRuntimeExact) { Write-Host 'CANONICAL_RUNTIME_SOURCE=EXACT' }
else { Write-Host 'CANONICAL_RUNTIME_SOURCE=MISMATCH' }
if ($canonicalLiveProductionIdentity) { Write-Host 'CANONICAL_PRODUCTION_ACCOUNT=LIVE_REAL_EXACT' }
else { Write-Host 'CANONICAL_PRODUCTION_ACCOUNT=MISMATCH' }
Write-Host '=== SAFE RUNTIME STATE ==='
Write-SafeStateEvidence `
    -Mode $botMode `
    -Arm $arm `
    -LiveExecutionArmed $liveExecutionArmed `
    -PositionCount $positions.Count `
    -PendingOrderCount $pendingOrders.Count

$verdict = 'FAIL'
$reason = 'UNINITIALIZED'

if (-not $canonicalPreflightPass) {
    $reason = 'CANONICAL_PREFLIGHT_FAIL'
} elseif (-not $canonicalRuntimeExact) {
    $reason = 'RUNTIME_SOURCE_NOT_EXACT'
} elseif (-not $canonicalLiveProductionIdentity) {
    $reason = 'PRODUCTION_LIVE_ACCOUNT_REQUIRED'
} elseif (-not $canonicalNoMutatingRequests) {
    $reason = 'UNRESOLVED_MUTATING_REQUESTS_PRESENT'
} elseif ($liveExecutionArmed) {
    $reason = 'LIVE_EXECUTION_ARMED_NOT_FALSE'
} elseif (-not $safeState) {
    $reason = 'PAUSE_DISARMED_FLAT_REQUIRED'
} else {
    $referencePath = "/v1/candles/XAUUSD?timeframe=$Timeframe&count=$ReferenceCount"
    $referenceRows = @(Read-BridgeArray $referencePath)
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $closedReferenceRows = @(
        $referenceRows | Where-Object {
            try {
                $closeTime = Get-Int64Field $_ 'closeTime'
                $openTime = Get-Int64Field $_ 'openTime'
                $openTime -gt 0 -and $closeTime -gt $openTime -and $closeTime -le $nowMs
            } catch {
                $false
            }
        } | Sort-Object { Get-Int64Field $_ 'openTime' }
    )

    if ($closedReferenceRows.Count -lt $RequiredSampleCount) {
        $reason = 'INSUFFICIENT_CLOSED_M5_REFERENCE_CANDLES'
    } else {
        $samples = @($closedReferenceRows | Select-Object -Last $RequiredSampleCount)
        $allSamplesExact = $true

        for ($index = 0; $index -lt $samples.Count; $index++) {
            $sampleNumber = $index + 1
            $reference = $samples[$index]
            $openTime = Get-Int64Field $reference 'openTime'
            $closeTime = Get-Int64Field $reference 'closeTime'

            $historyPath = "/v1/history/candles/XAUUSD?timeframe=$Timeframe&fromMs=$openTime&toMs=$closeTime"
            $historyRows = @(Read-BridgeArray $historyPath)
            $matches = @(
                $historyRows | Where-Object {
                    try { (Get-Int64Field $_ 'openTime') -eq $openTime }
                    catch { $false }
                }
            )

            $matchCountExact = $matches.Count -eq 1
            if ($matchCountExact) {
                Write-Host "SAMPLE_${sampleNumber}_HISTORY_MATCH_COUNT=1"
            } else {
                Write-Host "SAMPLE_${sampleNumber}_HISTORY_MATCH_COUNT=$($matches.Count)"
            }

            if (-not $matchCountExact) {
                $allSamplesExact = $false
                Write-Host "SAMPLE_${sampleNumber}_OPEN_TIME=MISMATCH"
                Write-Host "SAMPLE_${sampleNumber}_CLOSE_TIME=MISMATCH"
                Write-Host "SAMPLE_${sampleNumber}_OPEN=MISMATCH"
                Write-Host "SAMPLE_${sampleNumber}_HIGH=MISMATCH"
                Write-Host "SAMPLE_${sampleNumber}_LOW=MISMATCH"
                Write-Host "SAMPLE_${sampleNumber}_CLOSE=MISMATCH"
                continue
            }

            $history = $matches[0]
            $openTimeExact = (Get-Int64Field $history 'openTime') -eq $openTime
            $closeTimeExact = (Get-Int64Field $history 'closeTime') -eq $closeTime
            $openExact = (Get-DecimalField $history 'open') -eq (Get-DecimalField $reference 'open')
            $highExact = (Get-DecimalField $history 'high') -eq (Get-DecimalField $reference 'high')
            $lowExact = (Get-DecimalField $history 'low') -eq (Get-DecimalField $reference 'low')
            $closeExact = (Get-DecimalField $history 'close') -eq (Get-DecimalField $reference 'close')

            if ($openTimeExact) { Write-Host "SAMPLE_${sampleNumber}_OPEN_TIME=EXACT" }
            else { Write-Host "SAMPLE_${sampleNumber}_OPEN_TIME=MISMATCH" }

            if ($closeTimeExact) { Write-Host "SAMPLE_${sampleNumber}_CLOSE_TIME=EXACT" }
            else { Write-Host "SAMPLE_${sampleNumber}_CLOSE_TIME=MISMATCH" }

            if ($openExact) { Write-Host "SAMPLE_${sampleNumber}_OPEN=EXACT" }
            else { Write-Host "SAMPLE_${sampleNumber}_OPEN=MISMATCH" }

            if ($highExact) { Write-Host "SAMPLE_${sampleNumber}_HIGH=EXACT" }
            else { Write-Host "SAMPLE_${sampleNumber}_HIGH=MISMATCH" }

            if ($lowExact) { Write-Host "SAMPLE_${sampleNumber}_LOW=EXACT" }
            else { Write-Host "SAMPLE_${sampleNumber}_LOW=MISMATCH" }

            if ($closeExact) { Write-Host "SAMPLE_${sampleNumber}_CLOSE=EXACT" }
            else { Write-Host "SAMPLE_${sampleNumber}_CLOSE=MISMATCH" }

            if (-not ($openTimeExact -and $closeTimeExact -and $openExact -and $highExact -and $lowExact -and $closeExact)) {
                $allSamplesExact = $false
            }
        }

        if ($allSamplesExact) {
            $verdict = 'PASS'
            $reason = 'THREE_CLOSED_M5_CANDLES_EXACT'
        } else {
            $reason = 'HISTORICAL_CANDLE_PARITY_FAIL'
        }
    }
}

Write-Host "ACCEPTANCE_REASON=$reason"
Write-Host "PHASE7C_PRODUCTION_HISTORICAL_ACCEPTANCE=$verdict"
if ($verdict -eq 'PASS') { exit 0 }
exit 2