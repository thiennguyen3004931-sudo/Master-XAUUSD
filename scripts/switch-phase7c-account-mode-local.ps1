param(
  [Parameter(Mandatory = $true)] [ValidateSet("DEMO", "LIVE")] [string]$TargetMode,
  [string]$WorkDir = ".runtime",
  [string]$ExecutorTaskName = "XAUUSD-Phase7C-Executors",
  [string]$BridgeTaskName = "XAUUSD-Phase7C-Bridge",
  [string]$LegacyBridgeTaskName = "XAUUSD-Phase7B-Bridge",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [switch]$ConfirmLiveExecution,
  [switch]$SkipPostSwitchSmoke
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"
$Smoke = Join-Path $PSScriptRoot "smoke-phase7c-account-runtime-local.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"
$TaskConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$BridgeRunnerLockPath = Join-Path $ProjectRoot ".runtime\phase7c-account-bridge\startup-runner.lock"
$CanonicalRiskPath = $null

foreach ($required in @($AccountLibrary, $Verifier, $Smoke)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Phase7C account switch required file not found: $required" }
}
. $AccountLibrary
$TargetMode = ConvertTo-Phase7CAccountMode $TargetMode
if ($TargetMode -eq "LIVE" -and -not $ConfirmLiveExecution) {
  throw "LIVE account switching requires explicit -ConfirmLiveExecution."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Phase7C account switching requires PowerShell Administrator."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$CanonicalRiskPath = Join-Path $WorkDir "phase7c-lot-settings.json"

function Resolve-ProjectFile([string]$Path) {
  if (-not [System.IO.Path]::IsPathRooted($Path)) { return Join-Path $ProjectRoot $Path }
  return $Path
}
$DemoEnvFile = Resolve-ProjectFile $DemoEnvFile
$LiveEnvFile = Resolve-ProjectFile $LiveEnvFile

$demoEnv = Assert-Phase7CAccountEnv -EnvFile $DemoEnvFile -AccountMode "DEMO" -RequireTrading
$liveEnv = $null
$liveIdentity = $null
if ($TargetMode -eq "LIVE") {
  if (-not (Test-Path -LiteralPath $LiveEnvFile)) {
    throw "LIVE env is not configured. Copy .env.phase7b-live.example to .env.phase7b-live and configure it locally first."
  }
  $liveEnv = Assert-Phase7CAccountEnv -EnvFile $LiveEnvFile -AccountMode "LIVE" -RequireTrading
  $liveIdentity = Get-Phase7CLiveProfileIdentity $LiveEnvFile
  if ($demoEnv.apiKey -ne $liveEnv.apiKey) { throw "DEMO and LIVE must use the same MT5_API_KEY because the local API process keeps a fixed bridge credential." }
  if ($demoEnv.bridgeHost -ne $liveEnv.bridgeHost -or $demoEnv.bridgePort -ne $liveEnv.bridgePort) {
    throw "DEMO and LIVE must use the same localhost MT5 bridge host/port."
  }
}
$targetEnv = if ($TargetMode -eq "LIVE") { $liveEnv } else { $demoEnv }

$bridgeTask = Get-ScheduledTask -TaskName $BridgeTaskName -ErrorAction SilentlyContinue
if ($null -eq $bridgeTask) {
  throw "Required account bridge task is missing: $BridgeTaskName. Run register-phase7c-account-bridge-task-local.ps1 first."
}
$bridgeTaskAction = @($bridgeTask.Actions)
$bridgeTaskText = if ($bridgeTaskAction.Count -eq 1) { "$($bridgeTaskAction[0].Execute) $($bridgeTaskAction[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
if ($bridgeTaskAction.Count -ne 1 -or $bridgeTaskText -notlike "*run-phase7c-account-bridge-task-runner-local.ps1*") {
  throw "Account bridge task action is not verified; refusing account switch."
}
$executorTask = Get-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction Stop
$executorActions = @($executorTask.Actions)
$executorText = if ($executorActions.Count -eq 1) { "$($executorActions[0].Execute) $($executorActions[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
if ($executorActions.Count -ne 1 -or $executorText -notlike "*run-phase7c-executor-task-runner-local.ps1*") {
  throw "Executor Scheduled Task is not using the verified startup runner."
}
if ($executorTask.State -ne "Running") {
  throw "Executor SYSTEM lifecycle broker task must already be Running before account switch. Current=$($executorTask.State)"
}
if (-not (Test-Path $TaskConfigPath)) { throw "Executor task config not found: $TaskConfigPath" }

function Set-BotPause([string]$Source) {
  $api = $ControlApiUrl.TrimEnd('/')
  $result = Invoke-RestMethod -Uri "$api/api/v1/phase7c/bot-mode" -Method Post -ContentType "application/json" -Body (@{ mode = "PAUSE"; source = $Source } | ConvertTo-Json) -TimeoutSec 10
  if ([string]$result.state.mode -ne "PAUSE") { throw "Control API did not confirm PAUSE." }
  return $result
}

function Read-AccountStateOrDefault {
  if (-not (Test-Path $AccountStatePath)) {
    return [pscustomobject]@{
      version = 1; accountMode = "DEMO"; liveExecutionEnabled = $false; envFile = $demoEnv.envFile;
      updatedAt = [DateTimeOffset]::UtcNow.ToString("o"); updatedBy = "legacy-demo-default"
    }
  }
  $state = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
  if ([int]$state.version -ne 1) { throw "Unsupported account-mode state version." }
  $mode = ConvertTo-Phase7CAccountMode ([string]$state.accountMode)
  $enabled = [bool]$state.liveExecutionEnabled
  if ($mode -eq "DEMO" -and $enabled) { throw "Existing DEMO account state is invalid." }
  if ($mode -eq "LIVE" -and -not $enabled) { throw "Existing LIVE account state is invalid." }
  if ([string]::IsNullOrWhiteSpace([string]$state.envFile)) {
    $state | Add-Member -NotePropertyName envFile -NotePropertyValue (if ($mode -eq "LIVE") { $LiveEnvFile } else { $DemoEnvFile }) -Force
  }
  return $state
}

function Get-StatePaths([string]$Mode) {
  if ($Mode -eq "LIVE") {
    return [pscustomobject]@{
      trend = Join-Path $WorkDir "phase7b-live-forward\phase7b-demo-state.json"
      sideway = Join-Path $WorkDir "phase7c-sideway-live-forward\phase7c-sideway-state.json"
    }
  }
  return [pscustomobject]@{
    trend = Join-Path $WorkDir "phase7b-demo-forward\phase7b-demo-state.json"
    sideway = Join-Path $WorkDir "phase7c-sideway-forward\phase7c-sideway-state.json"
  }
}

function Assert-StateFlat([string]$Mode) {
  $paths = Get-StatePaths $Mode
  foreach ($item in @(
    [pscustomobject]@{ label = "Trend"; path = $paths.trend },
    [pscustomobject]@{ label = "Sideway"; path = $paths.sideway }
  )) {
    if (-not (Test-Path $item.path)) { continue }
    $state = Get-Content -LiteralPath $item.path -Raw | ConvertFrom-Json
    if ($null -ne $state.managed) { throw "$($item.label) state still contains a managed position; account switch is blocked." }
    if ($item.label -eq "Sideway" -and $null -ne $state.pendingEntry) { throw "Sideway state still contains a durable pending entry; account switch is blocked." }
    if ($item.label -eq "Trend" -and $null -ne $state.pendingPullback) { throw "Trend state still contains a pending pullback; account switch is blocked." }
  }
  $lockPath = Join-Path $WorkDir "phase7c-executors\phase7c-execution.lock"
  if (Test-Path $lockPath) { throw "Phase7C execution lock is present; account switch is blocked." }
}

function Bridge-Request([string]$Path, $EnvInfo) {
  $base = "http://$($EnvInfo.bridgeHost):$($EnvInfo.bridgePort)"
  return Invoke-RestMethod -Uri "$base$Path" -Headers @{ "x-mt5-api-key" = $EnvInfo.apiKey } -Method Get -TimeoutSec 5
}

function Get-BridgePositionCount([string]$Symbol, $EnvInfo) {
  $base = "http://$($EnvInfo.bridgeHost):$($EnvInfo.bridgePort)"
  $escapedSymbol = [uri]::EscapeDataString($Symbol)
  $response = Invoke-WebRequest -Uri "$base/v1/positions?symbol=$escapedSymbol" -Headers @{ "x-mt5-api-key" = $EnvInfo.apiKey } -UseBasicParsing -TimeoutSec 5
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return 0 }
  $parsed = $raw | ConvertFrom-Json
  $items = @($parsed | Where-Object { $null -ne $_ })
  return [int]$items.Count
}

function Assert-CurrentBrokerFlat($State) {
  $mode = ConvertTo-Phase7CAccountMode ([string]$State.accountMode)
  $envPath = Resolve-ProjectFile ([string]$State.envFile)
  $currentEnv = Assert-Phase7CAccountEnv -EnvFile $envPath -AccountMode $mode -RequireTrading
  $health = Bridge-Request "/health" $currentEnv
  $expected = if ($mode -eq "LIVE") { "real" } else { "demo" }
  if (-not $health.connected -or $health.status -ne "ok" -or [string]$health.accountMode -ne $expected) {
    throw "Current MT5 bridge does not match account-mode state; refusing switch."
  }
  if ($currentEnv.allowedLogins -notcontains [long]$health.accountLogin) { throw "Current MT5 login is not in the current account allowlist." }
  $positionCount = Get-BridgePositionCount "XAUUSD" $currentEnv
  if ($positionCount -ne 0) { throw "Account switch requires zero open XAUUSD positions. Current=$positionCount" }
  Assert-StateFlat $mode
  return [pscustomobject]@{ mode = $mode; env = $currentEnv; health = $health }
}

function Assert-LegacyBridgeTaskSafeToStop {
  $task = Get-ScheduledTask -TaskName $LegacyBridgeTaskName -ErrorAction SilentlyContinue
  if ($null -eq $task -or $task.State -ne "Running") { return }
  $actions = @($task.Actions)
  $text = if ($actions.Count -eq 1) { "$($actions[0].Execute) $($actions[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
  $projectOwned = $actions.Count -eq 1 -and (
    ($text -like "*$ProjectRoot*" -and $text -match '(?i)(phase7b.*bridge|mt5-broker.*bridge|bridge.*run\.ps1)') -or
    $text -match '(?i)run-phase7b-bridge-service-local\.ps1'
  )
  if (-not $projectOwned) { throw "Legacy bridge task is Running but ownership cannot be proven. Refusing to stop it." }
}

function Wait-ExclusiveLockReleased([string]$Path, [int]$TimeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $probe = $null
    try {
      $directory = Split-Path -Parent $Path
      if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
      $probe = [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $probe.Dispose()
      Write-Host "PHASE7C_ACCOUNT_SWITCH_LOCK_RELEASED=$Path"
      return
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 500
    } finally {
      if ($null -ne $probe) { try { $probe.Dispose() } catch {} }
    }
  } while ((Get-Date) -lt $deadline)
  throw "Timed out waiting for exclusive runner lock release: $Path"
}

function Stop-ExactVerifiedBridgeListener($CurrentEnv) {
  $port = [int]$CurrentEnv.bridgePort
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { [int]$_.LocalPort -eq $port })
  if ($listeners.Count -eq 0) { return }
  if ($listeners.Count -ne 1) { throw "Expected exactly one bridge listener on port $port; found $($listeners.Count)." }
  try {
    $health = Bridge-Request "/health" $CurrentEnv
    if ([string]::IsNullOrWhiteSpace([string]$health.status) -or [string]$health.accountMode -notin @("demo", "real")) {
      throw "Bridge health payload did not prove project ownership."
    }
  } catch { throw "Bridge listener ownership could not be proven; exact listener will not be killed. $($_.Exception.Message)" }
  $listenerPid = [int]$listeners[0].OwningProcess
  if ($listenerPid -le 0) { throw "Bridge listener PID is invalid." }
  Write-Host "PHASE7C_ACCOUNT_SWITCH_BRIDGE_LISTENER_PROOF=PASS|PORT=$port|SCOPE=LISTENER_ONLY"
  & "$env:SystemRoot\System32\taskkill.exe" /PID $listenerPid /F 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
  if (@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { [int]$_.LocalPort -eq $port }).Count -gt 0) {
    throw "Verified bridge listener did not stop cleanly."
  }
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
  if ($task.State -ne "Running") {
    throw "Executor SYSTEM lifecycle broker Scheduled Task is not Running. Current=$($task.State). Refusing implicit task boot."
  }
  $api = $ControlApiUrl.TrimEnd('/')
  $lifecycle = Invoke-RestMethod -Uri "$api/api/v1/phase7c/lifecycle" -Method Get -TimeoutSec 5
  if (-not [bool]$lifecycle.broker.ready) {
    throw "Lifecycle broker SYSTEM is not READY. Refusing account mutation."
  }
  $brokerPid = [int]$lifecycle.broker.heartbeat.brokerPid
  if ($brokerPid -le 0) { throw "Lifecycle broker SYSTEM did not publish a valid broker PID." }
  $desired = Get-ExecutorDesiredState $lifecycle
  if ([string]::IsNullOrWhiteSpace($desired)) { throw "Lifecycle broker SYSTEM did not publish desiredExecutorState." }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedDesiredState) -and $desired -ne $ExpectedDesiredState.Trim().ToUpperInvariant()) {
    throw "Lifecycle broker desiredExecutorState mismatch. Expected=$ExpectedDesiredState Actual=$desired"
  }
  return $lifecycle
}

function Stop-ExecutorsThroughLifecycle {
  $api = $ControlApiUrl.TrimEnd('/')
  $before = Assert-ExecutorLifecycleBrokerReady
  $desiredBefore = Get-ExecutorDesiredState $before
  if ($desiredBefore -eq "STOPPED" -and -not (Test-ExecutorRuntimeAlive $before)) {
    Write-Host "PHASE7C_ACCOUNT_SWITCH_LIFECYCLE_STOP=PASS|ACTION=ALREADY_STOPPED|DESIRED=STOPPED"
    return
  }

  $stopResult = Invoke-RestMethod -Uri "$api/api/v1/phase7c/lifecycle/stop" -Method Post -TimeoutSec 45
  $action = ([string]$stopResult.action).Trim().ToUpperInvariant()
  if ($action -ne "STOPPED") { throw "Canonical lifecycle STOP returned unexpected action: $action" }

  for ($i = 1; $i -le 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $status = Assert-ExecutorLifecycleBrokerReady
      if ((Get-ExecutorDesiredState $status) -eq "STOPPED" -and -not (Test-ExecutorRuntimeAlive $status)) {
        Write-Host "PHASE7C_ACCOUNT_SWITCH_LIFECYCLE_STOP=PASS|ACTION=$action|DESIRED=STOPPED"
        return
      }
    } catch {
      if ($_.Exception.Message -match 'Scheduled Task is not Running|not READY|valid broker PID') { throw }
    }
  }
  throw "Executor runtime did not reach canonical STOPPED while SYSTEM broker remained Running."
}

function Stop-BridgeStack($CurrentEnv) {
  Assert-LegacyBridgeTaskSafeToStop
  Stop-ScheduledTask -TaskName $BridgeTaskName -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName $LegacyBridgeTaskName -ErrorAction SilentlyContinue
  Wait-ExclusiveLockReleased -Path $BridgeRunnerLockPath -TimeoutSeconds 15
  Stop-ExactVerifiedBridgeListener $CurrentEnv
}

function Ensure-DemoRiskProfile {
  $demoProfilePath = Get-Phase7CRiskProfilePath $WorkDir "DEMO"
  if (Test-Path $demoProfilePath) { return }
  if (-not (Test-Path $CanonicalRiskPath)) { throw "Cannot seed DEMO risk profile because canonical lot settings are missing." }
  $current = Get-Content -LiteralPath $CanonicalRiskPath -Raw | ConvertFrom-Json
  $validated = Assert-Phase7CRiskProfile $current "Current DEMO lot settings"
  Write-Phase7CAccountJsonAtomic -Path $demoProfilePath -Value ([pscustomobject]@{
    version = 1; accountMode = "DEMO"; trendFixedLot = $validated.trendFixedLot;
    sidewayRiskPercent = $validated.sidewayRiskPercent; sidewayMaxLot = $validated.sidewayMaxLot;
    appliesTo = "NEW_POSITIONS_ONLY"; martingale = $false; recoveryLotEscalation = $false;
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o"); updatedBy = "dual-account-migration"
  }) -Depth 6
  Write-Host "PHASE7C_ACCOUNT_SWITCH_DEMO_RISK_PROFILE=SEEDED"
}

function Read-RiskProfile([string]$Mode) {
  $path = Get-Phase7CRiskProfilePath $WorkDir $Mode
  if (-not (Test-Path $path)) { throw "$Mode risk profile is missing: $path" }
  $raw = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  $profile = Assert-Phase7CRiskProfile $raw "$Mode risk profile"
  if ((ConvertTo-Phase7CAccountMode $Mode) -eq "LIVE") {
    [void](Assert-Phase7CLiveRiskProfileBinding -Profile $raw -LiveEnvFile $LiveEnvFile -Label "LIVE risk profile")
    Write-Host "PHASE7C_ACCOUNT_SWITCH_LIVE_RISK_BINDING=PASS"
  }
  return [pscustomobject]@{ path = $path; profile = $profile }
}

function Write-SelectedRuntimeFiles([string]$Mode, $EnvInfo, $Risk) {
  $profile = $Risk.profile
  Write-Phase7CAccountJsonAtomic -Path $CanonicalRiskPath -Value ([pscustomobject]@{
    version = 1; trendFixedLot = $profile.trendFixedLot; sidewayRiskPercent = $profile.sidewayRiskPercent;
    sidewayMaxLot = $profile.sidewayMaxLot; updatedAt = [DateTimeOffset]::UtcNow.ToString("o");
    updatedBy = "account-mode-switch:$Mode"
  }) -Depth 5

  Write-Phase7CAccountJsonAtomic -Path $AccountStatePath -Value ([pscustomobject]@{
    version = 1; accountMode = $Mode; liveExecutionEnabled = $Mode -eq "LIVE";
    envFile = $EnvInfo.envFile; updatedAt = [DateTimeOffset]::UtcNow.ToString("o"); updatedBy = "switch-phase7c-account-mode-local"
  }) -Depth 5

  $config = Get-Content -LiteralPath $TaskConfigPath -Raw | ConvertFrom-Json
  $configOut = [ordered]@{}
  foreach ($property in $config.PSObject.Properties) { $configOut[$property.Name] = $property.Value }
  $configOut["version"] = 2
  $configOut["accountMode"] = $Mode
  $configOut["demoOnly"] = $Mode -eq "DEMO"
  $configOut["liveExecutionEnabled"] = $Mode -eq "LIVE"
  $configOut["armed"] = $true
  $configOut["envFile"] = $EnvInfo.envFile
  $configOut["trendFixedVolume"] = $profile.trendFixedLot
  $configOut["sidewayRiskPercent"] = $profile.sidewayRiskPercent
  $configOut["sidewayMaxLot"] = $profile.sidewayMaxLot
  Write-Phase7CAccountJsonAtomic -Path $TaskConfigPath -Value ([pscustomobject]$configOut) -Depth 8
}

function Start-TargetBridge($EnvInfo, [string]$Mode) {
  Start-ScheduledTask -TaskName $BridgeTaskName -ErrorAction Stop
  $expected = if ($Mode -eq "LIVE") { "real" } else { "demo" }
  for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 2
    try {
      $health = Bridge-Request "/health" $EnvInfo
      if ($health.connected -and $health.status -eq "ok" -and [string]$health.accountMode -eq $expected) {
        if (-not [bool]$health.tradingEnabled) { throw "Target bridge trading is disabled." }
        if ($EnvInfo.allowedLogins -notcontains [long]$health.accountLogin) { throw "Target bridge login is not in the selected allowlist." }
        if ($Mode -eq "LIVE") {
          if ($null -eq $liveIdentity) { throw "Target LIVE profile identity is unavailable." }
          if ([long]$health.accountLogin -ne [long]$liveIdentity.login) {
            throw "Target LIVE bridge accountLogin does not match the explicitly configured LIVE identity."
          }
          if (-not [string]::Equals(
            ([string]$health.server).Trim(),
            ([string]$liveIdentity.server).Trim(),
            [System.StringComparison]::OrdinalIgnoreCase
          )) {
            throw "Target LIVE bridge server does not match the explicitly configured LIVE identity."
          }
        }
        $positionCount = Get-BridgePositionCount "XAUUSD" $EnvInfo
        if ($positionCount -ne 0) { throw "Target account must have zero XAUUSD positions before executor start. Current=$positionCount" }
        Write-Host "PHASE7C_ACCOUNT_SWITCH_TARGET_BRIDGE=PASS|MODE=$Mode"
        return
      }
    } catch {}
  }
  throw "Target $Mode bridge did not become healthy and verified within 60 seconds."
}

function Start-ExecutorsThroughLifecycle([string]$Mode) {
  $api = $ControlApiUrl.TrimEnd('/')
  [void](Assert-ExecutorLifecycleBrokerReady "STOPPED")
  $startResult = Invoke-RestMethod -Uri "$api/api/v1/phase7c/lifecycle/start" -Method Post -TimeoutSec 70
  $action = ([string]$startResult.action).Trim().ToUpperInvariant()
  $accountMode = ([string]$startResult.accountMode).Trim().ToUpperInvariant()
  if ($action -notin @("STARTED", "RESTARTED", "ALREADY_RUNNING")) {
    throw "Canonical lifecycle START returned unexpected action: $action"
  }
  if ($accountMode -ne $Mode) {
    throw "Canonical lifecycle START account mode mismatch. Expected=$Mode Actual=$accountMode"
  }
  Write-Host "PHASE7C_ACCOUNT_SWITCH_LIFECYCLE_START=PASS|ACTION=$action|MODE=$accountMode"

  for ($i = 1; $i -le 18; $i++) {
    Start-Sleep -Seconds 5
    try {
      & $Verifier -WorkDir $WorkDir -ExpectedAccountMode $Mode -ControlApiUrl $ControlApiUrl -RequireTelegram
      if ($LASTEXITCODE -eq 0) {
        [void](Assert-ExecutorLifecycleBrokerReady "RUNNING")
        return
      }
    } catch {}
  }
  throw "Executor runtime did not pass strict $Mode verification within startup grace."
}

$previousState = Read-AccountStateOrDefault
$previousMode = ConvertTo-Phase7CAccountMode ([string]$previousState.accountMode)
$previousRisk = $null
$previousCurrent = $null
$mutationStarted = $false

try {
  Write-Host "PHASE7C_ACCOUNT_SWITCH=START|FROM=$previousMode|TO=$TargetMode"
  [void](Set-BotPause "account-mode-switch-preflight")
  Write-Host "PHASE7C_ACCOUNT_SWITCH_PAUSE=PASS"
  $previousCurrent = Assert-CurrentBrokerFlat $previousState
  Write-Host "PHASE7C_ACCOUNT_SWITCH_CURRENT_ACCOUNT_FLAT=PASS"

  Ensure-DemoRiskProfile
  $previousRisk = Read-RiskProfile $previousMode
  $targetRisk = Read-RiskProfile $TargetMode

  if ($previousMode -eq $TargetMode) {
    Write-Host "PHASE7C_ACCOUNT_SWITCH_SAME_MODE=RESTART_SAFE_MIGRATION"
  }

  $mutationStarted = $true
  Stop-ExecutorsThroughLifecycle
  Write-Host "PHASE7C_ACCOUNT_SWITCH_EXECUTORS_STOPPED=PASS"
  Stop-BridgeStack $previousCurrent.env
  Write-Host "PHASE7C_ACCOUNT_SWITCH_BRIDGE_STOPPED=PASS"

  Write-SelectedRuntimeFiles $TargetMode $targetEnv $targetRisk
  Write-Host "PHASE7C_ACCOUNT_SWITCH_RUNTIME_CONFIG=PASS|MODE=$TargetMode"
  Start-TargetBridge $targetEnv $TargetMode
  if ($TargetMode -eq "LIVE") {
    [void](Write-Phase7CLiveAuthorizationState `
      -WorkDir $WorkDir `
      -LiveEnvFile $LiveEnvFile `
      -AuthorizedBy "switch-phase7c-account-mode-local:-ConfirmLiveExecution")
    Write-Host "PHASE7C_ACCOUNT_SWITCH_LIVE_AUTHORIZATION=PASS"
  }
  Start-ExecutorsThroughLifecycle $TargetMode
  [void](Set-BotPause "account-mode-switch-complete")

  if (-not $SkipPostSwitchSmoke) {
    & $Smoke -WorkDir $WorkDir -ExpectedAccountMode $TargetMode -ControlApiUrl $ControlApiUrl
    if ($LASTEXITCODE -ne 0) { throw "Post-switch smoke failed." }
  }

  $finalMode = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
  if ([string]$finalMode.state.mode -ne "PAUSE") { throw "Account switch must finish in PAUSE." }

  Write-Host "PHASE7C_ACCOUNT_SWITCH_FINAL_ACCOUNT_MODE=$TargetMode"
  Write-Host "PHASE7C_ACCOUNT_SWITCH_FINAL_BOT_MODE=PAUSE"
  Write-Host "PHASE7C_ACCOUNT_SWITCH_STATUS=PASS"
} catch {
  $failure = $_.Exception.Message
  Write-Host "PHASE7C_ACCOUNT_SWITCH_STATUS=FAIL|DETAIL=$failure"
  try { [void](Set-BotPause "account-mode-switch-failure") } catch {}
  if ($mutationStarted -and $null -ne $previousCurrent -and $null -ne $previousRisk) {
    Write-Host "PHASE7C_ACCOUNT_SWITCH_ROLLBACK=START|MODE=$previousMode"
    try {
      Stop-ExecutorsThroughLifecycle
      Stop-ScheduledTask -TaskName $BridgeTaskName -ErrorAction SilentlyContinue
      Wait-ExclusiveLockReleased -Path $BridgeRunnerLockPath -TimeoutSeconds 15
      Write-SelectedRuntimeFiles $previousMode $previousCurrent.env $previousRisk
      Start-TargetBridge $previousCurrent.env $previousMode
      Start-ExecutorsThroughLifecycle $previousMode
      [void](Set-BotPause "account-mode-switch-rollback")
      Write-Host "PHASE7C_ACCOUNT_SWITCH_ROLLBACK=PASS|BOT_MODE=PAUSE"
    } catch {
      Write-Host "PHASE7C_ACCOUNT_SWITCH_ROLLBACK=FAIL|KEEP_PAUSE_AND_INSPECT"
    }
  }
  throw
}