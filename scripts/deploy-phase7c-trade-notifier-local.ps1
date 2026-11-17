param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("DEMO", "LIVE")]
  [string]$AccountMode,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExpectedCommit,
  [string]$TaskName = "XAUUSD-Phase7C-Executors",
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$TaskOwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"

foreach ($required in @($ConfigPath, $AccountLibrary, $TaskOwnershipLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Phase 7C trade notifier deploy required file not found: $required"
  }
}
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) {
  throw "TimeoutSeconds must be between 30 and 600."
}
if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw "ExpectedCommit must be an exact 40-character Git SHA."
}

. $AccountLibrary
. $TaskOwnershipLibrary
$AccountMode = ConvertTo-Phase7CAccountMode $AccountMode
$ExpectedCommit = $ExpectedCommit.ToLowerInvariant()

function Assert-Phase7CDeployAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ADMIN=REQUIRED"
    throw "Run deploy-phase7c-trade-notifier-local.ps1 from PowerShell Administrator."
  }
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ADMIN=PASS"
}

function Resolve-Phase7CConfigPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Get-LiveProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
}

function Read-RequiredPid([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label PID file is missing: $Path"
  }
  try {
    $pidValue = [int](Get-Content -LiteralPath $Path -Raw).Trim()
  } catch {
    throw "$Label PID file is invalid: $Path"
  }
  if ($pidValue -le 0 -or $null -eq (Get-LiveProcess $pidValue)) {
    throw "$Label process is not alive. pid=$pidValue"
  }
  return $pidValue
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing: $Path"
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "$Label file is invalid: $Path. $($_.Exception.Message)"
  }
}

function Test-SamePath([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    $leftFull = [System.IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $rightFull = [System.IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
    return [string]::Equals($leftFull, $rightFull, [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Assert-InvariantPid([string]$Path, [string]$Label, [int]$ExpectedPid, [string]$Marker) {
  $actualPid = Read-RequiredPid -Path $Path -Label $Label
  if ($actualPid -ne $ExpectedPid) {
    throw "$Label PID changed during notifier-only deploy. before=$ExpectedPid after=$actualPid"
  }
  Write-Host "$Marker=PASS"
}

function Get-Phase7CTradeNotifierProcesses {
  $wrapperScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-local.ps1"))
  $nodeScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "run-phase7b-telegram-notifier.mjs"))
  return @(
    Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
        $commandLine = [string]$_.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { return $false }
        return (
          $commandLine.IndexOf($wrapperScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $commandLine.IndexOf($nodeScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        )
      } |
      Sort-Object ProcessId -Unique
  )
}

function Stop-Phase7CTradeNotifierProcesses {
  param(
    [Parameter(Mandatory = $true)] [object[]]$Processes,
    [Parameter(Mandatory = $true)] [string]$TaskkillExe
  )
  foreach ($processInfo in @($Processes | Sort-Object ProcessId -Descending)) {
    $processId = [int]$processInfo.ProcessId
    if ($processId -le 0 -or $processId -eq $PID) { continue }
    if ($null -eq (Get-LiveProcess $processId)) { continue }
    Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_PROCESS_STOP=$processId"
    & $TaskkillExe /PID $processId /T /F | Out-Host
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    if ([int]$exitCode -ne 0 -and $null -ne (Get-LiveProcess $processId)) {
      throw "Failed to terminate degraded trade notifier process tree. pid=$processId exitCode=$exitCode"
    }
  }
}

Assert-Phase7CDeployAdministrator

$gitCommand = Get-Command git -ErrorAction Stop
$gitExe = $gitCommand.Source
Push-Location $ProjectRoot
try {
  $currentBranch = [string](& $gitExe branch --show-current)
  if ($LASTEXITCODE -ne 0) { throw "git branch --show-current failed with exit code $LASTEXITCODE" }
  $currentBranch = $currentBranch.Trim()
  if ($currentBranch -ne "main") {
    throw "Trade notifier deploy requires branch main. actual=$currentBranch"
  }

  $workingTreeLines = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "git status --porcelain failed with exit code $LASTEXITCODE" }
  if ($workingTreeLines.Count -ne 0) {
    throw "Trade notifier deploy requires a clean working tree."
  }

  $actualCommit = [string](& $gitExe rev-parse HEAD)
  if ($LASTEXITCODE -ne 0) { throw "git rev-parse HEAD failed with exit code $LASTEXITCODE" }
  $actualCommit = $actualCommit.Trim().ToLowerInvariant()
  if ($actualCommit -ne $ExpectedCommit) {
    throw "Trade notifier deploy exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
} finally {
  Pop-Location
}
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_EXPECTED_COMMIT=$ExpectedCommit"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_GIT_GUARD=PASS"

Import-Module ScheduledTasks -ErrorAction Stop
$config = Read-JsonFile -Path $ConfigPath -Label "Executor task config"
$configVersion = [int]$config.version
if ($configVersion -notin @(1, 2)) {
  throw "Unsupported executor task config version: $configVersion"
}
if (-not [bool]$config.armed) {
  throw "Trade notifier hot reload requires executor task config armed=true."
}

$configAccountMode = "DEMO"
if ($configVersion -eq 1) {
  if (-not [bool]$config.demoOnly) { throw "Legacy v1 executor task config must remain demoOnly=true." }
} else {
  $configAccountMode = ConvertTo-Phase7CAccountMode ([string]$config.accountMode)
  if ($configAccountMode -eq "LIVE") {
    if ($null -eq $config.PSObject.Properties["liveExecutionEnabled"] -or -not [bool]$config.liveExecutionEnabled) {
      throw "LIVE executor task config requires liveExecutionEnabled=true."
    }
    if ($null -ne $config.PSObject.Properties["demoOnly"] -and [bool]$config.demoOnly) {
      throw "LIVE executor task config must set demoOnly=false."
    }
  }
}
if ($configAccountMode -ne $AccountMode) {
  throw "Deploy account mode does not match executor task config. requested=$AccountMode config=$configAccountMode"
}

$WorkDir = Resolve-Phase7CConfigPath ([string]$config.workDir)
$EnvFile = Resolve-Phase7CConfigPath ([string]$config.envFile)
$TelegramEnvFile = Resolve-Phase7CConfigPath ([string]$config.telegramEnvFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) { throw "Executor task controlApiUrl is missing." }
foreach ($requiredPath in @($WorkDir, $EnvFile, $TelegramEnvFile)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Configured deploy path not found: $requiredPath" }
}

$RuntimeDir = Join-Path $WorkDir "phase7c-executors"
$SupervisorPidPath = Join-Path $RuntimeDir "supervisor.pid"
$TrendPidPath = Join-Path $RuntimeDir "trend.pid"
$SidewayPidPath = Join-Path $RuntimeDir "sideway.pid"
$TelegramModePidPath = Join-Path $RuntimeDir "telegram-mode.pid"
$RegimeNotifierPidPath = Join-Path $RuntimeDir "regime-notifier.pid"
$TradeNotifierPidPath = Join-Path $RuntimeDir "trade-notifier.pid"
$TradeNotifierRuntimePath = Join-Path $RuntimeDir "trade-notifier-runtime.json"
$ActiveLotSettingsPath = Join-Path $RuntimeDir "active-lot-settings.json"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$expectedRunnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $expectedRunnerPath
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_TASK_OWNERSHIP=$($ownership.reason)"
if (-not $ownership.owned) {
  throw "Scheduled Task ownership cannot be proven. reason=$($ownership.reason)"
}
$taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
if ($taskDrift.Count -ne 0) {
  throw "Scheduled Task has canonical drift: $($taskDrift -join ',')"
}
if ([string]$task.State -ne "Running") {
  throw "Scheduled Task must already be Running; direct task mutation is intentionally not used. state=$($task.State)"
}

$modeBeforeResponse = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$modeBefore = [string]$modeBeforeResponse.state.mode
if ([string]::IsNullOrWhiteSpace($modeBefore)) { throw "Bot mode response is missing state.mode." }
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_MODE_BEFORE=$modeBefore"

$liveArmBridgeSessionBefore = ""
if ($AccountMode -eq "LIVE") {
  $liveArmCapabilityBefore = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c-live-arm-control/capability" -Method Get -TimeoutSec 5
  if ([string]$liveArmCapabilityBefore.accountMode -ne "LIVE") {
    throw "Canonical LIVE ARM capability account mismatch. actual=$($liveArmCapabilityBefore.accountMode)"
  }
  if ([string]$liveArmCapabilityBefore.liveArmStatus -ne "ARMED" -or [bool]$liveArmCapabilityBefore.liveExecutionArmed -ne $true) {
    throw "Trade notifier LIVE hot reload requires canonical ARM=ARMED. status=$($liveArmCapabilityBefore.liveArmStatus) armed=$($liveArmCapabilityBefore.liveExecutionArmed)"
  }
  $liveArmBridgeSessionBefore = [string]$liveArmCapabilityBefore.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($liveArmBridgeSessionBefore)) {
    throw "Canonical LIVE ARM capability is missing bridgeSessionId."
  }
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_LIVE_ARM_BEFORE=ARMED"
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_BRIDGE_SESSION_BEFORE=$liveArmBridgeSessionBefore"
}

$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $AccountMode -RequireTrading
$bridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$headers = @{ "x-mt5-api-key" = $envInfo.apiKey }
$health = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $headers -Method Get -TimeoutSec 5
$expectedBridgeMode = if ($AccountMode -eq "LIVE") { "real" } else { "demo" }
if (-not [bool]$health.connected -or [string]$health.status -ne "ok" -or [string]$health.accountMode -ne $expectedBridgeMode) {
  throw "MT5 bridge is not healthy for $AccountMode deploy. connected=$($health.connected) status=$($health.status) mode=$($health.accountMode) expected=$expectedBridgeMode"
}
$positionsResponse = Invoke-RestMethod -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $headers -Method Get -TimeoutSec 5
$positions = @($positionsResponse)
if ($positions.Count -ne 0) {
  throw "Trade notifier hot reload requires zero XAUUSD positions. current=$($positions.Count)"
}
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_XAUUSD_POSITIONS=0"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ORDER_ACTION=NONE"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_TELEGRAM_TEST=NONE"

$oldSupervisorPid = Read-RequiredPid -Path $SupervisorPidPath -Label "Supervisor"
$oldTrendPid = Read-RequiredPid -Path $TrendPidPath -Label "Trend"
$oldSidewayPid = Read-RequiredPid -Path $SidewayPidPath -Label "Sideway"
$oldTelegramModePid = Read-RequiredPid -Path $TelegramModePidPath -Label "Telegram mode"
$oldRegimeNotifierPid = Read-RequiredPid -Path $RegimeNotifierPidPath -Label "Regime notifier"

$activeBefore = Read-JsonFile -Path $ActiveLotSettingsPath -Label "Active lot settings"
$armedBefore = [bool]$activeBefore.armed
if (-not $armedBefore) { throw "Active executor settings are not armed; refusing hot reload." }
if ([string]$activeBefore.accountMode -ne $AccountMode) {
  throw "Active executor account mode mismatch. expected=$AccountMode actual=$($activeBefore.accountMode)"
}
if ([int]$activeBefore.supervisorPid -ne $oldSupervisorPid) {
  throw "Active executor supervisor PID does not match supervisor.pid. active=$($activeBefore.supervisorPid) pidFile=$oldSupervisorPid"
}
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ARMED_BEFORE=$armedBefore"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_SUPERVISOR_PID=$oldSupervisorPid"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_TREND_PID=$oldTrendPid"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_SIDEWAY_PID=$oldSidewayPid"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_TELEGRAM_MODE_PID=$oldTelegramModePid"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_REGIME_NOTIFIER_PID=$oldRegimeNotifierPid"

$taskkillExe = Join-Path $env:SystemRoot "System32\taskkill.exe"
if (-not (Test-Path -LiteralPath $taskkillExe -PathType Leaf)) { throw "taskkill.exe not found: $taskkillExe" }

$degradedRuntime = $false
$oldTradeNotifierPid = 0
try {
  $oldTradeNotifierPid = Read-RequiredPid -Path $TradeNotifierPidPath -Label "Trade notifier"
} catch {
  $degradedRuntime = $true
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_RUNTIME=DETECTED"
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_RUNTIME_REASON=$($_.Exception.Message)"
}

$expectedTrendDir = if ($AccountMode -eq "LIVE") { Join-Path $WorkDir "phase7b-live-forward" } else { Join-Path $WorkDir "phase7b-demo-forward" }
$expectedSidewayDir = if ($AccountMode -eq "LIVE") { Join-Path $WorkDir "phase7c-sideway-live-forward" } else { Join-Path $WorkDir "phase7c-sideway-forward" }
$expectedTrendJournal = Join-Path $expectedTrendDir "phase7b-demo-events.jsonl"
$expectedSidewayJournal = Join-Path $expectedSidewayDir "phase7c-sideway-events.jsonl"

if (-not $degradedRuntime) {
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_OLD_TRADE_NOTIFIER_PID=$oldTradeNotifierPid"
  $oldRuntime = Read-JsonFile -Path $TradeNotifierRuntimePath -Label "Trade notifier runtime"
  if ([string]$oldRuntime.status -ne "RUNNING" -or [string]$oldRuntime.accountMode -ne $AccountMode -or [string]$oldRuntime.orderPermission -ne "NONE") {
    throw "Existing trade notifier is not a healthy read-only $AccountMode runtime. status=$($oldRuntime.status) accountMode=$($oldRuntime.accountMode) orderPermission=$($oldRuntime.orderPermission)"
  }
  if ([int]$oldRuntime.wrapperPid -ne $oldTradeNotifierPid) {
    throw "Existing trade notifier wrapper PID mismatch. runtime=$($oldRuntime.wrapperPid) pidFile=$oldTradeNotifierPid"
  }
  $oldNodePid = [int]$oldRuntime.pid
  if ($oldNodePid -le 0 -or $null -eq (Get-LiveProcess $oldNodePid)) {
    throw "Existing trade notifier Node process is not alive. pid=$oldNodePid"
  }
  $oldHeartbeatAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$oldRuntime.heartbeatAt
  if ($oldHeartbeatAgeMs -lt -10000 -or $oldHeartbeatAgeMs -gt 15000) {
    throw "Existing trade notifier heartbeat is stale/invalid. ageMs=$oldHeartbeatAgeMs"
  }
  if (-not (Test-SamePath ([string]$oldRuntime.trendJournal) $expectedTrendJournal) -or -not (Test-SamePath ([string]$oldRuntime.sidewayJournal) $expectedSidewayJournal)) {
    throw "Existing trade notifier journal mapping is not canonical for $AccountMode."
  }

  & $taskkillExe /PID $oldTradeNotifierPid /T /F | Out-Host
  $taskkillExit = $LASTEXITCODE
  if ($null -eq $taskkillExit) { $taskkillExit = 0 }
  if ([int]$taskkillExit -ne 0) {
    throw "Failed to terminate trade notifier process tree. pid=$oldTradeNotifierPid exitCode=$taskkillExit"
  }
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_OLD_TRADE_NOTIFIER_TREE_STOP=PASS"
} else {
  if (Test-Path -LiteralPath $TradeNotifierRuntimePath -PathType Leaf) {
    $degradedRuntimeSnapshot = Read-JsonFile -Path $TradeNotifierRuntimePath -Label "Degraded trade notifier runtime"
    if (-not [string]::IsNullOrWhiteSpace([string]$degradedRuntimeSnapshot.accountMode) -and [string]$degradedRuntimeSnapshot.accountMode -ne $AccountMode) {
      throw "Degraded trade notifier account mode mismatch. expected=$AccountMode actual=$($degradedRuntimeSnapshot.accountMode)"
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$degradedRuntimeSnapshot.orderPermission) -and [string]$degradedRuntimeSnapshot.orderPermission -ne "NONE") {
      throw "Degraded trade notifier orderPermission must remain NONE. actual=$($degradedRuntimeSnapshot.orderPermission)"
    }
  }

  $degradedProcesses = @(Get-Phase7CTradeNotifierProcesses)
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_PROCESS_COUNT=$($degradedProcesses.Count)"
  Stop-Phase7CTradeNotifierProcesses -Processes $degradedProcesses -TaskkillExe $taskkillExe
  Remove-Item -LiteralPath $TradeNotifierPidPath -Force -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$newTradeNotifierPid = 0
$newTradeNotifierNodePid = 0
$lastNotifierError = "not observed"
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  try {
    if (-not (Test-Path -LiteralPath $TradeNotifierPidPath -PathType Leaf)) {
      $lastNotifierError = "trade-notifier.pid missing while supervisor restarts child"
      continue
    }
    $candidatePid = [int](Get-Content -LiteralPath $TradeNotifierPidPath -Raw).Trim()
    if ($candidatePid -le 0 -or ($oldTradeNotifierPid -gt 0 -and $candidatePid -eq $oldTradeNotifierPid) -or $null -eq (Get-LiveProcess $candidatePid)) {
      $lastNotifierError = "replacement wrapper not alive/new yet. pid=$candidatePid"
      continue
    }
    if (-not (Test-Path -LiteralPath $TradeNotifierRuntimePath -PathType Leaf)) {
      $lastNotifierError = "replacement runtime file missing"
      continue
    }
    $candidateRuntime = Get-Content -LiteralPath $TradeNotifierRuntimePath -Raw | ConvertFrom-Json
    if ([string]$candidateRuntime.status -ne "RUNNING") {
      $lastNotifierError = "replacement runtime status=$($candidateRuntime.status)"
      continue
    }
    if ([int]$candidateRuntime.wrapperPid -ne $candidatePid) {
      $lastNotifierError = "replacement wrapper mismatch. runtime=$($candidateRuntime.wrapperPid) pidFile=$candidatePid"
      continue
    }
    if ([string]$candidateRuntime.accountMode -ne $AccountMode) {
      $lastNotifierError = "replacement accountMode=$($candidateRuntime.accountMode) expected=$AccountMode"
      continue
    }
    if ([string]$candidateRuntime.orderPermission -ne "NONE") {
      throw "Replacement trade notifier orderPermission must remain NONE. actual=$($candidateRuntime.orderPermission)"
    }
    if (-not (Test-SamePath ([string]$candidateRuntime.trendJournal) $expectedTrendJournal) -or -not (Test-SamePath ([string]$candidateRuntime.sidewayJournal) $expectedSidewayJournal)) {
      $lastNotifierError = "replacement journal mapping is not canonical"
      continue
    }
    $heartbeatAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$candidateRuntime.heartbeatAt
    if ($heartbeatAgeMs -lt -10000 -or $heartbeatAgeMs -gt 15000) {
      $lastNotifierError = "replacement heartbeat ageMs=$heartbeatAgeMs"
      continue
    }
    $candidateNodePid = [int]$candidateRuntime.pid
    if ($candidateNodePid -le 0 -or $null -eq (Get-LiveProcess $candidateNodePid)) {
      $lastNotifierError = "replacement Node process not alive. pid=$candidateNodePid"
      continue
    }
    $newTradeNotifierPid = $candidatePid
    $newTradeNotifierNodePid = $candidateNodePid
    break
  } catch {
    $lastNotifierError = $_.Exception.Message
    if ($lastNotifierError -like "Replacement trade notifier orderPermission*") { throw }
  }
}
if ($newTradeNotifierPid -le 0) {
  throw "Supervisor did not establish a healthy replacement trade notifier before timeout. lastError=$lastNotifierError"
}
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_NEW_TRADE_NOTIFIER_PID=$newTradeNotifierPid"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_NEW_TRADE_NOTIFIER_NODE_PID=$newTradeNotifierNodePid"
if ($degradedRuntime) {
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_DEGRADED_RUNTIME_RECOVERY=PASS"
}

Assert-InvariantPid -Path $SupervisorPidPath -Label "Supervisor" -ExpectedPid $oldSupervisorPid -Marker "PHASE7C_TRADE_NOTIFIER_DEPLOY_SUPERVISOR_PID_UNCHANGED"
Assert-InvariantPid -Path $TrendPidPath -Label "Trend" -ExpectedPid $oldTrendPid -Marker "PHASE7C_TRADE_NOTIFIER_DEPLOY_TREND_PID_UNCHANGED"
Assert-InvariantPid -Path $SidewayPidPath -Label "Sideway" -ExpectedPid $oldSidewayPid -Marker "PHASE7C_TRADE_NOTIFIER_DEPLOY_SIDEWAY_PID_UNCHANGED"
Assert-InvariantPid -Path $TelegramModePidPath -Label "Telegram mode" -ExpectedPid $oldTelegramModePid -Marker "PHASE7C_TRADE_NOTIFIER_DEPLOY_TELEGRAM_MODE_PID_UNCHANGED"
Assert-InvariantPid -Path $RegimeNotifierPidPath -Label "Regime notifier" -ExpectedPid $oldRegimeNotifierPid -Marker "PHASE7C_TRADE_NOTIFIER_DEPLOY_REGIME_NOTIFIER_PID_UNCHANGED"

$activeAfter = Read-JsonFile -Path $ActiveLotSettingsPath -Label "Active lot settings"
$armedAfter = [bool]$activeAfter.armed
if ($armedAfter -ne $armedBefore) {
  throw "ARM state changed during notifier-only deploy. before=$armedBefore after=$armedAfter"
}
if ([string]$activeAfter.accountMode -ne $AccountMode -or [int]$activeAfter.supervisorPid -ne $oldSupervisorPid) {
  throw "Active executor identity changed during notifier-only deploy."
}
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ARMED_UNCHANGED=PASS"

if ($AccountMode -eq "LIVE") {
  $liveArmCapabilityAfter = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c-live-arm-control/capability" -Method Get -TimeoutSec 5
  if ([string]$liveArmCapabilityAfter.accountMode -ne "LIVE" -or [string]$liveArmCapabilityAfter.liveArmStatus -ne "ARMED" -or [bool]$liveArmCapabilityAfter.liveExecutionArmed -ne $true) {
    throw "Canonical LIVE ARM changed during notifier-only deploy. status=$($liveArmCapabilityAfter.liveArmStatus) armed=$($liveArmCapabilityAfter.liveExecutionArmed) account=$($liveArmCapabilityAfter.accountMode)"
  }
  $liveArmBridgeSessionAfter = [string]$liveArmCapabilityAfter.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($liveArmBridgeSessionAfter) -or $liveArmBridgeSessionAfter -ne $liveArmBridgeSessionBefore) {
    throw "Bridge session changed during notifier-only deploy. before=$liveArmBridgeSessionBefore after=$liveArmBridgeSessionAfter"
  }
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_LIVE_ARM_UNCHANGED=PASS"
  Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_BRIDGE_SESSION_UNCHANGED=PASS"
}

$modeAfterResponse = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$modeAfter = [string]$modeAfterResponse.state.mode
if ($modeAfter -ne $modeBefore) {
  throw "Bot mode changed during notifier-only deploy. before=$modeBefore after=$modeAfter"
}
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_MODE_UNCHANGED=PASS"

Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY=PASS"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ACCOUNT_MODE=$AccountMode"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_FINAL_MODE_UNCHANGED=$modeAfter"
Write-Host "PHASE7C_TRADE_NOTIFIER_DEPLOY_ORDER_PERMISSION=NONE"
