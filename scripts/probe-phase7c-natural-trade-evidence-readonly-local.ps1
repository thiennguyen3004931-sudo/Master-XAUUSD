param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [ValidateRange(7, 365)] [int]$Days = 90,
    [ValidateRange(1, 200)] [int]$Limit = 200,
    [ValidateRange(3, 30)] [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)

Write-Host '=================================================================='
Write-Host '=== PHASE7C NATURAL TRADE EVIDENCE — STRICT READ-ONLY V1 ==='
Write-Host '=================================================================='
Write-Host 'READ_ONLY=TRUE'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'GIT_MUTATION=NONE'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'PROCESS_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'
Write-Host 'AUTO_RETUNE=NONE'

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "ProjectRoot does not exist: $ProjectRoot"
}

$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Executor task config missing: $ConfigPath"
}
$config = Get-Content -LiteralPath $ConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    throw "Control API must be loopback-only. value=$ControlApiUrl"
}

$endpoint = "/api/v1/phase7c/performance-effectiveness?symbol=XAUUSD&days=$Days&limit=$Limit"
$snapshot = Invoke-RestMethod -Uri "$ControlApiUrl$endpoint" -Method Get -TimeoutSec $TimeoutSeconds

if ([string]$snapshot.source -ne 'PHASE7C_PERFORMANCE_EFFECTIVENESS' -or -not [bool]$snapshot.readOnly) {
    throw 'Canonical P3 performance-effectiveness read-only contract is unavailable.'
}

$safety = $snapshot.safety
$safetyPass = [bool]$safety.readOnly -and
    -not [bool]$safety.runtimeMutation -and
    -not [bool]$safety.strategyMutation -and
    -not [bool]$safety.riskMutation -and
    -not [bool]$safety.orderMutation -and
    -not [bool]$safety.positionMutation -and
    -not [bool]$safety.modeMutation -and
    -not [bool]$safety.armMutation -and
    -not [bool]$safety.autoRetune -and
    -not [bool]$safety.liveTestOrder
if (-not $safetyPass) { throw 'P3 safety contract is not strictly read-only.' }

function Is-FiniteNumber($Value) {
    if ($null -eq $Value) { return $false }
    $number = 0.0
    return [double]::TryParse(([string]$Value), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number) -and [double]::IsFinite($number)
}
function As-Double($Value) {
    return [double]::Parse(([string]$Value), [Globalization.CultureInfo]::InvariantCulture)
}
function Near([double]$Left, [double]$Right, [double]$Tolerance = 0.0000001) {
    return [Math]::Abs($Left - $Right) -le $Tolerance
}
function Stop-AtOrBeyondBreakEven($Row, $Event) {
    if (-not (Is-FiniteNumber $Event.stopLoss) -or -not (Is-FiniteNumber $Row.entry)) { return $false }
    $sl = As-Double $Event.stopLoss
    $entry = As-Double $Row.entry
    if ([string]$Row.side -eq 'BUY') { return $sl + 0.0000001 -ge $entry }
    if ([string]$Row.side -eq 'SELL') { return $sl -gt 0 -and $sl - 0.0000001 -le $entry }
    return $false
}
function Test-ObservedStopMonotonic($Row) {
    $stops = @($Row.management.events | Where-Object { Is-FiniteNumber $_.stopLoss } | Sort-Object timestamp)
    if ($stops.Count -lt 2) { return 'INSUFFICIENT' }
    for ($i = 1; $i -lt $stops.Count; $i++) {
        $previous = As-Double $stops[$i - 1].stopLoss
        $current = As-Double $stops[$i].stopLoss
        if ([string]$Row.side -eq 'BUY' -and $current + 0.0000001 -lt $previous) { return 'FAIL' }
        if ([string]$Row.side -eq 'SELL' -and $current -gt $previous + 0.0000001) { return 'FAIL' }
    }
    return 'PASS'
}

$rows = @($snapshot.rows)
$liveRows = @($rows | Where-Object { [string]$_.accountMode -eq 'LIVE' })
$exactRows = @($liveRows | Where-Object {
    [string]$_.correlation.verdict -eq 'EXACT' -and
    [string]$_.management.evidence -eq 'EXACT' -and
    [bool]$_.quality.exactCorrelation -and
    [bool]$_.quality.exactManagementEvidence
})

$beObserved = $false
$partialObserved = $false
$partialExactArithmetic = $false
$partialBrokerStepUnproven = $false
$fastMoveContractObserved = $false
$handoffObserved = $false
$m5Observed = $false
$noFastMoveAfterHandoffObserved = $false
$fastMoveAfterHandoffViolation = $false
$slMonotonicObserved = $false
$slWideningViolation = $false

foreach ($row in $exactRows) {
    $events = @($row.management.events | Sort-Object timestamp)

    if (
        (Is-FiniteNumber $row.fastMove.current.activationPrice) -and
        (Is-FiniteNumber $row.fastMove.current.givebackPrice) -and
        (Near (As-Double $row.fastMove.current.activationPrice) 10.0) -and
        (Near (As-Double $row.fastMove.current.givebackPrice) 10.0)
    ) { $fastMoveContractObserved = $true }

    foreach ($event in $events) {
        if (
            [string]$event.family -eq 'BREAK_EVEN' -and
            (Is-FiniteNumber $event.favorablePrice) -and
            (As-Double $event.favorablePrice) + 0.0000001 -ge 6.0 -and
            (Stop-AtOrBeyondBreakEven $row $event)
        ) { $beObserved = $true }

        if ([string]$event.family -eq 'PARTIAL_CLOSE') {
            $hasVolumes = (Is-FiniteNumber $event.closedVolume) -and (Is-FiniteNumber $event.remainingVolume) -and (Is-FiniteNumber $row.initialVolume)
            $atPlus10 = (Is-FiniteNumber $event.favorablePrice) -and (As-Double $event.favorablePrice) + 0.0000001 -ge 10.0
            if ($hasVolumes -and $atPlus10) {
                $closed = As-Double $event.closedVolume
                $remaining = As-Double $event.remainingVolume
                $initial = As-Double $row.initialVolume
                if ($closed -gt 0 -and $remaining -ge 0 -and (Near ($closed + $remaining) $initial 0.000001)) {
                    $partialObserved = $true
                    if (Near ($closed * 3.0) $initial 0.000001) {
                        $partialExactArithmetic = $true
                    } else {
                        $partialBrokerStepUnproven = $true
                    }
                }
            }
        }
    }

    $handoffs = @($events | Where-Object { [string]$_.family -eq 'FAST_MOVE_HANDOFF_M5_STRUCTURE' })
    if ($handoffs.Count -gt 0 -and [bool]$row.fastMove.handoffToM5) {
        $handoffObserved = $true
        $firstHandoff = [long]$handoffs[0].timestamp
        $after = @($events | Where-Object {
            [long]$_.timestamp -gt $firstHandoff -and [string]$_.family -in @('FAST_MOVE_TIGHTEN','FAST_MOVE_REJECTED')
        })
        if ($after.Count -eq 0) {
            $noFastMoveAfterHandoffObserved = $true
        } else {
            $fastMoveAfterHandoffViolation = $true
        }
    }

    if (@($events | Where-Object { [string]$_.family -in @('M5_STRUCTURAL_TIGHTEN','M5_STRUCTURAL_REJECTED') }).Count -gt 0) {
        $m5Observed = $true
    }

    $monotonic = Test-ObservedStopMonotonic $row
    if ($monotonic -eq 'PASS') { $slMonotonicObserved = $true }
    if ($monotonic -eq 'FAIL') { $slWideningViolation = $true }
}

$observableCoveragePass =
    $beObserved -and
    $partialObserved -and
    $fastMoveContractObserved -and
    $handoffObserved -and
    $m5Observed -and
    $noFastMoveAfterHandoffObserved -and
    -not $fastMoveAfterHandoffViolation -and
    $slMonotonicObserved -and
    -not $slWideningViolation

if ($fastMoveAfterHandoffViolation -or $slWideningViolation) {
    $classification = 'OBSERVED_CONTRACT_VIOLATION'
} elseif ($exactRows.Count -eq 0) {
    $classification = 'NO_NATURAL_TRADE_EVIDENCE'
} elseif ($observableCoveragePass) {
    $classification = 'COVERAGE_PASS'
} else {
    $classification = 'PARTIAL_EVIDENCE'
}

$partialProof = if ($partialExactArithmetic) {
    'EXACT_ARITHMETIC_ONE_THIRD_OBSERVED'
} elseif ($partialObserved -and $partialBrokerStepUnproven) {
    'BROKER_STEP_LEGALITY_UNPROVEN'
} elseif ($partialObserved) {
    'VOLUME_OBSERVED'
} else {
    'NOT_OBSERVED'
}

Write-Host "P3_SOURCE=$($snapshot.source)"
Write-Host "P3_READ_ONLY=$($snapshot.readOnly)"
Write-Host "P3_TOTAL_ROWS=$($rows.Count)"
Write-Host "P3_LIVE_ROWS=$($liveRows.Count)"
Write-Host "P3_EXACT_LIVE_ROWS=$($exactRows.Count)"
Write-Host "BREAK_EVEN_PLUS6_OBSERVED=$beObserved"
Write-Host "PARTIAL_PLUS10_OBSERVED=$partialObserved"
Write-Host "PARTIAL_ONE_THIRD_PROOF=$partialProof"
Write-Host "FASTMOVE_10_10_CONTRACT_OBSERVED=$fastMoveContractObserved"
Write-Host "M5_HANDOFF_OBSERVED=$handoffObserved"
Write-Host "M5_STRUCTURAL_EVENT_OBSERVED=$m5Observed"
Write-Host "NO_FASTMOVE_AFTER_HANDOFF_OBSERVED=$noFastMoveAfterHandoffObserved"
Write-Host "FASTMOVE_AFTER_HANDOFF_VIOLATION=$fastMoveAfterHandoffViolation"
Write-Host "SL_MONOTONIC_OBSERVED=$slMonotonicObserved"
Write-Host "SL_WIDENING_VIOLATION=$slWideningViolation"
Write-Host 'PEAK_PERSISTENCE_RUNTIME=NOT_PROVEN_BY_P3_V1'
Write-Host "NATURAL_TRADE_EVIDENCE_STATUS=$classification"

# Missing or partial natural evidence is an observation state, not a trading
# failure. A directly observed contract violation is fail-closed.
if ($classification -eq 'OBSERVED_CONTRACT_VIOLATION') { exit 2 }
exit 0
