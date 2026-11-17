param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [string]$ExecutorTaskName = "XAUUSD-Phase7C-Executors",
  [string]$BridgeTaskName = "XAUUSD-Phase7C-Bridge",
  [string]$LegacyBridgeTaskName = "XAUUSD-Phase7B-Bridge"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"
$TaskConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"

foreach ($required in @($AccountLibrary, $Verifier, $AccountStatePath, $TaskConfigPath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "DEMO recovery required file not found: $required" }
}
. $AccountLibrary

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$DemoEnvFile = Resolve-ProjectPath $DemoEnvFile
$LiveEnvFile = Resolve-ProjectPath $LiveEnvFile
$CanonicalRiskPath = Join-Path $WorkDir "phase7c-lot-settings.json"
$BridgeLockPath = Join-Path $WorkDir "phase7c-account-bridge\startup-runner.lock"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "DEMO recovery requires PowerShell Administrator."
}

$demoEnv = Assert-Phase7CAccountEnv -EnvFile $DemoEnvFile -AccountMode "DEMO" -RequireTrading
$liveEnv = Assert-Phase7CAccountEnv -EnvFile $LiveEnvFile -AccountMode "LIVE" -RequireTrading
if ($demoEnv.apiKey -ne $liveEnv.apiKey) { throw "DEMO/LIVE bridge API key mismatch; refusing recovery." }
if ($demoEnv.bridgeHost -ne $liveEnv.bridgeHost -or $demoEnv.bridgePort -ne $liveEnv.bridgePort) {
  throw "DEMO/LIVE bridge host/port mismatch; refusing recovery."
}

function Set-BotPause([string]$Source) {
  $result = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Post -ContentType "application/json" -Body (@{ mode = "PAUSE"; source = $Source } | ConvertTo-Json) -TimeoutSec 10
  if ([string]$result.state.mode -ne "PAUSE") { throw "Control API did not confirm PAUSE." }
}

function Wait-ExclusiveLockReleased([string]$Path, [int]$TimeoutSeconds = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $probe = $null
    try {
      $directory = Split-Path -Parent $Path
      if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
      $probe = [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $probe.Dispose()
      Write-Host "PHASE7C_DEMO_RECOVERY_LOCK_RELEASED=$Path"
      return
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 500
    } finally {
      if ($null -ne $probe) { try { $probe.Dispose() } catch {} }
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for lock release: $Path"
}

function Get-BridgeHealthAnyMode {
  $base = "http://$($demoEnv.bridgeHost):$($demoEnv.bridgePort)"
  return Invoke-RestMethod -Uri "$base/health" -Headers @{ "x-mt5-api-key" = $demoEnv.apiKey } -Method Get -TimeoutSec 5
}

function Stop-VerifiedBridgeListener {
  $port = [int]$demoEnv.bridgePort
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { [int]$_.LocalPort -eq $port })
  if ($listeners.Count -eq 0) {
    Write-Host "PHASE7C_DEMO_RECOVERY_BRIDGE_LISTENER=NONE"
    return
  }
  if ($listeners.Count -ne 1) { throw "Expected exactly one listener on bridge port $port; found $($listeners.Count)." }

  $health = Get-BridgeHealthAnyMode
  if (-not [bool]$health.connected -or [string]$health.status -ne "ok") { throw "Existing bridge listener is not healthy; ownership cannot be proven." }
  if ([string]$health.accountMode -notin @("demo", "real")) { throw "Existing listener broker mode is not recognized." }
  if ([string]$health.configuredAccountMode -notin @("DEMO", "LIVE")) { throw "Existing listener configured mode is not recognized." }
  $login = [long]$health.accountLogin
  $knownLogin = $demoEnv.allowedLogins -contains $login -or $liveEnv.allowedLogins -contains $login
  if (-not $knownLogin) { throw "Existing bridge login is not in either configured account allowlist." }

  $pidValue = [int]$listeners[0].OwningProcess
  if ($pidValue -le 0) { throw "Bridge listener PID is invalid." }
  Write-Host "PHASE7C_DEMO_RECOVERY_BRIDGE_LISTENER_PROOF=PASS|MODE=$($health.configuredAccountMode)|BROKER=$($health.accountMode)|LOGIN=$login|PID=$pidValue"
  & "$env:SystemRoot\System32\taskkill.exe" /PID $pidValue /T /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 750
  $remaining = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { [int]$_.LocalPort -eq $port })
  if ($remaining.Count -ne 0) { throw "Verified bridge listener did not stop cleanly." }
  Write-Host "PHASE7C_DEMO_RECOVERY_BRIDGE_LISTENER_STOPPED=PASS"
}

function Assert-LegacyTaskSafeToStop {
  $task = Get-ScheduledTask -TaskName $LegacyBridgeTaskName -ErrorAction SilentlyContinue
  if ($null -eq $task -or $task.State -ne "Running") { return }
  $actions = @($task.Actions)
  $text = if ($actions.Count -eq 1) { "$($actions[0].Execute) $($actions[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
  if ($actions.Count -ne 1 -or $text -notmatch '(?i)(run-phase7b-bridge-service-local\.ps1|phase7b.*bridge|mt5-broker.*bridge)') {
    throw "Legacy bridge task is running but project ownership is not proven."
  }
}

function Get-JsonArrayCount([string]$Uri, $Headers) {
  $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 5
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return 0 }
  $parsed = $raw | ConvertFrom-Json
  return @($parsed | Where-Object { $null -ne $_ }).Count
}

function Get-ExecutorDesiredState($Lifecycle) {
  $desired = ([string]$Lifecycle.broker.status.desiredExecutorState).Trim().ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($desired)) {
    $desired = ([string]$Lifecycle.broker.heartbeat.desiredExecutorState).Trim().ToUpperInvariant()
  }
  return $desired
}

function Test-ExecutorRuntimeAlive($Lifecycle) {
  if ([bool]$Lifecycle.running) { return $true }
  foreach ($name in @("supervisor", "trend", "sideway", "telegram", "regimeNotifier")) {
    $entry = $Lifecycle.processes.$name
    if ($null -ne $entry -and [bool]$entry.alive) { return $true }
  }
  return $false
}

function Assert-ExecutorLifecycleBrokerReady([string]$ExpectedDesiredState = "") {
  $task = Get-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction Stop
  $actions = @($task.Actions)
  $text = if ($actions.Count -eq 1) { "$($actions[0].Execute) $($actions[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
  if ($actions.Count -ne 1 -or $text -notlike "*run-phase7c-executor-task-runner-local.ps1*") {
    throw "Executor Scheduled Task is not the verified SYSTEM lifecycle broker runner."
  }
  if ($task.State -ne "Running") {
    throw "Executor SYSTEM lifecycle broker Scheduled Task is not Running. Current=$($task.State). Refusing implicit task boot."
  }

  $api = $ControlApiUrl.TrimEnd('/')
  $lifecycle = Invoke-RestMethod -Uri "$api/api/v1/phase7c/lifecycle" -Method Get -TimeoutSec 5
  if (-not [bool]$lifecycle.broker.ready) { throw "Lifecycle broker SYSTEM is not READY. Refusing DEMO recovery mutation." }
  $brokerPid = [int]$lifecycle.broker.heartbeat.brokerPid
  if ($brokerPid -le 0) { throw "Lifecycle broker SYSTEM did not publish a valid broker PID." }
  $desired = Get-ExecutorDesiredState $lifecycle
  if ([string]::IsNullOrWhiteSpace($desired)) { throw "Lifecycle broker SYSTEM did not publish desiredExecutorState." }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedDesiredState) -and $desired -ne $ExpectedDesiredState.Trim().ToUpperInvariant()) {
    throw "Lifecycle broker desiredExecutorState mismatch. Expected=$ExpectedDesiredState Actual=$desired"
  }
  return $lifecycle
}

function Ensure-ExecutorsStoppedThroughLifecycle {
  $api = $ControlApiUrl.TrimEnd('/')
  $before = Assert-ExecutorLifecycleBrokerReady
  $desiredBefore = Get-ExecutorDesiredState $before
  if ($desiredBefore -eq "STOPPED" -and -not (Test-ExecutorRuntimeAlive $before)) {
    Write-Host "PHASE7C_DEMO_RECOVERY_LIFECYCLE_STOP=PASS|ACTION=ALREADY_STOPPED|DESIRED=STOPPED"
    return
  }
  if ($desiredBefore -ne "RUNNING") {
    throw "DEMO recovery requires executor desired state RUNNING or safely STOPPED. Actual=$desiredBefore"
  }

  try {
    $stopResult = Invoke-RestMethod -Uri "$api/api/v1/phase7c/lifecycle/stop" -Method Post -TimeoutSec 45
  } catch {
    throw "Canonical lifecycle STOP was rejected while executor runtime is active. Recovery fails closed instead of stopping the Scheduled Task. $($_.Exception.Message)"
  }
  $action = ([string]$stopResult.action).Trim().ToUpperInvariant()
  if ($action -ne "STOPPED") { throw "Canonical lifecycle STOP returned unexpected action: $action" }

  for ($i = 1; $i -le 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $status = Assert-ExecutorLifecycleBrokerReady
      if ((Get-ExecutorDesiredState $status) -eq "STOPPED" -and -not (Test-ExecutorRuntimeAlive $status)) {
        Write-Host "PHASE7C_DEMO_RECOVERY_LIFECYCLE_STOP=PASS|ACTION=$action|DESIRED=STOPPED"
        return
      }
    } catch {
      if ($_.Exception.Message -match 'Scheduled Task is not Running|not READY|valid broker PID') { throw }
    }
  }
  throw "Executor runtime did not reach canonical STOPPED while SYSTEM broker remained Running."
}

function Start-ExecutorsThroughLifecycle([string]$ExpectedMode) {
  $api = $ControlApiUrl.TrimEnd('/')
  [void](Assert-ExecutorLifecycleBrokerReady "STOPPED")
  $startResult = Invoke-RestMethod -Uri "$api/api/v1/phase7c/lifecycle/start" -Method Post -TimeoutSec 70
  $action = ([string]$startResult.action).Trim().ToUpperInvariant()
  $mode = ([string]$startResult.accountMode).Trim().ToUpperInvariant()
  if ($action -notin @("STARTED", "RESTARTED", "ALREADY_RUNNING")) {
    throw "Canonical lifecycle START returned unexpected action: $action"
  }
  if ($mode -ne $ExpectedMode) {
    throw "Canonical lifecycle START account mode mismatch. Expected=$ExpectedMode Actual=$mode"
  }
  Write-Host "PHASE7C_DEMO_RECOVERY_LIFECYCLE_START=PASS|ACTION=$action|MODE=$mode"
}

Write-Host "PHASE7C_DEMO_RECOVERY=START"
Set-BotPause "failed-account-switch-recovery"
Write-Host "PHASE7C_DEMO_RECOVERY_PAUSE=PASS"
Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "failed-account-switch-recovery"
Write-Host "PHASE7C_DEMO_RECOVERY_LIVE_ARM=DISARMED"

Assert-LegacyTaskSafeToStop
Ensure-ExecutorsStoppedThroughLifecycle
Write-Host "PHASE7C_DEMO_RECOVERY_EXECUTORS_STOPPED=PASS"
Stop-ScheduledTask -TaskName $BridgeTaskName -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $LegacyBridgeTaskName -ErrorAction SilentlyContinue
Write-Host "PHASE7C_DEMO_RECOVERY_BRIDGE_TASKS_STOP_REQUESTED=PASS"

Wait-ExclusiveLockReleased $BridgeLockPath
Stop-VerifiedBridgeListener

$demoRiskPath = Get-Phase7CRiskProfilePath $WorkDir "DEMO"
if (-not (Test-Path -LiteralPath $demoRiskPath)) { throw "DEMO risk profile is missing: $demoRiskPath" }
$demoRiskRaw = Get-Content -LiteralPath $demoRiskPath -Raw | ConvertFrom-Json
$demoRisk = Assert-Phase7CRiskProfile $demoRiskRaw "DEMO recovery risk profile"

Write-Phase7CAccountJsonAtomic -Path $CanonicalRiskPath -Value ([pscustomobject]@{
  version = 1
  trendFixedLot = $demoRisk.trendFixedLot
  sidewayRiskPercent = $demoRisk.sidewayRiskPercent
  sidewayMaxLot = $demoRisk.sidewayMaxLot
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "failed-switch-recovery:DEMO"
}) -Depth 5

Write-Phase7CAccountJsonAtomic -Path $AccountStatePath -Value ([pscustomobject]@{
  version = 1
  accountMode = "DEMO"
  liveExecutionEnabled = $false
  envFile = $demoEnv.envFile
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "failed-switch-recovery"
}) -Depth 5

$config = Get-Content -LiteralPath $TaskConfigPath -Raw | ConvertFrom-Json
$configOut = [ordered]@{}
foreach ($property in $config.PSObject.Properties) { $configOut[$property.Name] = $property.Value }
$configOut["version"] = 2
$configOut["accountMode"] = "DEMO"
$configOut["demoOnly"] = $true
$configOut["liveExecutionEnabled"] = $false
$configOut["armed"] = $true
$configOut["envFile"] = $demoEnv.envFile
$configOut["trendFixedVolume"] = $demoRisk.trendFixedLot
$configOut["sidewayRiskPercent"] = $demoRisk.sidewayRiskPercent
$configOut["sidewayMaxLot"] = $demoRisk.sidewayMaxLot
Write-Phase7CAccountJsonAtomic -Path $TaskConfigPath -Value ([pscustomobject]$configOut) -Depth 8
Write-Host "PHASE7C_DEMO_RECOVERY_RUNTIME_CONFIG=PASS"

Start-ScheduledTask -TaskName $BridgeTaskName -ErrorAction Stop
$base = "http://$($demoEnv.bridgeHost):$($demoEnv.bridgePort)"
$headers = @{ "x-mt5-api-key" = $demoEnv.apiKey }
$demoHealth = $null
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $candidate = Invoke-RestMethod -Uri "$base/health" -Headers $headers -Method Get -TimeoutSec 5
    if ($candidate.connected -and [string]$candidate.status -eq "ok" -and [string]$candidate.configuredAccountMode -eq "DEMO" -and [string]$candidate.accountMode -eq "demo") {
      $demoHealth = $candidate
      break
    }
  } catch {}
}
if ($null -eq $demoHealth) { throw "DEMO bridge did not become healthy after recovery within 60 seconds." }
if ($demoEnv.allowedLogins -notcontains [long]$demoHealth.accountLogin) { throw "Recovered DEMO login is outside configured allowlist." }
$positionCount = Get-JsonArrayCount "$base/v1/positions?symbol=XAUUSD" $headers
$orderCount = Get-JsonArrayCount "$base/v1/orders?symbol=XAUUSD" $headers
Write-Host "PHASE7C_DEMO_RECOVERY_BRIDGE=PASS|LOGIN=$($demoHealth.accountLogin)"
Write-Host "PHASE7C_DEMO_RECOVERY_XAUUSD_POSITIONS=$positionCount"
Write-Host "PHASE7C_DEMO_RECOVERY_XAUUSD_PENDING_ORDERS=$orderCount"
if ($positionCount -ne 0 -or $orderCount -ne 0) {
  throw "Recovered DEMO account is not flat; executors will remain stopped. Positions=$positionCount Orders=$orderCount"
}

Start-ExecutorsThroughLifecycle "DEMO"
$verified = $false
for ($i = 1; $i -le 24; $i++) {
  Start-Sleep -Seconds 5
  try {
    & $Verifier -WorkDir $WorkDir -ExpectedAccountMode DEMO -ControlApiUrl $ControlApiUrl -RequireTelegram
    if ($LASTEXITCODE -eq 0) {
      [void](Assert-ExecutorLifecycleBrokerReady "RUNNING")
      $verified = $true
      break
    }
  } catch {}
}
if (-not $verified) { throw "Recovered DEMO executor runtime did not pass strict verification within 120 seconds." }
Set-BotPause "failed-account-switch-recovery-complete"
Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "failed-account-switch-recovery-complete"

$finalState = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
$finalBot = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ((ConvertTo-Phase7CAccountMode ([string]$finalState.accountMode)) -ne "DEMO") { throw "Recovery final account mode is not DEMO." }
if ([string]$finalBot.state.mode -ne "PAUSE") { throw "Recovery final bot mode is not PAUSE." }
if (Test-Path -LiteralPath (Get-Phase7CLiveArmPath $WorkDir)) { throw "LIVE arm file exists after DEMO recovery." }

Write-Host "PHASE7C_DEMO_RECOVERY_FINAL_ACCOUNT_MODE=DEMO"
Write-Host "PHASE7C_DEMO_RECOVERY_FINAL_BOT_MODE=PAUSE"
Write-Host "PHASE7C_DEMO_RECOVERY_LIVE_CAPABILITY_ENV_PRESERVED=True"
Write-Host "PHASE7C_DEMO_RECOVERY_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_DEMO_RECOVERY_STATUS=PASS"
