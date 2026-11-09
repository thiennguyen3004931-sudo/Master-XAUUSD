param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [Parameter(Mandatory = $true)] [ValidateSet("DEMO", "LIVE")] [string]$ExpectedAccountMode,
  [string]$TaskName = "XAUUSD-Phase7C-Executors",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "",
  [string]$TelegramEnvFile = ".env.phase7b-telegram",
  [switch]$RequireTelegram,
  [switch]$AllowOwnedTaskProvenanceMigration,
  [string]$ExpectedRunnerSha256 = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$TaskOwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"

if (-not (Test-Path -LiteralPath $AccountLibrary)) {
  throw "Phase7C account-mode library not found: $AccountLibrary"
}

if (-not (Test-Path -LiteralPath $TaskOwnershipLibrary)) {
  throw "Phase7C Scheduled Task ownership library not found: $TaskOwnershipLibrary"
}

. $AccountLibrary
. $TaskOwnershipLibrary
$ExpectedAccountMode = ConvertTo-Phase7CAccountMode $ExpectedAccountMode
$ExpectedBrokerMode = if ($ExpectedAccountMode -eq "LIVE") { "real" } else { "demo" }
$expectedMigrationRunnerSha256 = ""
$trustedMigrationRunnerSha256 = ""
if ($AllowOwnedTaskProvenanceMigration) {
  if ($ExpectedAccountMode -ne "LIVE") {
    throw "Owned task provenance migration verification is LIVE-only."
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedRunnerSha256)) {
    throw "Owned task provenance migration verification requires ExpectedRunnerSha256."
  }
  $expectedMigrationRunnerSha256 = Normalize-Phase7CRunnerSha256 -Sha256 $ExpectedRunnerSha256
} elseif (-not [string]::IsNullOrWhiteSpace($ExpectedRunnerSha256)) {
  throw "ExpectedRunnerSha256 is only valid with AllowOwnedTaskProvenanceMigration."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path
$RuntimeDir = Join-Path $WorkDir "phase7c-executors"
$LifecycleBrokerRoot = Join-Path $WorkDir "phase7c-lifecycle-broker"
$LifecycleBrokerStateDir = Join-Path $LifecycleBrokerRoot "state"
$BrokerHeartbeatPath = Join-Path $LifecycleBrokerStateDir "heartbeat.json"
$BrokerStatusPath = Join-Path $LifecycleBrokerStateDir "status.json"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"
$TaskConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$RunnerLockPath = Join-Path $RuntimeDir "startup-runner.lock"

if (-not (Test-Path $AccountStatePath)) { throw "Account-mode state not found: $AccountStatePath" }
$accountState = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
if ([int]$accountState.version -ne 1) { throw "Account-mode state version must be 1." }
$stateMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
if ($stateMode -ne $ExpectedAccountMode) { throw "Account-mode state mismatch. Expected=$ExpectedAccountMode Actual=$stateMode" }
$liveEnabled = [bool]$accountState.liveExecutionEnabled
if ($ExpectedAccountMode -eq "DEMO" -and $liveEnabled) { throw "DEMO state cannot have liveExecutionEnabled=true." }
if ($ExpectedAccountMode -eq "LIVE" -and -not $liveEnabled) { throw "LIVE state requires liveExecutionEnabled=true." }

if ([string]::IsNullOrWhiteSpace($EnvFile)) { $EnvFile = [string]$accountState.envFile }
if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $ExpectedAccountMode -RequireTrading
$EnvFile = $envInfo.envFile
Write-Host "PHASE7C_ACCOUNT_VERIFY_EXPECTED_MODE=$ExpectedAccountMode"
Write-Host "PHASE7C_ACCOUNT_VERIFY_STATE=PASS"

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

$task = $null
$taskTopologyVerified = $false
$taskLookupClassification = "FOUND"
$migrationWindowAllowed = $false

try {
  $task = Get-ScheduledTask `
    -TaskName $TaskName `
    -ErrorAction Stop
}
catch {
  $taskLookupClassification = `
    Get-Phase7CScheduledTaskErrorClassification `
      -Exception $_.Exception

  if ($taskLookupClassification -ne "NOT_FOUND") {
    throw "Executor Scheduled Task lookup failed closed. Classification=$taskLookupClassification. $($_.Exception.Message)"
  }
}

Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_LOOKUP=$taskLookupClassification"

if ($null -ne $task) {
  $expectedRunnerPath = `
    Get-Phase7CExecutorTaskRunnerPath `
      -ProjectRoot $ProjectRoot

  if ($AllowOwnedTaskProvenanceMigration) {
    $trustedMigrationRunnerSha256 = Get-Phase7CTrustedGitFileSha256 `
      -ProjectRoot $ProjectRoot `
      -Path $expectedRunnerPath
    if (-not [string]::Equals(
      $expectedMigrationRunnerSha256,
      $trustedMigrationRunnerSha256,
      [System.StringComparison]::Ordinal
    )) {
      throw "Owned task provenance migration ExpectedRunnerSha256 does not match accepted Git HEAD bytes."
    }
    Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_MIGRATION_TRUSTED_GIT_SHA=PASS"
  }

  $ownership = if ($AllowOwnedTaskProvenanceMigration) {
    Test-Phase7CExecutorTaskActionOwnership `
      -Actions $task.Actions `
      -ExpectedRunnerPath $expectedRunnerPath `
      -ExpectedRunnerSha256 $trustedMigrationRunnerSha256
  } else {
    Test-Phase7CExecutorTaskActionOwnership `
      -Actions $task.Actions `
      -ExpectedRunnerPath $expectedRunnerPath
  }

  Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_STATE=$($task.State)"
  Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_OWNED=$($ownership.owned)"
  Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_OWNERSHIP_REASON=$($ownership.reason)"

  if (-not [bool]$ownership.owned) {
    throw "Executor Scheduled Task ownership verification failed. Reason=$($ownership.reason)"
  }

  if ($AllowOwnedTaskProvenanceMigration) {
    $migrationPrincipalValid = Test-Phase7CSystemTaskPrincipal $task.Principal
    $migrationWindowAllowed = [bool]$ownership.owned -and `
      [bool]$ownership.repairRequired -and `
      -not [bool]$ownership.canonical -and `
      $migrationPrincipalValid
    Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_MIGRATION_PRINCIPAL_VALID=$migrationPrincipalValid"
    Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_MIGRATION_REPAIR_REQUIRED=$($ownership.repairRequired)"
  }

  if ([string]$task.State -ne "Running") {
    throw "Executor Scheduled Task must be Running. Actual=$($task.State)"
  }

  $taskTopologyVerified = $true

  Write-Host "PHASE7C_ACCOUNT_VERIFY_EXECUTOR_TOPOLOGY=TASK"
}
else {
  Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_STATE=MISSING"
  Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_OWNED=False"
}

if ($AllowOwnedTaskProvenanceMigration -and -not $migrationWindowAllowed) {
  throw "Owned task provenance migration verification failed closed: task must be owned, repair-required, non-canonical, and SYSTEM + ServiceAccount + Highest."
}

if (-not (Test-Path $TaskConfigPath)) { throw "Executor task config not found: $TaskConfigPath" }
$taskConfig = Get-Content -LiteralPath $TaskConfigPath -Raw | ConvertFrom-Json
if ([int]$taskConfig.version -ne 2) { throw "Dual-account runtime requires executor task config version 2." }
if ((ConvertTo-Phase7CAccountMode ([string]$taskConfig.accountMode)) -ne $ExpectedAccountMode) { throw "Executor task config accountMode mismatch." }
if ([bool]$taskConfig.armed -ne $true) { throw "Executor task config must remain armed=true." }
if ($ExpectedAccountMode -eq "LIVE" -and -not [bool]$taskConfig.liveExecutionEnabled) { throw "LIVE executor task config is not explicitly enabled." }
if ($ExpectedAccountMode -eq "DEMO" -and [bool]$taskConfig.liveExecutionEnabled) { throw "DEMO executor task config cannot have LIVE enabled." }
foreach ($toolPath in @([string]$taskConfig.nodePath, [string]$taskConfig.pnpmPath)) {
  if ([string]::IsNullOrWhiteSpace($toolPath) -or -not (Test-Path -LiteralPath $toolPath -PathType Leaf)) {
    throw "Executor task tool path is missing or invalid: $toolPath"
  }
}

function Read-PidStatus([string]$Name) {
  $path = Join-Path $RuntimeDir "$Name.pid"
  if (-not (Test-Path $path)) { return [pscustomobject]@{ pid = $null; alive = $false } }
  try {
    $pidValue = [int](Get-Content -LiteralPath $path -Raw).Trim()
    return [pscustomobject]@{ pid = $pidValue; alive = $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) }
  } catch { return [pscustomobject]@{ pid = $null; alive = $false } }
}
$pidStatuses = @{}
foreach ($name in @("supervisor", "trend", "sideway", "telegram-mode", "regime-notifier")) {
  $status = Read-PidStatus $name
  $pidStatuses[$name] = $status
  $label = $name.ToUpper().Replace("-", "_")
  Write-Host "PHASE7C_ACCOUNT_VERIFY_${label}_PID=$($status.pid)"
  Write-Host "PHASE7C_ACCOUNT_VERIFY_${label}_ALIVE=$($status.alive)"
}
foreach ($required in @("supervisor", "trend", "sideway")) {
  if (-not $pidStatuses[$required].alive) { throw "Required Phase7C process is not alive: $required" }
}

foreach ($brokerStatePath in @($BrokerHeartbeatPath, $BrokerStatusPath)) {
  if (-not (Test-Path -LiteralPath $brokerStatePath)) {
    throw "Lifecycle broker state file not found: $brokerStatePath"
  }
}
$brokerHeartbeat = Get-Content -LiteralPath $BrokerHeartbeatPath -Raw | ConvertFrom-Json
$brokerStatus = Get-Content -LiteralPath $BrokerStatusPath -Raw | ConvertFrom-Json
if ([int]$brokerHeartbeat.version -ne 1) { throw "Lifecycle broker heartbeat version must be 1." }
if ([int]$brokerStatus.version -ne 1) { throw "Lifecycle broker status version must be 1." }

$brokerPid = [int]$brokerHeartbeat.brokerPid
$statusBrokerPid = [int]$brokerStatus.brokerPid
if ($brokerPid -le 0 -or $statusBrokerPid -le 0 -or $brokerPid -ne $statusBrokerPid) {
  throw "Lifecycle broker PID identity mismatch. Heartbeat=$brokerPid Status=$statusBrokerPid"
}
if ($null -eq (Get-Process -Id $brokerPid -ErrorAction SilentlyContinue)) {
  throw "Lifecycle broker PID is not alive. PID=$brokerPid"
}

$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$brokerHeartbeatAgeMs = $nowMs - [long]$brokerHeartbeat.updatedAt
if ($brokerHeartbeatAgeMs -lt -10000 -or $brokerHeartbeatAgeMs -gt 10000) {
  throw "Lifecycle broker heartbeat is stale. ageMs=$brokerHeartbeatAgeMs"
}
$statusUpdatedAt = [long]$brokerStatus.updatedAt
if ($statusUpdatedAt -le 0 -or $statusUpdatedAt -gt ($nowMs + 10000)) {
  throw "Lifecycle broker status timestamp is invalid. updatedAt=$statusUpdatedAt"
}

$heartbeatState = ([string]$brokerHeartbeat.state).Trim().ToUpperInvariant()
$statusState = ([string]$brokerStatus.state).Trim().ToUpperInvariant()
$heartbeatDesired = ([string]$brokerHeartbeat.desiredExecutorState).Trim().ToUpperInvariant()
$statusDesired = ([string]$brokerStatus.desiredExecutorState).Trim().ToUpperInvariant()
if ($heartbeatState -ne "RUNNING" -or $statusState -ne "RUNNING") {
  throw "Lifecycle broker is not in RUNNING state. Heartbeat=$heartbeatState Status=$statusState"
}
if ($heartbeatDesired -ne "RUNNING" -or $statusDesired -ne "RUNNING") {
  throw "Lifecycle broker desiredExecutorState is not RUNNING. Heartbeat=$heartbeatDesired Status=$statusDesired"
}
if ((ConvertTo-Phase7CAccountMode ([string]$brokerStatus.accountMode)) -ne $ExpectedAccountMode) {
  throw "Lifecycle broker accountMode mismatch. Expected=$ExpectedAccountMode Actual=$($brokerStatus.accountMode)"
}

$actualSupervisorPid = [int]$pidStatuses["supervisor"].pid
$brokerStatusSupervisorPid = [int]$brokerStatus.supervisorPid
$brokerSupervisorMatch = `
  $brokerStatusSupervisorPid -gt 0 -and
  $brokerStatusSupervisorPid -eq $actualSupervisorPid
if (-not $brokerSupervisorMatch) {
  throw "Lifecycle broker supervisor PID does not match the active supervisor PID. Broker=$brokerStatusSupervisorPid Actual=$actualSupervisorPid"
}

Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_PID=$brokerPid"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_HEARTBEAT_AGE_MS=$brokerHeartbeatAgeMs"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_STATE=$statusState"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_DESIRED_EXECUTOR_STATE=$statusDesired"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_ACCOUNT_MODE=$($brokerStatus.accountMode)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_SUPERVISOR_PID=$brokerStatusSupervisorPid"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_SUPERVISOR_MATCH=$brokerSupervisorMatch"

# Keep the historic variable/output names for downstream diagnostics while the
# canonical identity now comes from lifecycle-broker heartbeat/status.
$runnerPid = $brokerPid

$probe = $null
$lockHeld = $false
try {
  $probe = [System.IO.File]::Open($RunnerLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] { $lockHeld = $true }
finally { if ($null -ne $probe) { $probe.Dispose() } }
Write-Host "PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_LOCK_HELD=$lockHeld"
if (-not $lockHeld -and $migrationWindowAllowed) {
  Write-Host "PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_LOCK_MIGRATION_WINDOW=ALLOWED_OWNED_REPAIR_REQUIRED"
}
if (-not $lockHeld -and -not $migrationWindowAllowed) {
  throw "SYSTEM lifecycle broker singleton lock is not held."
}

$runnerProcess = Get-CimInstance `
  Win32_Process `
  -Filter "ProcessId = $runnerPid" `
  -ErrorAction Stop

if ($null -eq $runnerProcess) {
  throw "SYSTEM lifecycle broker process metadata is unavailable."
}

$runnerProcessName = [string]$runnerProcess.Name
$runnerIsWindowsPowerShell = `
  $runnerProcessName.Equals(
    "powershell.exe",
    [System.StringComparison]::OrdinalIgnoreCase
  )

Write-Host "PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_PROCESS_NAME=$runnerProcessName"
Write-Host "PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_IS_POWERSHELL=$runnerIsWindowsPowerShell"

if (-not $runnerIsWindowsPowerShell) {
  throw "SYSTEM lifecycle broker process is not Windows PowerShell."
}

$runnerParentPid = [int]$runnerProcess.ParentProcessId

if ($runnerParentPid -le 0) {
  throw "SYSTEM lifecycle broker parent PID is invalid."
}

$scheduleService = Get-CimInstance `
  Win32_Service `
  -Filter "Name = 'Schedule'" `
  -ErrorAction Stop

if ($null -eq $scheduleService) {
  throw "Windows Task Scheduler service metadata is unavailable."
}

$scheduleServicePid = [int]$scheduleService.ProcessId
$scheduleServiceRunning = `
  [string]$scheduleService.State -eq "Running"

$runnerParentIsSchedule = `
  $scheduleServiceRunning -and
  $scheduleServicePid -gt 0 -and
  $runnerParentPid -eq $scheduleServicePid

Write-Host "PHASE7C_ACCOUNT_VERIFY_SCHEDULE_SERVICE_PID=$scheduleServicePid"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SCHEDULE_SERVICE_RUNNING=$scheduleServiceRunning"
Write-Host "PHASE7C_ACCOUNT_VERIFY_RUNNER_PARENT_PID=$runnerParentPid"
Write-Host "PHASE7C_ACCOUNT_VERIFY_RUNNER_PARENT_IS_SCHEDULE=$runnerParentIsSchedule"

if (-not $runnerParentIsSchedule) {
  throw "SYSTEM lifecycle broker is not directly owned by the running Windows Task Scheduler service."
}

$supervisorProcess = Get-CimInstance `
  Win32_Process `
  -Filter "ProcessId = $actualSupervisorPid" `
  -ErrorAction Stop

if ($null -eq $supervisorProcess) {
  throw "Supervisor process metadata is unavailable."
}

$supervisorProcessName = [string]$supervisorProcess.Name
$supervisorIsPowerShell = `
  $supervisorProcessName.Equals(
    "powershell.exe",
    [System.StringComparison]::OrdinalIgnoreCase
  )

$supervisorParentIsRunner = `
  [int]$supervisorProcess.ParentProcessId -eq $runnerPid

Write-Host "PHASE7C_ACCOUNT_VERIFY_SUPERVISOR_PROCESS_NAME=$supervisorProcessName"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SUPERVISOR_IS_POWERSHELL=$supervisorIsPowerShell"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SUPERVISOR_PARENT_IS_RUNNER=$supervisorParentIsRunner"

if (-not $supervisorIsPowerShell) {
  throw "Supervisor process is not Windows PowerShell."
}

if (-not $supervisorParentIsRunner) {
  throw "Supervisor is not a direct child of the verified SYSTEM lifecycle broker."
}

# Some Windows/WMI configurations return an empty CommandLine for processes
# launched by Task Scheduler. Use it as an additional assertion only when the
# provider exposes it; never make an empty provider field the sole identity gate.
$supervisorCommandLine = [string]$supervisorProcess.CommandLine

if (-not [string]::IsNullOrWhiteSpace($supervisorCommandLine)) {
  $supervisorCommandTrusted = `
    $supervisorCommandLine -like "*run-phase7c-executors-local.ps1*" -and
    $supervisorCommandLine -like "*-AccountMode $ExpectedAccountMode*"

  if ($ExpectedAccountMode -eq "LIVE") {
    $supervisorCommandTrusted = `
      $supervisorCommandTrusted -and
      $supervisorCommandLine -like "*-LiveExecutionEnabled*"
  }

  Write-Host "PHASE7C_ACCOUNT_VERIFY_SUPERVISOR_COMMAND_TRUSTED=$supervisorCommandTrusted"

  if (-not $supervisorCommandTrusted) {
    throw "Supervisor command line is available but does not match the selected runtime contract."
  }
}
else {
  Write-Host "PHASE7C_ACCOUNT_VERIFY_SUPERVISOR_COMMAND_TRUSTED=PROVIDER_UNAVAILABLE"
}

if (-not $taskTopologyVerified) {
  Write-Host "PHASE7C_ACCOUNT_VERIFY_EXECUTOR_TOPOLOGY=STARTUP_RUNNER"
  Write-Host "PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_IDENTITY=TOPOLOGY_PROOF"
  Write-Host "PHASE7C_ACCOUNT_VERIFY_TASK_FALLBACK=PASS"
}

$telegramConfigured = $false
if (-not [System.IO.Path]::IsPathRooted($TelegramEnvFile)) { $TelegramEnvFile = Join-Path $ProjectRoot $TelegramEnvFile }
if (Test-Path $TelegramEnvFile) {
  $token = Get-Phase7CEnvValue $TelegramEnvFile "ZIQ_TELEGRAM_BOT_TOKEN"
  $chat = Get-Phase7CEnvValue $TelegramEnvFile "ZIQ_TELEGRAM_CHAT_ID"
  $telegramConfigured = -not [string]::IsNullOrWhiteSpace($token) -and -not [string]::IsNullOrWhiteSpace($chat)
}
$telegramReady = $false
$telegramStatusPath = Join-Path $RuntimeDir "telegram-mode-status.json"
if ($telegramConfigured -and (Test-Path $telegramStatusPath)) {
  try {
    $telegramRuntime = Get-Content -LiteralPath $telegramStatusPath -Raw | ConvertFrom-Json
    $lastTelegramSuccessAt = $telegramRuntime.lastTelegramSuccessAt
    Write-Host "PHASE7C_ACCOUNT_VERIFY_TELEGRAM_RUNTIME_STATUS=$($telegramRuntime.status)"
    if ($null -ne $lastTelegramSuccessAt -and [long]$lastTelegramSuccessAt -gt 0) {
      $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$lastTelegramSuccessAt
      $telegramReady = [bool]$telegramRuntime.ready -and [string]$telegramRuntime.status -eq "READY" -and $age -ge -10000 -and $age -le 60000
      Write-Host "PHASE7C_ACCOUNT_VERIFY_TELEGRAM_HEARTBEAT_AGE_MS=$age"
    } else {
      Write-Host "PHASE7C_ACCOUNT_VERIFY_TELEGRAM_HEARTBEAT_AGE_MS=NO_SUCCESS_YET"
    }
  } catch { $telegramReady = $false }
}
Write-Host "PHASE7C_ACCOUNT_VERIFY_TELEGRAM_CONFIGURED=$telegramConfigured"
Write-Host "PHASE7C_ACCOUNT_VERIFY_TELEGRAM_READY=$telegramReady"
if ($RequireTelegram -and (-not $telegramConfigured -or -not $pidStatuses["telegram-mode"].alive -or -not $pidStatuses["regime-notifier"].alive -or -not $telegramReady)) {
  throw "Telegram verification failed or is not ready/fresh."
}

$apiBase = $ControlApiUrl.TrimEnd('/')
$mode = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$lotSettings = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/lot-settings" -Method Get -TimeoutSec 5
$regime = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320" -Method Get -TimeoutSec 10
$decision = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/decision-monitor?symbol=XAUUSD" -Method Get -TimeoutSec 10
$mt5Panel = Invoke-WebRequest -Uri "$apiBase/api/v1/phase7c/decision-monitor/mt5?symbol=XAUUSD" -UseBasicParsing -TimeoutSec 10
$riskPercent = ([double]$lotSettings.state.sidewayRiskPercent).ToString([System.Globalization.CultureInfo]::InvariantCulture)
$maxLot = ([double]$lotSettings.state.sidewayMaxLot).ToString([System.Globalization.CultureInfo]::InvariantCulture)
$autoLot = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/auto-lot-preview?stopDistance=5&riskPercent=$riskPercent&maxLot=$maxLot" -Method Get -TimeoutSec 10
Write-Host "PHASE7C_ACCOUNT_VERIFY_ACTIVE_MODE=$($mode.state.mode)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_TREND_FIXED_LOT=$($lotSettings.state.trendFixedLot)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SIDEWAY_RISK_PERCENT=$($lotSettings.state.sidewayRiskPercent)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SIDEWAY_MAX_LOT=$($lotSettings.state.sidewayMaxLot)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_REGIME=$($regime.regime)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_DECISION_STRATEGY=$($decision.preTrade.strategy)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_DECISION_STAGE=$($decision.preTrade.stage)"
if ($decision.source -ne "PHASE7C_CANONICAL_DECISION_OBSERVABILITY") { throw "Decision monitor source is invalid." }
if ($decision.safety.mt5PanelOrderPermission -ne "NONE" -or $mt5Panel.Content -notmatch '(?m)^mt5OrderPermission=NONE\r?$') { throw "MT5 decision panel read-only safety marker is missing." }
$expectedDemoOnly = $ExpectedAccountMode -eq "DEMO"
if ([bool]$decision.safety.demoOnly -ne $expectedDemoOnly) { throw "Decision monitor demoOnly marker does not match account mode." }
if ([string]$decision.account.accountMode -ne $ExpectedBrokerMode) { throw "Decision monitor account mode does not match target." }

$headers = @{ "x-mt5-api-key" = $envInfo.apiKey }
$bridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$health = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $headers -Method Get -TimeoutSec 5
if (-not $health.connected -or $health.status -ne "ok") { throw "MT5 bridge is not healthy/connected." }
if ([string]$health.accountMode -ne $ExpectedBrokerMode) { throw "Broker account mode mismatch. Expected=$ExpectedBrokerMode Actual=$($health.accountMode)" }
if (-not [bool]$health.tradingEnabled) { throw "MT5 bridge trading is disabled." }
$login = [long]$health.accountLogin
if ($envInfo.allowedLogins -notcontains $login) { throw "Connected MT5 login is not in the selected account allowlist." }
$positionResponse = Invoke-WebRequest -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $headers -UseBasicParsing -TimeoutSec 5
$positionRaw = ([string]$positionResponse.Content).Trim()
if ([string]::IsNullOrWhiteSpace($positionRaw) -or $positionRaw -eq "[]") {
  $positions = @()
} else {
  $positionParsed = $positionRaw | ConvertFrom-Json
  $positions = @($positionParsed | Where-Object { $null -ne $_ })
}
$spec = Invoke-RestMethod -Uri "$bridgeBase/v1/symbols/XAUUSD/spec" -Headers $headers -Method Get -TimeoutSec 5
Write-Host "PHASE7C_ACCOUNT_VERIFY_BROKER_MODE=$($health.accountMode)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_TRADING_ENABLED=$($health.tradingEnabled)"
Write-Host "PHASE7C_ACCOUNT_VERIFY_LOGIN_ALLOWLIST=PASS"
Write-Host "PHASE7C_ACCOUNT_VERIFY_XAUUSD_POSITIONS=$($positions.Count)"
if ($positions.Count -gt 1) { throw "Phase7C requires at most one XAUUSD position." }

if ([string]$autoLot.account.mode -ne $ExpectedBrokerMode) { throw "Auto Lot preview account mode does not match target." }
if ([string]$autoLot.broker.symbol -ne [string]$spec.brokerSymbol) { throw "Auto Lot broker symbol mismatch." }
if ([bool]$autoLot.safety.executionMutation -ne $false) { throw "Auto Lot preview must remain read-only." }
$autoAge = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$autoLot.generatedAt
if ($autoAge -lt -10000 -or $autoAge -gt 30000) { throw "Auto Lot preview is stale." }
Write-Host "PHASE7C_ACCOUNT_VERIFY_AUTO_LOT_SAFETY=PASS"

if ($ExpectedAccountMode -eq "LIVE") {
  $TrendStatePath = Join-Path $WorkDir "phase7b-live-forward\phase7b-demo-state.json"
  $SidewayStatePath = Join-Path $WorkDir "phase7c-sideway-live-forward\phase7c-sideway-state.json"
} else {
  $TrendStatePath = Join-Path $WorkDir "phase7b-demo-forward\phase7b-demo-state.json"
  $SidewayStatePath = Join-Path $WorkDir "phase7c-sideway-forward\phase7c-sideway-state.json"
}
function Read-State([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}
function State-Ticket($State) {
  if ($null -eq $State -or $null -eq $State.managed -or [string]::IsNullOrWhiteSpace([string]$State.managed.ticket)) { return "" }
  return [string]$State.managed.ticket
}
$trendState = Read-State $TrendStatePath
$sidewayState = Read-State $SidewayStatePath
foreach ($item in @([pscustomobject]@{ state = $trendState; label = "Trend" }, [pscustomobject]@{ state = $sidewayState; label = "Sideway" })) {
  if ($null -ne $item.state -and $null -ne $item.state.accountLogin -and [long]$item.state.accountLogin -gt 0 -and [long]$item.state.accountLogin -ne $login) {
    throw "$($item.label) runtime state belongs to another MT5 account."
  }
}
$trendTicket = State-Ticket $trendState
$sidewayTicket = State-Ticket $sidewayState
$sidewayPending = if ($null -ne $sidewayState) { $sidewayState.pendingEntry } else { $null }
Write-Host "PHASE7C_ACCOUNT_VERIFY_TREND_MANAGED_TICKET=$(if ($trendTicket) { $trendTicket } else { 'NONE' })"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SIDEWAY_MANAGED_TICKET=$(if ($sidewayTicket) { $sidewayTicket } else { 'NONE' })"
Write-Host "PHASE7C_ACCOUNT_VERIFY_SIDEWAY_PENDING_ORDER=$(if ($null -ne $sidewayPending) { [string]$sidewayPending.orderId } else { 'NONE' })"
if ($trendTicket -and $sidewayTicket) { throw "Trend and Sideway both claim managed position state." }
if ($trendTicket -and $null -ne $sidewayPending) { throw "Trend managed state conflicts with Sideway pending entry." }

if ($positions.Count -eq 0 -and ($trendTicket -or $sidewayTicket -or $null -ne $sidewayPending)) {
  throw "Runtime state is not flat while broker has zero positions; reconcile before switching/arming."
}
if ($positions.Count -eq 1) {
  $brokerTicket = [string]$positions[0].ticket
  if ($brokerTicket -ne $trendTicket -and $brokerTicket -ne $sidewayTicket) {
    throw "Open XAUUSD position is not safely owned by the selected account runtime state."
  }
}
$executionLock = Test-Path (Join-Path $RuntimeDir "phase7c-execution.lock")
Write-Host "PHASE7C_ACCOUNT_VERIFY_EXECUTION_LOCK_PRESENT=$executionLock"
Write-Host "PHASE7C_ACCOUNT_VERIFY_OWNERSHIP=PASS"
Write-Host "PHASE7C_ACCOUNT_VERIFY_STATUS=PASS"
