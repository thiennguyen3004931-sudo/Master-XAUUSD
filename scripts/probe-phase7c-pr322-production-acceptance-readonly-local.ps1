param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$ExpectedMainCommit,
    [ValidateRange(3, 30)] [int]$TimeoutSeconds = 12,
    [ValidateRange(15, 300)] [int]$DecisionFreshnessSeconds = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedMainCommit = $ExpectedMainCommit.Trim().ToLowerInvariant()
$RequiredComponents = @('api','web','supervisor','trend','sideway','telegram','regime-notifier','lifecycle-broker')
$ExpectedOriginUrls = @(
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master',
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git',
    'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master.git'
)

Write-Host '=================================================================='
Write-Host '=== PHASE7C PR322 PRODUCTION ACCEPTANCE — STRICT READ-ONLY V1 ==='
Write-Host '=================================================================='
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

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) { throw "ProjectRoot does not exist: $ProjectRoot" }
if ($ExpectedMainCommit -notmatch '^[0-9a-f]{40}$') { throw 'ExpectedMainCommit must be an exact 40-character Git SHA.' }

# Reuse the established production read-only preflight first. This preserves
# canonical account identity, task ownership/drift, unresolved control-request,
# deployment, runtime-source and bridge safety checks instead of reimplementing
# a narrower acceptance path here.
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
$canonicalPreflightPass = $canonicalPreflightExitCode -eq 0 -and $canonicalPreflightPassMarker
foreach ($line in $canonicalPreflightOutput) {
    Write-Host "[CANONICAL_PREFLIGHT] $line"
}

function Resolve-ConfigPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}
function Invoke-ApiGet([string]$Path) {
    return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
}
function Read-BridgeArray([string]$Path) {
    $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec $TimeoutSeconds
    $raw = ([string]$response.Content).Trim()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
    return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}
function To-UnixMilliseconds([string]$Iso) {
    try { return [DateTimeOffset]::Parse($Iso, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() }
    catch { return $null }
}

$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$localBranch = 'UNAVAILABLE'
$localHead = 'UNAVAILABLE'
$localTree = 'UNAVAILABLE'
$remoteMain = 'UNAVAILABLE'
$localDirtyCount = -1
$originCanonical = $false

Push-Location $ProjectRoot
try {
    $localBranch = ([string](& $gitExe branch --show-current)).Trim()
    $localHead = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
    $localTree = ([string](& $gitExe rev-parse 'HEAD^{tree}')).Trim().ToLowerInvariant()
    $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
    $localDirtyCount = @($dirty | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
    $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
    $originCanonical = $ExpectedOriginUrls -contains $originUrl
    $remoteRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
    if ($remoteRaw.Count -eq 1) { $remoteMain = ([string]$remoteRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant() }
} finally {
    Pop-Location
}

$sourceExact = $localBranch -eq 'main' -and
    $localHead -eq $ExpectedMainCommit -and
    $remoteMain -eq $ExpectedMainCommit -and
    $localDirtyCount -eq 0 -and
    $originCanonical -and
    $localTree -match '^[0-9a-f]{40}$'

$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ProjectRoot 'scripts\lib\phase7c-account-mode.ps1'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Executor task config missing: $ConfigPath" }
if (-not (Test-Path -LiteralPath $AccountLibrary -PathType Leaf)) { throw "Account-mode library missing: $AccountLibrary" }
. $AccountLibrary

$config = Get-Content -LiteralPath $ConfigPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') { throw "Control API must be loopback-only. value=$ControlApiUrl" }
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$configAccountMode = ([string]$config.accountMode).Trim().ToUpperInvariant()
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $configAccountMode
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$modeSnapshot = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
$decision = Invoke-ApiGet '/api/v1/phase7c/decision-monitor?symbol=XAUUSD'
$ui = Invoke-ApiGet '/api/v1/phase7c-ui?symbol=XAUUSD'
$lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
$runtimeSource = Invoke-ApiGet '/api/v1/phase7c/runtime-source-attestation'
$armSnapshot = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
$positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
$pendingOrders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')

$runtimeComponents = @($runtimeSource.components)
$nonExactComponents = @($runtimeComponents | Where-Object { [string]$_.verdict -ne 'EXACT_MATCH' } | ForEach-Object { [string]$_.component })
$allRequiredExact = $runtimeComponents.Count -eq $RequiredComponents.Count
foreach ($name in $RequiredComponents) {
    $matches = @($runtimeComponents | Where-Object { [string]$_.component -eq $name -and [string]$_.verdict -eq 'EXACT_MATCH' })
    if ($matches.Count -ne 1) { $allRequiredExact = $false }
}
$deploymentCommit = ([string]$runtimeSource.deployment.sourceCommit).Trim().ToLowerInvariant()
$deploymentTree = ([string]$runtimeSource.deployment.sourceTree).Trim().ToLowerInvariant()
$deploymentGenerationExact = $deploymentCommit -eq $ExpectedMainCommit -and $deploymentTree -eq $localTree
$sourceAttestationPass = $sourceExact -and $deploymentGenerationExact -and $allRequiredExact -and [string]$runtimeSource.overall -ne 'UNKNOWN'

$botMode = ([string]$modeSnapshot.state.mode).Trim().ToUpperInvariant()
$modeUpdatedAt = [string]$modeSnapshot.state.updatedAt
$modeUpdatedAtMs = To-UnixMilliseconds $modeUpdatedAt
$decisionMode = ([string]$decision.mode.active).Trim().ToUpperInvariant()
$effectiveStrategy = ([string]$decision.mode.effectiveStrategy).Trim().ToUpperInvariant()
$decisionCheckedAt = 0L
$decisionCheckedAtValid = [long]::TryParse(([string]$decision.engine.checkedAt), [ref]$decisionCheckedAt) -and $decisionCheckedAt -gt 0
$lastCandleCloseTime = 0L
$lastCandleCloseValid = [long]::TryParse(([string]$decision.engine.lastCandleCloseTime), [ref]$lastCandleCloseTime) -and $lastCandleCloseTime -gt 0
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$decisionAgeMs = if ($decisionCheckedAtValid) { $nowMs - $decisionCheckedAt } else { [long]::MaxValue }
$decisionAfterAuto = $null -ne $modeUpdatedAtMs -and $decisionCheckedAtValid -and $decisionCheckedAt -ge [long]$modeUpdatedAtMs
$m15AfterAuto = $null -ne $modeUpdatedAtMs -and $lastCandleCloseValid -and $lastCandleCloseTime -ge [long]$modeUpdatedAtMs
$decisionFresh = $decisionAfterAuto -and $m15AfterAuto -and $decisionAgeMs -ge 0 -and $decisionAgeMs -le ($DecisionFreshnessSeconds * 1000)
$autoNotActive = $botMode -ne 'AUTO' -or $decisionMode -ne 'AUTO'
$blockedByMode = ([string]$ui.gates.trend -eq 'BLOCKED_BY_MODE') -or ([string]$ui.gates.sideway -eq 'BLOCKED_BY_MODE')
$effectiveStrategyValid = $effectiveStrategy -in @('TREND','SIDEWAY')

$lifecycleRunning = [bool]$lifecycle.running
$lifecycleReady = [bool]$lifecycle.ready
$accountMode = ([string]$lifecycle.accountMode.accountMode).Trim().ToUpperInvariant()
$accountModeValid = [bool]$lifecycle.accountMode.valid
$mt5Connected = [bool]$lifecycle.bridge.reachable
$arm = ([string]$armSnapshot.liveArmStatus).Trim().ToUpperInvariant()
$liveExecutionArmed = [bool]$armSnapshot.liveExecutionArmed
$runtimeGate = $lifecycleRunning -and $lifecycleReady -and $accountModeValid -and $accountMode -eq 'LIVE' -and $mt5Connected -and $arm -eq 'ARMED' -and $liveExecutionArmed

$verdict = 'PASS'
$reason = 'ALL_GATES_PASS'
if (-not $canonicalPreflightPass) {
    $verdict = 'FAIL'; $reason = 'CANONICAL_PREFLIGHT_FAIL'
} elseif (-not $sourceAttestationPass) {
    $verdict = 'FAIL'; $reason = 'SOURCE_OR_RUNTIME_PARITY_FAIL'
} elseif (-not $runtimeGate) {
    $verdict = 'FAIL'; $reason = 'RUNTIME_GATE_FAIL'
} elseif ($autoNotActive) {
    $verdict = 'FAIL'; $reason = 'AUTO_NOT_ACTIVE'
} elseif (-not $decisionAfterAuto -or -not $m15AfterAuto -or -not $decisionFresh) {
    $verdict = 'PENDING_FRESH_DECISION'; $reason = 'WAITING_FOR_POST_AUTO_M15_DECISION'
} elseif (-not $effectiveStrategyValid) {
    $verdict = 'FAIL'; $reason = 'AUTO_EFFECTIVE_STRATEGY_INVALID'
} elseif ($blockedByMode) {
    $verdict = 'FAIL'; $reason = 'BLOCKED_BY_MODE'
}

Write-Host '=== SOURCE ==='
Write-Host "CANONICAL_MAIN=$ExpectedMainCommit"
Write-Host "CANONICAL_PREFLIGHT_RESULT=$(if ($canonicalPreflightPass) { 'PASS' } else { 'FAIL' })"
Write-Host "CANONICAL_PREFLIGHT_EXIT_CODE=$canonicalPreflightExitCode"
Write-Host "LOCAL_SOURCE=$(if ($sourceExact) { 'EXACT' } else { 'MISMATCH' })"
Write-Host "RUNTIME_SOURCE=$(if ($allRequiredExact) { 'EXACT' } else { 'MISMATCH' })"
Write-Host "DEPLOYMENT_GENERATION=$(if ($deploymentGenerationExact) { 'EXACT' } else { 'MISMATCH' })"
Write-Host "SOURCE_ATTESTATION=$(if ($sourceAttestationPass) { 'PASS' } else { 'FAIL' })"
Write-Host "LOCAL_HEAD=$localHead"
Write-Host "LOCAL_TREE=$localTree"
Write-Host "REMOTE_MAIN=$remoteMain"
Write-Host "RUNTIME_SOURCE_NON_EXACT_COMPONENTS=$(if ($nonExactComponents.Count -eq 0) { 'NONE' } else { $nonExactComponents -join '|' })"

Write-Host '=== RUNTIME ==='
Write-Host "MT5_CONNECTED=$mt5Connected"
Write-Host "ACCOUNT_MODE=$accountMode"
Write-Host "LIFECYCLE_RUNNING=$lifecycleRunning"
Write-Host "LIFECYCLE_READY=$lifecycleReady"
Write-Host "MODE=$botMode"
Write-Host "ARM=$arm"
Write-Host "LIVE_EXECUTION_ARMED=$liveExecutionArmed"

Write-Host '=== BROKER ==='
Write-Host "XAUUSD_POSITIONS=$($positions.Count)"
Write-Host "XAUUSD_PENDING_ORDERS=$($pendingOrders.Count)"

Write-Host '=== FRESH DECISION ==='
Write-Host "AUTO_ACTIVATED_AT=$modeUpdatedAt"
Write-Host "DECISION_CHECKED_AT=$decisionCheckedAt"
Write-Host "M15_LAST_CANDLE_CLOSE_TIME=$lastCandleCloseTime"
Write-Host "DECISION_AFTER_AUTO=$decisionAfterAuto"
Write-Host "M15_AFTER_AUTO=$m15AfterAuto"
Write-Host "DECISION_FRESH=$decisionFresh"
Write-Host "DECISION_MODE=$decisionMode"
Write-Host "EFFECTIVE_STRATEGY=$effectiveStrategy"
Write-Host "AUTO_NOT_ACTIVE=$autoNotActive"
Write-Host "BLOCKED_BY_MODE=$blockedByMode"
Write-Host "UI_GENERATED_AT_REFERENCE_ONLY=$($ui.generatedAt)"

Write-Host '=== FASTMOVE CONTRACT ==='
Write-Host 'ACTIVATION=10'
Write-Host 'GIVEBACK=10'
Write-Host 'PLUS_6=BE_ONLY'
Write-Host 'PLUS_10=PARTIAL_ONE_THIRD'
Write-Host 'PEAK_PERSISTENCE=TRUE'
Write-Host 'M5_HANDOFF=ONE_WAY'
Write-Host 'FASTMOVE_AFTER_HANDOFF=DISABLED'
Write-Host 'SL_WIDENING=FORBIDDEN'
Write-Host 'P3=ACTIVATION_10_GIVEBACK_10'

Write-Host "ACCEPTANCE_REASON=$reason"
Write-Host "PR322_PRODUCTION_ACCEPTANCE=$verdict"
if ($verdict -eq 'PASS') { exit 0 }
if ($verdict -eq 'PENDING_FRESH_DECISION') { exit 3 }
exit 2
