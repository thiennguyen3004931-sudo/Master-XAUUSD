param(
  [string]$TaskName = "XAUUSD-Phase7C-Executors",
  [string]$ControlApiUrl = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$TaskOwnershipHelperPath = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"

if (-not (Test-Path -LiteralPath $TaskOwnershipHelperPath)) {
  throw "Scheduled Task ownership helper not found: $TaskOwnershipHelperPath"
}
if (-not (Test-Path -LiteralPath $TaskConfigPath)) {
  throw "Executor task config not found: $TaskConfigPath"
}
. $TaskOwnershipHelperPath

function Read-RequiredJson([string]$Path, [string]$Label) {
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "Cannot read $Label JSON at $Path. $($_.Exception.Message)"
  }
}

function Get-RequiredLivePid([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Label PID file is missing: $Path"
  }
  try {
    $pidValue = [int](Get-Content -LiteralPath $Path -Raw).Trim()
  } catch {
    throw "$Label PID file is invalid: $Path"
  }
  if ($null -eq (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
    throw "$Label process is not alive. PID=$pidValue"
  }
  return $pidValue
}

$config = Read-RequiredJson $TaskConfigPath "executor task config"
$configVersion = [int]$config.version
if ($configVersion -notin @(1, 2)) {
  throw "Unsupported executor task config version: $configVersion"
}
if (-not [bool]$config.armed) {
  throw "Executor task config must be armed=true for startup acceptance."
}

$accountMode = if ($configVersion -eq 1) { "DEMO" } else { ([string]$config.accountMode).Trim().ToUpperInvariant() }
if ($accountMode -notin @("DEMO", "LIVE")) {
  throw "Startup acceptance supports only DEMO or LIVE runner accountMode. Actual=$accountMode"
}

$workDir = [string]$config.workDir
if ([string]::IsNullOrWhiteSpace($workDir)) {
  throw "Executor task config workDir is missing."
}
if (-not [System.IO.Path]::IsPathRooted($workDir)) {
  $workDir = Join-Path $ProjectRoot $workDir
}
if (-not (Test-Path -LiteralPath $workDir)) {
  throw "Executor task WorkDir not found: $workDir"
}
$workDir = (Resolve-Path -LiteralPath $workDir).Path

if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) {
  $ControlApiUrl = [string]$config.controlApiUrl
}
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) {
  throw "Control API URL is missing from task config and command line."
}
$apiBase = $ControlApiUrl.TrimEnd('/')

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$expectedRunnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $expectedRunnerPath
if (-not [bool]$ownership.owned) {
  throw "Scheduled Task action ownership mismatch. reason=$($ownership.reason)"
}
$taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
if ($taskDrift.Count -ne 0) {
  throw "Scheduled Task has canonical definition drift: $($taskDrift -join ',')"
}

$principalUser = [string]$task.Principal.UserId
$systemPrincipals = @("SYSTEM", "NT AUTHORITY\SYSTEM", "S-1-5-18")
if ($systemPrincipals -notcontains $principalUser.ToUpperInvariant()) {
  throw "Scheduled Task principal must be SYSTEM. Actual=$principalUser"
}
if ([string]$task.Principal.RunLevel -ne "Highest") {
  throw "Scheduled Task RunLevel must be Highest. Actual=$($task.Principal.RunLevel)"
}
if ([string]$task.State -ne "Running") {
  throw "Scheduled Task must be Running for startup acceptance. Actual=$($task.State)"
}

$runtimeDir = Join-Path $workDir "phase7c-executors"
$runnerStatusPath = Join-Path $runtimeDir "startup-runner-status.json"
$runnerLockPath = Join-Path $runtimeDir "startup-runner.lock"
$supervisorOutPath = Join-Path $runtimeDir "startup-supervisor.out.log"
$trendPidPath = Join-Path $runtimeDir "trend.pid"
$sidewayPidPath = Join-Path $runtimeDir "sideway.pid"

$runnerStatus = Read-RequiredJson $runnerStatusPath "startup runner status"
if ([string]$runnerStatus.status -ne "SUPERVISOR_RUNNING") {
  throw "Startup runner status must be SUPERVISOR_RUNNING. Actual=$($runnerStatus.status)"
}
$runnerAccountMode = ([string]$runnerStatus.accountMode).Trim().ToUpperInvariant()
if ($runnerAccountMode -notin @("DEMO", "LIVE")) {
  throw "Startup runner status accountMode is invalid. Actual=$runnerAccountMode"
}
if ($runnerAccountMode -ne $accountMode) {
  throw "Startup runner status accountMode does not match task config. Config=$accountMode Runtime=$runnerAccountMode"
}

$runnerPid = [int]$runnerStatus.runnerPid
$supervisorPid = [int]$runnerStatus.supervisorPid
if ($null -eq (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue)) {
  throw "Startup runner process is not alive. PID=$runnerPid"
}
if ($null -eq (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
  throw "Startup supervisor process is not alive. PID=$supervisorPid"
}
$runnerLockState = Get-Phase7CStartupRunnerLockState -LockPath $runnerLockPath
if ($runnerLockState -ne "HELD") {
  throw "Startup runner singleton lock must be HELD. Actual=$runnerLockState"
}

$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$statusAgeMs = $nowMs - [long]$runnerStatus.updatedAt
if ($statusAgeMs -lt -10000 -or $statusAgeMs -gt 60000) {
  throw "Startup runner status is stale or clock-skewed. ageMs=$statusAgeMs"
}

$trendPid = Get-RequiredLivePid $trendPidPath "Trend"
$sidewayPid = Get-RequiredLivePid $sidewayPidPath "Sideway"

if (-not (Test-Path -LiteralPath $supervisorOutPath)) {
  throw "Startup supervisor output log is missing: $supervisorOutPath"
}
$supervisorLog = Get-Content -LiteralPath $supervisorOutPath -Raw
$pauseIndex = $supervisorLog.IndexOf("PHASE7C_STARTUP_BOT_MODE=PAUSE", [System.StringComparison]::Ordinal)
$sourceIndex = $supervisorLog.IndexOf("PHASE7C_STARTUP_BOT_MODE_SOURCE=startup-scheduled-task", [System.StringComparison]::Ordinal)
$trendIndex = $supervisorLog.IndexOf("PHASE7C_TREND_PID=", [System.StringComparison]::Ordinal)
$sidewayIndex = $supervisorLog.IndexOf("PHASE7C_SIDEWAY_PID=", [System.StringComparison]::Ordinal)
if ($pauseIndex -lt 0 -or $sourceIndex -lt 0 -or $trendIndex -lt 0 -or $sidewayIndex -lt 0) {
  throw "Startup supervisor log is missing one or more required PAUSE/executor markers."
}
if ($pauseIndex -ge $trendIndex -or $pauseIndex -ge $sidewayIndex) {
  throw "Startup PAUSE marker must precede both executor launch markers."
}
if ($sourceIndex -le $pauseIndex -or $sourceIndex -ge $trendIndex -or $sourceIndex -ge $sidewayIndex) {
  throw "Startup PAUSE provenance marker must appear after PAUSE and before both executor launch markers."
}

$trendMarker = [regex]::Match($supervisorLog, '(?m)^PHASE7C_TREND_PID=(\d+)\r?$')
$sidewayMarker = [regex]::Match($supervisorLog, '(?m)^PHASE7C_SIDEWAY_PID=(\d+)\r?$')
if (-not $trendMarker.Success -or [int]$trendMarker.Groups[1].Value -ne $trendPid) {
  throw "Trend PID file does not match current startup supervisor log. File=$trendPid"
}
if (-not $sidewayMarker.Success -or [int]$sidewayMarker.Groups[1].Value -ne $sidewayPid) {
  throw "Sideway PID file does not match current startup supervisor log. File=$sidewayPid"
}

$mode = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$mode.state.mode -ne "PAUSE") {
  throw "Canonical bot mode must remain PAUSE for startup acceptance. Actual=$($mode.state.mode)"
}
if ([string]$mode.state.updatedBy -ne "startup-scheduled-task") {
  throw "Canonical PAUSE provenance must be startup-scheduled-task. Actual=$($mode.state.updatedBy)"
}

Write-Host "PHASE7C_STARTUP_ACCEPTANCE=PASS"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_TASK=$TaskName"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_TASK_STATE=$($task.State)"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_TASK_PRINCIPAL=$principalUser"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_TASK_RUN_LEVEL=$($task.Principal.RunLevel)"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_TASK_DRIFT=NONE"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_ACCOUNT_MODE=$runnerAccountMode"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_RUNNER_PID=$runnerPid"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_SUPERVISOR_PID=$supervisorPid"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_RUNNER_LOCK=$runnerLockState"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_STATUS_AGE_MS=$statusAgeMs"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_MODE=$($mode.state.mode)"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_MODE_SOURCE=$($mode.state.updatedBy)"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_TREND_PID=$trendPid"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_SIDEWAY_PID=$sidewayPid"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_ORDER=PAUSE_BEFORE_EXECUTORS"
Write-Host "PHASE7C_STARTUP_ACCEPTANCE_MUTATION=NONE"
