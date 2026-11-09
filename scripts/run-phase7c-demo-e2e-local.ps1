param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [ValidateRange(15, 720)] [int]$MaxWaitMinutes = 360,
  [ValidateRange(2, 30)] [int]$PollSeconds = 3,
  [switch]$ConfirmDemoExecution
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"
$ArmPath = Join-Path $ProjectRoot ".runtime\phase7c-live-arm.json"

if (-not $ConfirmDemoExecution) {
  throw "DEMO end-to-end execution requires explicit -ConfirmDemoExecution. This test may open and manage DEMO XAUUSD orders through the existing Trend/Sideway executors."
}
if (-not (Test-Path -LiteralPath $Verifier)) { throw "Strict account verifier missing: $Verifier" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "DEMO end-to-end runner requires PowerShell Administrator because it may use the guarded account-switch Scheduled Task."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$AccountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
$ArmPath = Join-Path $WorkDir "phase7c-live-arm.json"
$api = $ControlApiUrl.TrimEnd('/')

function Get-AccountState {
  if (-not (Test-Path -LiteralPath $AccountStatePath)) { throw "Account-mode state missing: $AccountStatePath" }
  return Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
}

function Set-BotMode([ValidateSet("AUTO", "PAUSE")] [string]$Mode, [string]$Source) {
  $result = Invoke-RestMethod -Uri "$api/api/v1/phase7c/bot-mode" -Method Post -ContentType "application/json" -Body (@{
    mode = $Mode
    source = $Source
  } | ConvertTo-Json) -TimeoutSec 10
  if ([string]$result.state.mode -ne $Mode) { throw "Control API did not confirm bot mode $Mode." }
  return $result
}

function Invoke-StrictVerify([string]$Mode) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Verifier `
    -WorkDir $WorkDir `
    -ExpectedAccountMode $Mode `
    -RequireTelegram
  if ($LASTEXITCODE -ne 0) { throw "Strict $Mode runtime verification failed." }
}

function Invoke-WebAccountSwitchToDemo {
  $capability = Invoke-RestMethod -Uri "$api/api/v1/phase7c-account-switch/capability" -Method Get -TimeoutSec 10
  if (-not [bool]$capability.taskInstalled -or -not [bool]$capability.webCanSwitchAccount) {
    throw "Guarded Web account-switch capability is not ready. Register XAUUSD-Phase7C-Account-Switch first."
  }

  $preflight = Invoke-RestMethod -Uri "$api/api/v1/phase7c-account-switch/preflight" -Method Post -ContentType "application/json" -Body (@{
    targetMode = "DEMO"
  } | ConvertTo-Json) -TimeoutSec 15
  if (-not [bool]$preflight.approved -or [string]::IsNullOrWhiteSpace([string]$preflight.preflightToken)) {
    $blocked = @($preflight.checks.PSObject.Properties | Where-Object { -not [bool]$_.Value } | ForEach-Object { $_.Name })
    throw "Guarded LIVE->DEMO preflight blocked. Checks=$($blocked -join ',')"
  }

  $execute = Invoke-RestMethod -Uri "$api/api/v1/phase7c-account-switch/execute" -Method Post -ContentType "application/json" -Body (@{
    targetMode = "DEMO"
    preflightToken = [string]$preflight.preflightToken
    confirmation = "SWITCH_TO_DEMO"
  } | ConvertTo-Json) -TimeoutSec 15
  $requestId = [string]$execute.requestId
  if ([string]::IsNullOrWhiteSpace($requestId)) { throw "Guarded account switch did not return requestId." }

  $deadline = (Get-Date).AddMinutes(8)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $status = Invoke-RestMethod -Uri "$api/api/v1/phase7c-account-switch/status?requestId=$([uri]::EscapeDataString($requestId))" -Method Get -TimeoutSec 10
    Write-Host "PHASE7C_DEMO_E2E_SWITCH_STATUS=$($status.status)|PHASE=$($status.phase)"
    if ([string]$status.status -eq "PASS") {
      if ([string]$status.finalAccountMode -ne "DEMO" -or [string]$status.finalBotMode -ne "PAUSE") {
        throw "Guarded switch reported PASS but final state is unexpected. Account=$($status.finalAccountMode) Bot=$($status.finalBotMode)"
      }
      return
    }
    if ([string]$status.status -eq "FAIL") { throw "Guarded LIVE->DEMO switch failed: $($status.message)" }
  }
  throw "Guarded LIVE->DEMO switch timed out."
}

function Get-UiSnapshot {
  return Invoke-RestMethod -Uri "$api/api/v1/phase7c-ui?symbol=XAUUSD" -Method Get -TimeoutSec 10
}

function Get-PerformanceSnapshot {
  return Invoke-RestMethod -Uri "$api/api/v1/mt5/performance?days=90&symbol=XAUUSD" -Method Get -TimeoutSec 20
}

Write-Host "PHASE7C_DEMO_E2E=START"
Write-Host "PHASE7C_DEMO_E2E_EXECUTION=EXISTING_STRATEGY_EXECUTORS_ONLY"
Write-Host "PHASE7C_DEMO_E2E_MANUAL_ORDER_SEND=False"
Write-Host "PHASE7C_DEMO_E2E_LIVE_EXECUTION=False"

$state = Get-AccountState
$currentMode = ([string]$state.accountMode).Trim().ToUpperInvariant()
if ($currentMode -notin @("DEMO", "LIVE")) { throw "Unsupported selected account mode: $currentMode" }

[void](Set-BotMode -Mode "PAUSE" -Source "demo-e2e-preflight-pause")
Invoke-StrictVerify $currentMode

if ($currentMode -eq "LIVE") {
  Write-Host "PHASE7C_DEMO_E2E_SWITCH=LIVE_TO_DEMO_START"
  Invoke-WebAccountSwitchToDemo
  Write-Host "PHASE7C_DEMO_E2E_SWITCH=LIVE_TO_DEMO_PASS"
}

$state = Get-AccountState
if ([string]$state.accountMode -ne "DEMO") { throw "DEMO E2E requires selected runtime DEMO." }
if (Test-Path -LiteralPath $ArmPath) { throw "LIVE arm file must not exist before DEMO E2E." }
Invoke-StrictVerify "DEMO"

$uiPre = Get-UiSnapshot
if ([string]$uiPre.safety.accountMode -ne "DEMO" -or -not [bool]$uiPre.safety.readOnly -or [string]$uiPre.safety.orderPermission -ne "NONE") {
  throw "Semantic UI safety contract is not DEMO/read-only/NONE before E2E."
}
foreach ($reasonKey in @("auto", "trendWait", "sidewayWait", "entry", "hold", "stopMove", "partial", "exit")) {
  if ($null -eq $uiPre.reasons.$reasonKey) { throw "Semantic UI reason group missing before E2E: $reasonKey" }
}

$performanceBefore = Get-PerformanceSnapshot
if ([string]$performanceBefore.account.accountMode -ne "DEMO") { throw "Performance endpoint is not reading DEMO before E2E." }
$baselineIds = @{}
foreach ($trade in @($performanceBefore.trades)) { $baselineIds[[string]$trade.id] = $true }

$startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$deadline = (Get-Date).AddMinutes($MaxWaitMinutes)
$autoStarted = $false
$observedSetup = $false
$observedManaging = $false
$observedStopMove = $false
$observedPartial = $false
$lastState = ""
$lastStrategy = ""
$closedTrade = $null
$timedOut = $false

try {
  [void](Set-BotMode -Mode "AUTO" -Source "demo-e2e-explicit-confirmation")
  $autoStarted = $true
  Write-Host "PHASE7C_DEMO_E2E_AUTO=PASS"
  Write-Host "PHASE7C_DEMO_E2E_WAITING_FOR_ONE_SYSTEM_TRADE=START|MAX_MINUTES=$MaxWaitMinutes"

  $nextPerformanceAt = Get-Date
  while ((Get-Date) -lt $deadline) {
    $ui = Get-UiSnapshot
    $uiState = [string]$ui.uiState
    $strategy = [string]$ui.effectiveStrategy
    if ($uiState -ne $lastState -or $strategy -ne $lastStrategy) {
      Write-Host "PHASE7C_DEMO_E2E_UI_STATE=$uiState|MODE=$($ui.mode)|STRATEGY=$strategy|REGIME=$($ui.regime)|STAGE=$($ui.stage)"
      $lastState = $uiState
      $lastStrategy = $strategy
    }

    if ($uiState -eq "SETUP_READY" -and -not $observedSetup) {
      $observedSetup = $true
      Write-Host "PHASE7C_DEMO_E2E_SETUP_OBSERVED=PASS|STRATEGY=$($ui.setup.strategy)|SIDE=$($ui.setup.side)|ENTRY=$($ui.setup.entry)|SL=$($ui.setup.stopLoss)|TP1=$($ui.setup.tp1)|TP2=$($ui.setup.tp2)"
    }
    if ($uiState -eq "MANAGING" -and -not $observedManaging) {
      $observedManaging = $true
      Write-Host "PHASE7C_DEMO_E2E_POSITION_OBSERVED=PASS|TICKET=$($ui.position.ticket)|STRATEGY=$($ui.position.strategy)|SIDE=$($ui.position.side)|ENTRY=$($ui.position.entry)|SL=$($ui.position.stopLoss)|TP1=$($ui.position.tp1)|TP2=$($ui.position.tp2)"
    }
    if (@($ui.reasons.stopMove).Count -gt 0 -and -not $observedStopMove) {
      $observedStopMove = $true
      Write-Host "PHASE7C_DEMO_E2E_STOP_MOVE_OBSERVED=PASS|REASON=$([string]$ui.reasons.stopMove[0])"
    }
    if (@($ui.reasons.partial).Count -gt 0 -and -not $observedPartial) {
      $observedPartial = $true
      Write-Host "PHASE7C_DEMO_E2E_PARTIAL_OBSERVED=PASS|REASON=$([string]$ui.reasons.partial[0])"
    }

    if ((Get-Date) -ge $nextPerformanceAt) {
      $performance = Get-PerformanceSnapshot
      $candidate = @($performance.trades | Where-Object {
        -not $baselineIds.ContainsKey([string]$_.id) -and
        [string]$_.ownership -eq "SYSTEM" -and
        [string]$_.strategy -in @("TREND", "SIDEWAY") -and
        [long]$_.closedAt -ge ($startedAt - 60000)
      } | Sort-Object closedAt -Descending | Select-Object -First 1)
      if ($candidate.Count -gt 0) {
        $closedTrade = $candidate[0]
        break
      }
      $nextPerformanceAt = (Get-Date).AddSeconds(15)
    }

    Start-Sleep -Seconds $PollSeconds
  }

  if ($null -eq $closedTrade) { $timedOut = $true }
}
finally {
  if ($autoStarted) {
    try {
      [void](Set-BotMode -Mode "PAUSE" -Source "demo-e2e-final-pause")
      Write-Host "PHASE7C_DEMO_E2E_FINAL_PAUSE=PASS"
    } catch {
      Write-Warning "Could not restore PAUSE after DEMO E2E: $($_.Exception.Message)"
    }
  }
}

Invoke-StrictVerify "DEMO"
$finalState = Get-AccountState
if ([string]$finalState.accountMode -ne "DEMO") { throw "Final DEMO E2E account mode changed unexpectedly." }
if (Test-Path -LiteralPath $ArmPath) { throw "LIVE arm file unexpectedly exists after DEMO E2E." }
$finalMode = Invoke-RestMethod -Uri "$api/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 10
if ([string]$finalMode.state.mode -ne "PAUSE") { throw "Final DEMO E2E bot mode is not PAUSE." }

if ($timedOut) {
  Write-Host "PHASE7C_DEMO_E2E=NO_TRADE_TIMEOUT"
  Write-Host "PHASE7C_DEMO_E2E_FINAL_ACCOUNT=DEMO"
  Write-Host "PHASE7C_DEMO_E2E_FINAL_BOT_MODE=PAUSE"
  throw "No complete SYSTEM-owned DEMO trade closed within $MaxWaitMinutes minutes. Runtime was returned to DEMO + PAUSE."
}

Write-Host "PHASE7C_DEMO_E2E_CLOSED_TRADE=PASS|ID=$($closedTrade.id)|STRATEGY=$($closedTrade.strategy)|SIDE=$($closedTrade.side)|LOT=$($closedTrade.volume)|ENTRY=$($closedTrade.entry)|EXIT=$($closedTrade.exit)|PNL=$($closedTrade.netPnl)"
Write-Host "PHASE7C_DEMO_E2E_SETUP_OBSERVED=$observedSetup"
Write-Host "PHASE7C_DEMO_E2E_MANAGING_OBSERVED=$observedManaging"
Write-Host "PHASE7C_DEMO_E2E_STOP_MOVE_OBSERVED=$observedStopMove"
Write-Host "PHASE7C_DEMO_E2E_PARTIAL_OBSERVED=$observedPartial"
Write-Host "PHASE7C_DEMO_E2E_FINAL_ACCOUNT=DEMO"
Write-Host "PHASE7C_DEMO_E2E_FINAL_BOT_MODE=PAUSE"
Write-Host "PHASE7C_DEMO_E2E_LIVE_ARM_FILE_PRESENT=False"
Write-Host "PHASE7C_DEMO_E2E=PASS"
