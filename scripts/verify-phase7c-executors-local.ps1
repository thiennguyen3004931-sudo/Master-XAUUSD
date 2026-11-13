param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$TaskName = "XAUUSD-Phase7C-Executors",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$TelegramEnvFile = ".env.phase7b-telegram",
  [ValidateSet("DEMO", "LIVE")] [string]$AccountMode = "DEMO",
  [switch]$DeploymentGate,
  [switch]$RequireMigratedTask,
  [switch]$RequireTelegram
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountMode = $AccountMode.ToUpperInvariant()
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path
if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
if (-not (Test-Path $EnvFile)) { throw "EnvFile not found: $EnvFile" }
$EnvFile = (Resolve-Path $EnvFile).Path
if (-not [System.IO.Path]::IsPathRooted($TelegramEnvFile)) { $TelegramEnvFile = Join-Path $ProjectRoot $TelegramEnvFile }
if (Test-Path $TelegramEnvFile) { $TelegramEnvFile = (Resolve-Path $TelegramEnvFile).Path }
$RuntimeDir = Join-Path $WorkDir "phase7c-executors"
$TrendStatePath = Join-Path $WorkDir "phase7b-demo-forward\phase7b-demo-state.json"
$SidewayStatePath = Join-Path $WorkDir "phase7c-sideway-forward\phase7c-sideway-state.json"
$TelegramModeStatusPath = Join-Path $RuntimeDir "telegram-mode-status.json"
$TradeNotifierRuntimePath = Join-Path $RuntimeDir "trade-notifier-runtime.json"
$BrokerRoot = Join-Path $WorkDir "phase7c-lifecycle-broker"
$BrokerHeartbeatPath = Join-Path $BrokerRoot "state\heartbeat.json"
$BrokerStatusPath = Join-Path $BrokerRoot "state\status.json"
$StartupRunnerLockPath = Join-Path $RuntimeDir "startup-runner.lock"
$TaskOwnershipHelperPath = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"
if (-not (Test-Path -LiteralPath $TaskOwnershipHelperPath)) { throw "Scheduled task ownership helper not found: $TaskOwnershipHelperPath" }
. $TaskOwnershipHelperPath

if ($AccountMode -eq "LIVE") {
  $ExpectedTrendDir = Join-Path $WorkDir "phase7b-live-forward"
  $ExpectedSidewayDir = Join-Path $WorkDir "phase7c-sideway-live-forward"
} else {
  $ExpectedTrendDir = Join-Path $WorkDir "phase7b-demo-forward"
  $ExpectedSidewayDir = Join-Path $WorkDir "phase7c-sideway-forward"
}
$ExpectedTrendJournal = Join-Path $ExpectedTrendDir "phase7b-demo-events.jsonl"
$ExpectedSidewayJournal = Join-Path $ExpectedSidewayDir "phase7c-sideway-events.jsonl"

function Read-EnvValueFromFile([string]$Path, [string]$Name) {
  if (-not (Test-Path $Path)) { return "" }
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    $key = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
    if ($key -ne $Name) { continue }
    $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
    return $value
  }
  return ""
}

function Read-EnvValue([string]$Name) {
  return Read-EnvValueFromFile $EnvFile $Name
}

function Read-PidStatus([string]$Name) {
  $path = Join-Path $RuntimeDir "$Name.pid"
  if (-not (Test-Path $path)) {
    return [pscustomobject]@{ name = $Name; pid = $null; alive = $false; pidFile = $false }
  }
  try {
    $pidValue = [int](Get-Content -LiteralPath $path -Raw).Trim()
    $alive = $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
    return [pscustomobject]@{ name = $Name; pid = $pidValue; alive = $alive; pidFile = $true }
  } catch {
    return [pscustomobject]@{ name = $Name; pid = $null; alive = $false; pidFile = $true }
  }
}

function Read-StateJson([string]$Path, [string]$Label) {
  if (-not (Test-Path $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "Cannot parse $Label state: $Path. $($_.Exception.Message)"
  }
}

function State-Ticket($State) {
  if ($null -eq $State -or $null -eq $State.managed -or [string]::IsNullOrWhiteSpace([string]$State.managed.ticket)) {
    return ""
  }
  return [string]$State.managed.ticket
}

function Assert-StateAccount($State, [string]$Label, [long]$AccountLogin) {
  if ($null -eq $State -or $null -eq $State.accountLogin) { return }
  $stateLogin = [long]$State.accountLogin
  if ($stateLogin -gt 0 -and $stateLogin -ne $AccountLogin) {
    throw "$Label state belongs to account $stateLogin but MT5 is $AccountLogin."
  }
}

function Test-PendingMatchesPosition($Pending, $Position, $Spec) {
  if ($null -eq $Pending -or $null -eq $Position -or $null -eq $Spec) { return $false }
  $expectedSide = if ([string]$Pending.side -eq "BUY") { "LONG" } elseif ([string]$Pending.side -eq "SELL") { "SHORT" } else { "" }
  if (-not $expectedSide -or [string]$Position.side -ne $expectedSide) { return $false }

  $volumeStep = [double]$Spec.volumeStep
  $point = [double]$Spec.point
  if ($volumeStep -le 0 -or $point -le 0) { return $false }
  if ([math]::Abs([double]$Position.volume - [double]$Pending.volume) -gt ($volumeStep / 2.0 + 1e-9)) { return $false }

  $priceTolerance = [math]::Max($point * 2.0, 0.000001)
  if ([math]::Abs([double]$Position.stopLoss - [double]$Pending.stopLoss) -gt $priceTolerance) { return $false }
  if ([math]::Abs([double]$Position.takeProfit - [double]$Pending.tp2) -gt $priceTolerance) { return $false }

  $createdAt = [double]$Pending.createdAt
  $openedAt = [double]$Position.openedAt
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($createdAt -le 0 -or $openedAt -le 0) { return $false }
  if ($openedAt -lt ($createdAt - 120000) -or $openedAt -gt ($nowMs + 10000)) { return $false }
  return $true
}

function Test-SamePath([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    $leftFull = [System.IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $rightFull = [System.IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
    return [string]::Equals($leftFull, $rightFull, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

$task = $null
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
} catch {
  $classification = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
  Write-Host "PHASE7C_VERIFY_TASK_PROVIDER=$classification"
  if ($classification -ne 'NOT_FOUND') {
    throw "Cannot inspect Scheduled Task '$TaskName'. classification=$classification"
  }
}

$startupRunner = $false
if ($null -eq $task) {
  Write-Host "PHASE7C_VERIFY_TASK=NOT_FOUND"
  Write-Host "PHASE7C_VERIFY_TASK_OWNERSHIP=NOT_FOUND"
  if ($RequireMigratedTask) { throw "Required executor task not found: $TaskName" }
} else {
  $expectedRunnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
  $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $expectedRunnerPath
  $startupRunner = [bool]$ownership.owned
  $actions = @($task.Actions)
  $actionText = if ($actions.Count -eq 1) { "$($actions[0].Execute) $($actions[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
  $directSupervisor = $actions.Count -eq 1 -and $actionText -like "*run-phase7c-executors-local.ps1*" -and $actionText -like "*-Armed*"
  $migrated = $directSupervisor -or $startupRunner
  $taskDrift = @(if ($startupRunner) { Get-Phase7CExecutorTaskDrift -Task $task } else { @() })
  Write-Host "PHASE7C_VERIFY_TASK_STATE=$($task.State)"
  Write-Host "PHASE7C_VERIFY_TASK_MIGRATED=$migrated"
  Write-Host "PHASE7C_VERIFY_TASK_STARTUP_RUNNER=$startupRunner"
  Write-Host "PHASE7C_VERIFY_TASK_OWNERSHIP=$($ownership.reason)"
  Write-Host "PHASE7C_VERIFY_TASK_DRIFT=$(if ($taskDrift.Count -eq 0) { 'NONE' } else { $taskDrift -join ',' })"
  if ($RequireMigratedTask -and -not $startupRunner) {
    throw "Scheduled task $TaskName is not the exact owned Phase 7C startup-runner action. reason=$($ownership.reason)"
  }
  if ($RequireMigratedTask -and $taskDrift.Count -ne 0) {
    throw "Scheduled task $TaskName has canonical definition drift: $($taskDrift -join ',')"
  }
  if (-not $migrated -and $task.State -eq "Running") { throw "Raw/unverified legacy bot task is running. Stop it before Phase 7C execution." }
}

$startupRunnerPid = $null
$startupRunnerAlive = $false
$startupRunnerLockState = 'NOT_APPLICABLE'
$startupRunnerAccountMode = ''
$brokerHeartbeatAgeMs = $null
if ($null -ne $task -and $startupRunner) {
  if ((Test-Path -LiteralPath $BrokerHeartbeatPath) -and (Test-Path -LiteralPath $BrokerStatusPath)) {
    try {
      $brokerHeartbeat = Get-Content -LiteralPath $BrokerHeartbeatPath -Raw | ConvertFrom-Json
      $brokerStatus = Get-Content -LiteralPath $BrokerStatusPath -Raw | ConvertFrom-Json
      if ([int]$brokerHeartbeat.version -ne 1 -or [int]$brokerStatus.version -ne 1) {
        throw 'Unsupported lifecycle broker state version.'
      }
      $startupRunnerPid = [int]$brokerHeartbeat.brokerPid
      $statusBrokerPid = [int]$brokerStatus.brokerPid
      if ($startupRunnerPid -le 0 -or $statusBrokerPid -ne $startupRunnerPid) {
        throw "Lifecycle broker heartbeat/status PID mismatch. heartbeat=$startupRunnerPid status=$statusBrokerPid"
      }
      $brokerHeartbeatAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$brokerHeartbeat.updatedAt
      $startupRunnerAlive = $brokerHeartbeatAgeMs -ge 0 -and
        $brokerHeartbeatAgeMs -le 5000 -and
        $null -ne (Get-Process -Id $startupRunnerPid -ErrorAction SilentlyContinue)
      $startupRunnerAccountMode = [string]$brokerStatus.accountMode
    } catch {
      Write-Host 'PHASE7C_VERIFY_LIFECYCLE_BROKER_STATUS=INVALID'
      $startupRunnerAlive = $false
    }
  } else {
    Write-Host 'PHASE7C_VERIFY_LIFECYCLE_BROKER_STATUS=MISSING'
  }
  $startupRunnerLockState = Get-Phase7CStartupRunnerLockState -LockPath $StartupRunnerLockPath
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_PID=$startupRunnerPid"
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_ALIVE=$startupRunnerAlive"
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_LOCK=$startupRunnerLockState"
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_ACCOUNT_MODE=$startupRunnerAccountMode"
  Write-Host "PHASE7C_VERIFY_BROKER_HEARTBEAT_AGE_MS=$brokerHeartbeatAgeMs"

  if ($RequireMigratedTask -and $task.State -ne 'Running') {
    throw "Required startup-runner Scheduled Task is not Running. state=$($task.State)"
  }
  if ($RequireMigratedTask -and -not $startupRunnerAlive) {
    throw 'Required lifecycle broker task is Running but broker heartbeat does not identify a fresh live broker process.'
  }
  if ($RequireMigratedTask -and $startupRunnerLockState -ne 'HELD') {
    throw "Required startup-runner singleton lock is not exclusively held. state=$startupRunnerLockState"
  }
} else {
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_PID=$startupRunnerPid"
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_ALIVE=$startupRunnerAlive"
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_LOCK=$startupRunnerLockState"
  Write-Host "PHASE7C_VERIFY_STARTUP_RUNNER_ACCOUNT_MODE=$startupRunnerAccountMode"
  Write-Host "PHASE7C_VERIFY_BROKER_HEARTBEAT_AGE_MS=$brokerHeartbeatAgeMs"
}

$telegramToken = Read-EnvValueFromFile $TelegramEnvFile "ZIQ_TELEGRAM_BOT_TOKEN"
$telegramChatId = Read-EnvValueFromFile $TelegramEnvFile "ZIQ_TELEGRAM_CHAT_ID"
$telegramConfigured = (Test-Path $TelegramEnvFile) -and -not [string]::IsNullOrWhiteSpace($telegramToken) -and -not [string]::IsNullOrWhiteSpace($telegramChatId)
Write-Host "PHASE7C_VERIFY_TELEGRAM_CONFIGURED=$telegramConfigured"
if ($RequireTelegram -and -not $telegramConfigured) {
  throw "Telegram verification was required, but $TelegramEnvFile is missing or incomplete."
}

$pidStatuses = @{}
$pidNames = if ($DeploymentGate -and -not $RequireTelegram) { @("supervisor", "trade-notifier") } else { @("supervisor", "trend", "sideway", "telegram-mode", "regime-notifier", "trade-notifier") }
foreach ($name in $pidNames) {
  $status = Read-PidStatus $name
  $pidStatuses[$name] = $status
  $label = $name.ToUpper().Replace("-", "_")
  Write-Host "PHASE7C_VERIFY_${label}_PID=$($status.pid)"
  Write-Host "PHASE7C_VERIFY_${label}_ALIVE=$($status.alive)"
}

$telegramModeReady = $false
$telegramModeStatus = "MISSING"
$telegramModeHeartbeatAgeMs = $null
if (-not $DeploymentGate -or $RequireTelegram) {
  if (Test-Path $TelegramModeStatusPath) {
    try {
      $telegramRuntime = Get-Content -LiteralPath $TelegramModeStatusPath -Raw | ConvertFrom-Json
      $telegramModeStatus = [string]$telegramRuntime.status
      if ($null -ne $telegramRuntime.lastTelegramSuccessAt) {
        $telegramModeHeartbeatAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$telegramRuntime.lastTelegramSuccessAt
      }
      $telegramModeReady = [bool]$telegramRuntime.ready -and
        $null -ne $telegramModeHeartbeatAgeMs -and
        $telegramModeHeartbeatAgeMs -ge -10000 -and
        $telegramModeHeartbeatAgeMs -le 60000
    } catch {
      $telegramModeStatus = "INVALID_STATUS_FILE"
    }
  }
  Write-Host "PHASE7C_VERIFY_TELEGRAM_MODE_READY=$telegramModeReady"
  Write-Host "PHASE7C_VERIFY_TELEGRAM_MODE_RUNTIME_STATUS=$telegramModeStatus"
  Write-Host "PHASE7C_VERIFY_TELEGRAM_MODE_HEARTBEAT_AGE_MS=$telegramModeHeartbeatAgeMs"
}

$tradeNotifierReady = $false
$tradeNotifierRuntimeStatus = 'MISSING'
$tradeNotifierHeartbeatAgeMs = $null
$tradeNotifierNodePid = $null
$tradeNotifierNodeAlive = $false
$tradeNotifierOrderPermission = ''
$tradeNotifierAccountMode = ''
$tradeNotifierTrendJournal = ''
$tradeNotifierSidewayJournal = ''
if (Test-Path -LiteralPath $TradeNotifierRuntimePath) {
  try {
    $tradeNotifierRuntime = Get-Content -LiteralPath $TradeNotifierRuntimePath -Raw | ConvertFrom-Json
    $tradeNotifierRuntimeStatus = [string]$tradeNotifierRuntime.status
    $tradeNotifierOrderPermission = [string]$tradeNotifierRuntime.orderPermission
    $tradeNotifierAccountMode = [string]$tradeNotifierRuntime.accountMode
    $tradeNotifierTrendJournal = [string]$tradeNotifierRuntime.trendJournal
    $tradeNotifierSidewayJournal = [string]$tradeNotifierRuntime.sidewayJournal
    if ($null -ne $tradeNotifierRuntime.heartbeatAt) {
      $tradeNotifierHeartbeatAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$tradeNotifierRuntime.heartbeatAt
    }
    if ($null -ne $tradeNotifierRuntime.pid) {
      $tradeNotifierNodePid = [int]$tradeNotifierRuntime.pid
      $tradeNotifierNodeAlive = $null -ne (Get-Process -Id $tradeNotifierNodePid -ErrorAction SilentlyContinue)
    }
    $wrapperMatches = $pidStatuses["trade-notifier"].pidFile -and
      $null -ne $tradeNotifierRuntime.wrapperPid -and
      [int]$tradeNotifierRuntime.wrapperPid -eq [int]$pidStatuses["trade-notifier"].pid
    $journalsMatch = (Test-SamePath $tradeNotifierTrendJournal $ExpectedTrendJournal) -and
      (Test-SamePath $tradeNotifierSidewayJournal $ExpectedSidewayJournal)
    $journalsExist = (Test-Path -LiteralPath $ExpectedTrendJournal -PathType Leaf) -and
      (Test-Path -LiteralPath $ExpectedSidewayJournal -PathType Leaf)
    $tradeNotifierReady = $pidStatuses["trade-notifier"].alive -and
      $tradeNotifierRuntimeStatus -eq "RUNNING" -and
      $wrapperMatches -and
      $tradeNotifierNodeAlive -and
      $null -ne $tradeNotifierHeartbeatAgeMs -and
      $tradeNotifierHeartbeatAgeMs -ge -10000 -and
      $tradeNotifierHeartbeatAgeMs -le 15000 -and
      $tradeNotifierAccountMode -eq $AccountMode -and
      $tradeNotifierOrderPermission -eq "NONE" -and
      $journalsMatch -and
      $journalsExist
  } catch {
    $tradeNotifierRuntimeStatus = 'INVALID_STATUS_FILE'
    $tradeNotifierReady = $false
  }
}
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_READY=$tradeNotifierReady"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_RUNTIME_STATUS=$tradeNotifierRuntimeStatus"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_HEARTBEAT_AGE_MS=$tradeNotifierHeartbeatAgeMs"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_NODE_PID=$tradeNotifierNodePid"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_NODE_ALIVE=$tradeNotifierNodeAlive"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_ACCOUNT_MODE=$tradeNotifierAccountMode"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_ORDER_PERMISSION=$tradeNotifierOrderPermission"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_TREND_JOURNAL=$tradeNotifierTrendJournal"
Write-Host "PHASE7C_VERIFY_TRADE_NOTIFIER_SIDEWAY_JOURNAL=$tradeNotifierSidewayJournal"
Write-Host "PHASE7C_VERIFY_EXPECTED_TREND_JOURNAL=$ExpectedTrendJournal"
Write-Host "PHASE7C_VERIFY_EXPECTED_SIDEWAY_JOURNAL=$ExpectedSidewayJournal"

if ($RequireTelegram -and (-not $pidStatuses["telegram-mode"].alive -or -not $pidStatuses["regime-notifier"].alive -or -not $pidStatuses["trade-notifier"].alive)) {
  throw "Telegram verification requires telegram-mode, regime-notifier, and trade-notifier processes to be alive."
}
if ($RequireTelegram -and -not $telegramModeReady) {
  throw "Telegram mode controller process is alive but not ready/fresh. Check phase7c-executors\telegram-mode.err.log and telegram-mode-status.json."
}
if (($RequireTelegram -or $DeploymentGate) -and -not $tradeNotifierReady) {
  if ($tradeNotifierRuntimeStatus -eq 'RUNNING' -and $tradeNotifierOrderPermission -ne "NONE") {
    throw "Trade notifier orderPermission must remain NONE. actual=$tradeNotifierOrderPermission"
  }
  throw "Trade notifier is not ready/fresh or its account/journal mapping is incorrect. Check phase7c-executors\trade-notifier.err.log and trade-notifier-runtime.json."
}

if ($DeploymentGate) {
  Write-Host "PHASE7C_VERIFY_DEPLOYMENT_ACCOUNT_MODE=$AccountMode"
  if (-not $pidStatuses["supervisor"].alive) {
    throw 'Deployment gate requires the Phase 7C supervisor process to be alive.'
  }
  if ($startupRunner -and -not [string]::IsNullOrWhiteSpace($startupRunnerAccountMode) -and $startupRunnerAccountMode -ne $AccountMode) {
    throw "Deployment gate account mode mismatch. requested=$AccountMode startupRunner=$startupRunnerAccountMode"
  }
  $apiBase = $ControlApiUrl.TrimEnd('/')
  $deploymentMode = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
  Write-Host "PHASE7C_VERIFY_ACTIVE_MODE=$($deploymentMode.state.mode)"
  if ([string]$deploymentMode.state.mode -ne "PAUSE") {
    throw "Deployment gate requires bot mode PAUSE. actual=$($deploymentMode.state.mode)"
  }
  Write-Host 'PHASE7C_VERIFY_TRADE_NOTIFIER_DEPLOYMENT=PASS'
  Write-Host 'PHASE7C_VERIFY_DEPLOYMENT_GATE=PASS'
  Write-Host 'PHASE7C_VERIFY_STATUS=PASS'
  return
}

if ($AccountMode -eq "LIVE") {
  throw 'LIVE verification is intentionally limited to -DeploymentGate; the legacy deep verifier remains DEMO-only.'
}

$apiBase = $ControlApiUrl.TrimEnd('/')
$mode = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$lotSettings = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/lot-settings" -Method Get -TimeoutSec 5
$regime = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320" -Method Get -TimeoutSec 10
$decision = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/decision-monitor?symbol=XAUUSD" -Method Get -TimeoutSec 10
$mt5PanelPayload = Invoke-WebRequest -Uri "$apiBase/api/v1/phase7c/decision-monitor/mt5?symbol=XAUUSD" -UseBasicParsing -TimeoutSec 10
$verifyRiskPercent = ([double]$lotSettings.state.sidewayRiskPercent).ToString([System.Globalization.CultureInfo]::InvariantCulture)
$verifyMaxLot = ([double]$lotSettings.state.sidewayMaxLot).ToString([System.Globalization.CultureInfo]::InvariantCulture)
$autoLot = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/auto-lot-preview?stopDistance=5&riskPercent=$verifyRiskPercent&maxLot=$verifyMaxLot" -Method Get -TimeoutSec 10
Write-Host "PHASE7C_VERIFY_ACTIVE_MODE=$($mode.state.mode)"
Write-Host "PHASE7C_VERIFY_TREND_FIXED_LOT=$($lotSettings.state.trendFixedLot)"
Write-Host "PHASE7C_VERIFY_SIDEWAY_RISK_PERCENT=$($lotSettings.state.sidewayRiskPercent)"
Write-Host "PHASE7C_VERIFY_SIDEWAY_MAX_LOT=$($lotSettings.state.sidewayMaxLot)"
Write-Host "PHASE7C_VERIFY_LOT_ACTIVE_ALIVE=$($lotSettings.activeAlive)"
Write-Host "PHASE7C_VERIFY_LOT_RESTART_REQUIRED=$($lotSettings.restartRequired)"
Write-Host "PHASE7C_VERIFY_REGIME=$($regime.regime)"
Write-Host "PHASE7C_VERIFY_RECOMMENDED_MODE=$($regime.recommendedMode)"
Write-Host "PHASE7C_VERIFY_REGIME_CONFIDENCE=$($regime.confidence)"
Write-Host "PHASE7C_VERIFY_HAS_SUPPLY_DEMAND_RANGE=$($null -ne $regime.supplyDemandRange)"
Write-Host "PHASE7C_VERIFY_AUTO_LOT_APPROVED=$($autoLot.preview.approved)"
Write-Host "PHASE7C_VERIFY_AUTO_LOT_RECOMMENDED=$($autoLot.preview.recommendedLot)"
Write-Host "PHASE7C_VERIFY_DECISION_STRATEGY=$($decision.preTrade.strategy)"
Write-Host "PHASE7C_VERIFY_DECISION_STAGE=$($decision.preTrade.stage)"
Write-Host "PHASE7C_VERIFY_DECISION_FINAL_LOT=$($decision.preTrade.finalLot)"
Write-Host "PHASE7C_VERIFY_MT5_PANEL_ORDER_PERMISSION=$($decision.safety.mt5PanelOrderPermission)"
if ($decision.source -ne "PHASE7C_CANONICAL_DECISION_OBSERVABILITY") {
  throw "Phase 7C decision monitor source is invalid."
}
if ($decision.safety.mt5PanelOrderPermission -ne "NONE" -or $mt5PanelPayload.Content -notmatch '(?m)^mt5OrderPermission=NONE\r?$') {
  throw "Phase 7C MT5 decision panel read-only safety marker is missing."
}
if ($pidStatuses["supervisor"].alive -and $lotSettings.restartRequired) {
  throw "Supervisor is alive but its active lot settings do not match the saved configuration. PAUSE and reactivate Phase 7C."
}

$apiKey = Read-EnvValue "MT5_API_KEY"
$bridgeHost = Read-EnvValue "MT5_BRIDGE_HOST"
$bridgePort = Read-EnvValue "MT5_BRIDGE_PORT"
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "MT5_API_KEY is missing from EnvFile." }
if ([string]::IsNullOrWhiteSpace($bridgeHost)) { $bridgeHost = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($bridgePort)) { $bridgePort = "8765" }
$bridgeBase = "http://${bridgeHost}:${bridgePort}"
$headers = @{ "x-mt5-api-key" = $apiKey }
$health = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $headers -Method Get -TimeoutSec 5
if (-not $health.connected -or $health.status -ne "ok") { throw "MT5 bridge is not healthy/connected." }
if ($health.accountMode -ne "demo") { throw "Phase 7C verifier requires DEMO; current accountMode=$($health.accountMode)." }
$positionsResponse = Invoke-RestMethod -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $headers -Method Get -TimeoutSec 5
$positions = @($positionsResponse)
$spec = Invoke-RestMethod -Uri "$bridgeBase/v1/symbols/XAUUSD/spec" -Headers $headers -Method Get -TimeoutSec 5
Write-Host "PHASE7C_VERIFY_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7C_VERIFY_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7C_VERIFY_TRADING_ENABLED=$($health.tradingEnabled)"
Write-Host "PHASE7C_VERIFY_XAUUSD_POSITIONS=$($positions.Count)"
if ($positions.Count -gt 1) { throw "Phase 7C requires at most one XAUUSD position; broker currently has $($positions.Count)." }

if ($autoLot.safety.executionMutation -ne $false -or $autoLot.safety.phase7bFixedVolumeUnchanged -ne $true) {
  throw "Phase 7C Auto Lot safety assertion failed."
}
if ([string]$autoLot.account.mode -ne "demo") {
  throw "Phase 7C Auto Lot response is not tied to a DEMO account."
}
if ([long]$autoLot.account.login -ne [long]$health.accountLogin) {
  throw "Phase 7C Auto Lot account login $($autoLot.account.login) does not match MT5 $($health.accountLogin)."
}
if ([string]$autoLot.broker.symbol -ne [string]$spec.brokerSymbol) {
  throw "Phase 7C Auto Lot broker symbol $($autoLot.broker.symbol) does not match MT5 spec $($spec.brokerSymbol)."
}
$autoLotAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$autoLot.generatedAt
if ($autoLotAgeMs -lt -10000 -or $autoLotAgeMs -gt 30000) {
  throw "Phase 7C Auto Lot snapshot is stale/invalid. ageMs=$autoLotAgeMs"
}
Write-Host "PHASE7C_VERIFY_AUTO_LOT_ACCOUNT_LOGIN=$($autoLot.account.login)"
Write-Host "PHASE7C_VERIFY_AUTO_LOT_BROKER_SYMBOL=$($autoLot.broker.symbol)"
Write-Host "PHASE7C_VERIFY_AUTO_LOT_AGE_MS=$autoLotAgeMs"
Write-Host "PHASE7C_VERIFY_AUTO_LOT_SAFETY=PASS"

$trendState = Read-StateJson $TrendStatePath "Trend"
$sidewayState = Read-StateJson $SidewayStatePath "Sideway"
Assert-StateAccount $trendState "Trend" ([long]$health.accountLogin)
Assert-StateAccount $sidewayState "Sideway" ([long]$health.accountLogin)

$trendTicket = State-Ticket $trendState
$sidewayTicket = State-Ticket $sidewayState
$sidewayPending = if ($null -ne $sidewayState) { $sidewayState.pendingEntry } else { $null }
$pendingOrderId = if ($null -ne $sidewayPending) { [string]$sidewayPending.orderId } else { "" }

Write-Host "PHASE7C_VERIFY_TREND_MANAGED_TICKET=$(if ($trendTicket) { $trendTicket } else { 'NONE' })"
Write-Host "PHASE7C_VERIFY_SIDEWAY_MANAGED_TICKET=$(if ($sidewayTicket) { $sidewayTicket } else { 'NONE' })"
Write-Host "PHASE7C_VERIFY_SIDEWAY_PENDING_ORDER=$(if ($pendingOrderId) { $pendingOrderId } else { 'NONE' })"

if ($trendTicket -and $sidewayTicket) {
  throw "Ownership conflict: Trend and Sideway both have managed position state (Trend=$trendTicket Sideway=$sidewayTicket)."
}
if ($trendTicket -and $null -ne $sidewayPending) {
  throw "Ownership conflict: Trend has a managed ticket while Sideway has a durable pending entry."
}

$owner = "NONE"
if ($positions.Count -eq 1) {
  $position = $positions[0]
  $brokerTicket = [string]$position.ticket
  if ($trendTicket -eq $brokerTicket) {
    $owner = "TREND"
  } elseif ($sidewayTicket -eq $brokerTicket) {
    $owner = "SIDEWAY"
  } elseif ($null -ne $sidewayPending -and (Test-PendingMatchesPosition $sidewayPending $position $spec)) {
    $owner = "SIDEWAY_PENDING_RECOVERY"
  } else {
    throw "Orphan/unmanaged XAUUSD position $brokerTicket detected. Neither Trend nor Sideway state safely owns it."
  }
} elseif ($positions.Count -eq 0) {
  if ($trendTicket) {
    Write-Host "PHASE7C_VERIFY_TREND_STATE=STALE_MANAGED_TICKET_NO_BROKER_POSITION"
  }
  if ($sidewayTicket) {
    Write-Host "PHASE7C_VERIFY_SIDEWAY_STATE=STALE_MANAGED_TICKET_NO_BROKER_POSITION"
  }
  if ($null -ne $sidewayPending) {
    $pendingAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$sidewayPending.createdAt
    Write-Host "PHASE7C_VERIFY_SIDEWAY_PENDING_AGE_MS=$pendingAgeMs"
    if ($pendingAgeMs -gt 300000) {
      throw "Sideway durable pending entry is older than 5 minutes but no broker position exists. Run the Sideway controller recovery cycle before arming."
    }
  }
}
Write-Host "PHASE7C_VERIFY_POSITION_OWNER=$owner"

$lockPath = Join-Path $RuntimeDir "phase7c-execution.lock"
Write-Host "PHASE7C_VERIFY_EXECUTION_LOCK_PRESENT=$(Test-Path $lockPath)"
Write-Host "PHASE7C_VERIFY_OWNERSHIP=PASS"
if ($telegramConfigured) {
  $telegramStatus = if ($pidStatuses["telegram-mode"].alive -and $pidStatuses["regime-notifier"].alive -and $pidStatuses["trade-notifier"].alive -and $telegramModeReady -and $tradeNotifierReady) { "PASS" } else { "DEGRADED_NON_FATAL" }
  Write-Host "PHASE7C_VERIFY_TELEGRAM_STATUS=$telegramStatus"
} else {
  Write-Host "PHASE7C_VERIFY_TELEGRAM_STATUS=NOT_CONFIGURED"
}
Write-Host "PHASE7C_VERIFY_STATUS=PASS"
