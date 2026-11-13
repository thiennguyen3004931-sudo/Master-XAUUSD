$ErrorActionPreference = "Stop"

$Library = Join-Path $PSScriptRoot "lib\phase7c-lifecycle-broker.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}
function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message actual=$Actual expected=$Expected" }
}

if (-not (Test-Path -LiteralPath $Library)) {
  throw "Lifecycle broker helper library must exist: $Library"
}
. $Library

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function New-ValidRequest([string]$Action = "START", [string]$Source = "WEB_CONTROL_CENTER") {
  [pscustomobject]@{
    version = 1
    requestId = [Guid]::NewGuid().ToString()
    action = $Action
    requestedAt = $now
    source = $Source
    reason = if ($Action -eq "STOP") { "USER_STOP" } elseif ($Action -eq "RESTART") { "LOT_SETTINGS_CHANGED" } else { "USER_START" }
  }
}

# Closed request schema.
$valid = Test-Phase7CLifecycleBrokerRequest -Request (New-ValidRequest "START") -NowMs $now
Assert-True $valid.valid "valid START request must pass"
foreach ($action in @("START", "STOP", "RESTART")) {
  $result = Test-Phase7CLifecycleBrokerRequest -Request (New-ValidRequest $action) -NowMs $now
  Assert-True $result.valid "action $action must be accepted"
}
foreach ($source in @("WEB_CONTROL_CENTER", "LOCAL_LIFECYCLE_API")) {
  $sourceResult = Test-Phase7CLifecycleBrokerRequest -Request (New-ValidRequest "START" $source) -NowMs $now
  Assert-True $sourceResult.valid "trusted lifecycle source $source must be accepted"
}
$badSource = New-ValidRequest "START" "REQUEST_BODY_FREE_FORM"
Assert-Equal (Test-Phase7CLifecycleBrokerRequest -Request $badSource -NowMs $now).reasonCode "REJECT_REQUEST_INVALID" "unknown/free-form lifecycle source must be rejected"
$badAction = New-ValidRequest "START"
$badAction.action = "SHELL"
Assert-Equal (Test-Phase7CLifecycleBrokerRequest -Request $badAction -NowMs $now).reasonCode "REJECT_REQUEST_INVALID" "unknown action must be rejected"
$unknown = New-ValidRequest "START"
$unknown | Add-Member -NotePropertyName commandLine -NotePropertyValue "whoami"
Assert-Equal (Test-Phase7CLifecycleBrokerRequest -Request $unknown -NowMs $now).reasonCode "REJECT_REQUEST_INVALID" "unknown/arbitrary field must be rejected"
$stale = New-ValidRequest "START"
$stale.requestedAt = $now - 121000
Assert-Equal (Test-Phase7CLifecycleBrokerRequest -Request $stale -NowMs $now).reasonCode "REJECT_REQUEST_STALE" "request older than 120 seconds must be rejected"

# Idempotency and single in-flight request.
$request = New-ValidRequest "START"
Assert-Equal (Get-Phase7CLifecycleBrokerRequestDisposition -RequestId $request.requestId -ActiveRequestId "other-id" -ExistingResult $false) "REJECT_BROKER_BUSY" "active request must block overwrite"
Assert-Equal (Get-Phase7CLifecycleBrokerRequestDisposition -RequestId $request.requestId -ActiveRequestId $null -ExistingResult $true) "REJECT_REQUEST_DUPLICATE" "existing result must make replay idempotent"
Assert-Equal (Get-Phase7CLifecycleBrokerRequestDisposition -RequestId $request.requestId -ActiveRequestId $null -ExistingResult $false) "ACCEPT" "fresh request with idle broker must be accepted"

# Fail-safe boot policy.
$initial = Get-Phase7CLifecycleBrokerInitialState
Assert-Equal $initial.state "IDLE" "broker must boot IDLE"
Assert-Equal $initial.desiredExecutorState "STOPPED" "broker must boot with executors STOPPED"
Assert-Equal $initial.botMode "PAUSE" "broker must boot PAUSE"

function New-GateContext([string]$AccountMode = "DEMO") {
  [pscustomobject]@{
    accountMode = $AccountMode
    accountValid = $true
    accountModeMatchesConfigured = $true
    botMode = "PAUSE"
    bridgeReachable = $true
    tradingEnabled = $true
    terminalTradeAllowed = $true
    expertTradeAllowed = $true
    positionsKnown = $true
    openXauusdPositions = 0
    telegramConfigured = $true
    taskConfigValid = $true
    liveExecutionEnabled = ($AccountMode -eq "LIVE")
    liveAuthorizationValid = ($AccountMode -eq "LIVE")
    sessionArmValid = $false
  }
}

# Position, account-match, and PAUSE safety.
$stopOpen = New-GateContext
$stopOpen.openXauusdPositions = 1
Assert-Equal (Test-Phase7CLifecycleBrokerSafetyGate -Action "STOP" -Context $stopOpen).reasonCode "REJECT_OPEN_XAUUSD_POSITION" "STOP with open XAUUSD position must fail"
$stopUnknown = New-GateContext
$stopUnknown.positionsKnown = $false
Assert-Equal (Test-Phase7CLifecycleBrokerSafetyGate -Action "STOP" -Context $stopUnknown).reasonCode "REJECT_BRIDGE_UNAVAILABLE" "STOP with unverifiable positions must fail closed"
$restartAuto = New-GateContext
$restartAuto.botMode = "AUTO"
Assert-Equal (Test-Phase7CLifecycleBrokerSafetyGate -Action "RESTART" -Context $restartAuto).reasonCode "REJECT_BOT_NOT_PAUSED" "RESTART outside PAUSE must fail"
$mismatch = New-GateContext
$mismatch.accountModeMatchesConfigured = $false
Assert-Equal (Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $mismatch).reasonCode "REJECT_ACCOUNT_INVALID" "START with broker/config account mismatch must fail"

# DEMO lifecycle never needs ARM.
$demo = New-GateContext "DEMO"
$demo.sessionArmValid = $false
Assert-True (Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $demo).allowed "DEMO START must not require ARM"

# LIVE lifecycle requires durable authorization, but not session ARM.
$live = New-GateContext "LIVE"
$live.sessionArmValid = $false
Assert-True (Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $live).allowed "LIVE START with durable auth must not require session ARM"
Assert-True (Test-Phase7CLifecycleBrokerSafetyGate -Action "RESTART" -Context $live).allowed "LIVE RESTART with durable auth must not require session ARM"
$liveNoAuth = New-GateContext "LIVE"
$liveNoAuth.liveAuthorizationValid = $false
Assert-Equal (Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $liveNoAuth).reasonCode "REJECT_LIVE_AUTH_INVALID" "LIVE START without durable auth must fail"

Write-Host "PHASE7C_SYSTEM_LIFECYCLE_BROKER_CONTRACT_TEST=PASS"
