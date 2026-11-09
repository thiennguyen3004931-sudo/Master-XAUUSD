param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [switch]$SkipBuild,
  [switch]$ArmExecutors,
  [double]$TrendFixedVolume = 0.03,
  [double]$SidewayRiskPercent = 0.25,
  [double]$SidewayMaxLot = 0.03,
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$BridgePort = 8765,
  [string]$ExecutorTaskName = "XAUUSD-Phase7C-Executors"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path

$Activation = Join-Path $PSScriptRoot "activate-phase7c-local.ps1"
$Stopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"
$CoreCleanup = Join-Path $PSScriptRoot "clear-phase7c-project-core-ports-local.ps1"
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-executors-local.ps1"
$Smoke = Join-Path $PSScriptRoot "smoke-phase7c-runtime-local.ps1"
$TaskConfig = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$RuntimeDir = Join-Path $WorkDir "phase7c-executors"
$RunnerStatusPath = Join-Path $RuntimeDir "startup-runner-status.json"
$apiUrl = "http://127.0.0.1:$ApiPort"

foreach ($required in @($Activation, $Stopper, $CoreCleanup, $Verifier, $Smoke)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required Phase 7C script not found: $required" }
}

function Set-PauseSafe([string]$Source) {
  try {
    $response = Invoke-RestMethod `
      -Uri "$apiUrl/api/v1/phase7c/bot-mode" `
      -Method Post `
      -ContentType "application/json" `
      -Body (@{ mode = "PAUSE"; source = $Source } | ConvertTo-Json) `
      -TimeoutSec 5
    if ([string]$response.state.mode -ne "PAUSE") { throw "Control API did not confirm PAUSE." }
    Write-Host "PHASE7C_SAFE_ACTIVATE_MODE=PAUSE|SOURCE=$Source"
    return $true
  } catch {
    Write-Host "PHASE7C_SAFE_ACTIVATE_MODE=API_UNAVAILABLE|SOURCE=$Source"
    return $false
  }
}

function Get-ExecutorTask {
  return Get-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction SilentlyContinue
}

function Test-StartupRunnerTask($Task) {
  if ($null -eq $Task) { return $false }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { return $false }
  $actionText = "$($actions[0].Execute) $($actions[0].Arguments)"
  return $actionText -like "*run-phase7c-executor-task-runner-local.ps1*"
}

function Stop-ExecutorTaskIfRunning {
  $task = Get-ExecutorTask
  if ($null -eq $task) { return $false }
  if (-not (Test-StartupRunnerTask $task)) {
    throw "Scheduled task $ExecutorTaskName is present but is not a verified startup-runner task."
  }

  $wasRunning = $task.State -eq "Running"
  if ($wasRunning) {
    Stop-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction Stop
    Start-Sleep -Seconds 2
    Write-Host "PHASE7C_SAFE_ACTIVATE_EXECUTOR_TASK_STOPPED=PASS"
  }
  return $wasRunning
}

function Stop-Executors {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Stopper -WorkDir $WorkDir
  if ($LASTEXITCODE -ne 0) { throw "Phase 7C executor stop failed with exit code $LASTEXITCODE." }
}

function Invoke-StrictVerifyWithGrace([int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempt = 0
  $lastError = ""
  while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
      & $Verifier -WorkDir $WorkDir -RequireMigratedTask -RequireTelegram
      Write-Host "PHASE7C_SAFE_ACTIVATE_STRICT_VERIFY=PASS|ATTEMPT=$attempt"
      return
    } catch {
      $lastError = $_.Exception.Message
      Write-Host "PHASE7C_SAFE_ACTIVATE_STRICT_VERIFY=WAIT|ATTEMPT=$attempt"
      Start-Sleep -Seconds 5
    }
  }
  throw "Phase 7C strict verification did not become ready within $TimeoutSeconds seconds. LastError=$lastError"
}

Write-Host "PHASE7C_SAFE_ACTIVATE=START"
Set-PauseSafe "safe-activation-entry-freeze" | Out-Null

$taskWasRunning = Stop-ExecutorTaskIfRunning
Stop-Executors
Write-Host "PHASE7C_SAFE_ACTIVATE_EXECUTOR_FREEZE=PASS"

& $CoreCleanup -ApiPort $ApiPort -WebPort $WebPort -BridgePort $BridgePort
if ($LASTEXITCODE -ne 0) { throw "Phase 7C endpoint-owned core cleanup failed with exit code $LASTEXITCODE." }
Write-Host "PHASE7C_SAFE_ACTIVATE_CORE_CLEANUP=PASS"

$activationArgs = @{
  WorkDir = $WorkDir
  ApiPort = $ApiPort
  WebPort = $WebPort
  BridgePort = $BridgePort
}
if ($SkipBuild) { $activationArgs.SkipBuild = $true }
if ($ArmExecutors) { $activationArgs.ArmExecutors = $true }
if ($PSBoundParameters.ContainsKey("TrendFixedVolume")) { $activationArgs.TrendFixedVolume = $TrendFixedVolume }
if ($PSBoundParameters.ContainsKey("SidewayRiskPercent")) { $activationArgs.SidewayRiskPercent = $SidewayRiskPercent }
if ($PSBoundParameters.ContainsKey("SidewayMaxLot")) { $activationArgs.SidewayMaxLot = $SidewayMaxLot }

& $Activation @activationArgs
Write-Host "PHASE7C_SAFE_ACTIVATE_BASE_ACTIVATION=PASS"

# Recovery-safe activation always returns to PAUSE. The operator can restore
# AUTO/TREND/SIDEWAY only after strict verify + smoke are green.
if (-not (Set-PauseSafe "safe-activation-post-start-freeze")) {
  throw "Phase 7C safe activation could not confirm PAUSE after base activation."
}

if ($ArmExecutors -and $taskWasRunning) {
  if (-not (Test-Path -LiteralPath $TaskConfig)) {
    throw "Task-managed runtime was active before recovery, but task config is missing: $TaskConfig"
  }

  $directSupervisorPid = 0
  $supervisorPidPath = Join-Path $RuntimeDir "supervisor.pid"
  if (Test-Path -LiteralPath $supervisorPidPath) {
    try { $directSupervisorPid = [int](Get-Content -LiteralPath $supervisorPidPath -Raw).Trim() } catch {}
  }

  Stop-Executors

  $task = Get-ExecutorTask
  if ($null -eq $task -or -not (Test-StartupRunnerTask $task)) {
    throw "Task-managed handoff blocked: verified executor startup task is unavailable."
  }
  if ($task.State -eq "Disabled") {
    Enable-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction Stop | Out-Null
  }

  $handoffStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Start-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction Stop
  Write-Host "PHASE7C_SAFE_ACTIVATE_TASK_HANDOFF=START"

  $handoffDeadline = (Get-Date).AddSeconds(60)
  $newRunnerPid = 0
  $newSupervisorPid = 0
  while ((Get-Date) -lt $handoffDeadline) {
    Start-Sleep -Seconds 5
    if (-not (Test-Path -LiteralPath $RunnerStatusPath)) { continue }
    try {
      $status = Get-Content -LiteralPath $RunnerStatusPath -Raw | ConvertFrom-Json
      $statusUpdatedAt = [long]$status.updatedAt
      $candidateRunner = [int]$status.runnerPid
      $candidateSupervisor = [int]$status.supervisorPid
      $runnerAlive = $candidateRunner -gt 0 -and $null -ne (Get-Process -Id $candidateRunner -ErrorAction SilentlyContinue)
      $supervisorAlive = $candidateSupervisor -gt 0 -and $null -ne (Get-Process -Id $candidateSupervisor -ErrorAction SilentlyContinue)
      $newSupervisor = $candidateSupervisor -ne $directSupervisorPid
      if ($statusUpdatedAt -ge $handoffStartedAt -and $runnerAlive -and $supervisorAlive -and $newSupervisor) {
        $newRunnerPid = $candidateRunner
        $newSupervisorPid = $candidateSupervisor
        break
      }
    } catch {}
  }

  if ($newRunnerPid -le 0 -or $newSupervisorPid -le 0) {
    throw "Task-managed handoff failed: no fresh startup runner/supervisor within 60 seconds. Keep PAUSE."
  }

  $task = Get-ExecutorTask
  if ($null -eq $task -or $task.State -ne "Running") {
    throw "Task-managed handoff failed: executor task is not Running. Keep PAUSE."
  }

  Write-Host "PHASE7C_SAFE_ACTIVATE_TASK_RUNNER_PID=$newRunnerPid"
  Write-Host "PHASE7C_SAFE_ACTIVATE_TASK_SUPERVISOR_PID=$newSupervisorPid"
  Write-Host "PHASE7C_SAFE_ACTIVATE_TASK_HANDOFF=PASS"

  Invoke-StrictVerifyWithGrace 90
  & $Smoke -WorkDir $WorkDir
  if ($LASTEXITCODE -ne 0) { throw "Phase 7C smoke failed after task handoff." }
  Write-Host "PHASE7C_SAFE_ACTIVATE_SMOKE=PASS"
}

Write-Host "PHASE7C_SAFE_ACTIVATE_FINAL_MODE=PAUSE"
Write-Host "PHASE7C_SAFE_ACTIVATE_STATUS=PASS"
