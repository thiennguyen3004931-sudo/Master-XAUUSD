param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [switch]$SkipBuild,
  [switch]$ArmExecutors,
  [double]$TrendFixedVolume = 0.03,
  [double]$SidewayRiskPercent = 0.25,
  [double]$SidewayMaxLot = 0.03,
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$DemoDir = Join-Path $WorkDir "phase7b-demo-forward"
$LotSettingsPath = Join-Path $WorkDir "phase7c-lot-settings.json"
$BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
$LegacyBotTask = "XAUUSD-Phase7B-Bot"
$ExecutorSupervisor = Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1"
$ExecutorStopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"
$ExecutorRuntime = Join-Path $WorkDir "phase7c-executors"

if (-not (Test-Path $BridgeEnv)) { throw "Bridge env not found: $BridgeEnv" }
if (-not (Test-Path $ExecutorSupervisor)) { throw "Phase 7C executor supervisor not found: $ExecutorSupervisor" }
if (-not (Test-Path $ExecutorStopper)) { throw "Phase 7C executor stopper not found: $ExecutorStopper" }
$lotSettingsExists = Test-Path $LotSettingsPath
if ($lotSettingsExists) {
  try {
    $lotSettings = Get-Content -LiteralPath $LotSettingsPath -Raw | ConvertFrom-Json
    if ([int]$lotSettings.version -ne 1) { throw "Unsupported version $($lotSettings.version)." }
    if (-not $PSBoundParameters.ContainsKey("TrendFixedVolume")) { $TrendFixedVolume = [double]$lotSettings.trendFixedLot }
    if (-not $PSBoundParameters.ContainsKey("SidewayRiskPercent")) { $SidewayRiskPercent = [double]$lotSettings.sidewayRiskPercent }
    if (-not $PSBoundParameters.ContainsKey("SidewayMaxLot")) { $SidewayMaxLot = [double]$lotSettings.sidewayMaxLot }
  } catch {
    throw "Phase 7C lot settings are invalid at $LotSettingsPath. $($_.Exception.Message)"
  }
}

if ($TrendFixedVolume -lt 0.03 -or $TrendFixedVolume -gt 1.2) {
  throw "TrendFixedVolume must be between 0.03 and 1.20 lot."
}
$trendUnits = $TrendFixedVolume / 0.03
if ([math]::Abs($trendUnits - [math]::Round($trendUnits)) -gt 1e-8) {
  throw "TrendFixedVolume must use 0.03 increments so +10 can close exactly one-third."
}

if ($SidewayMaxLot -lt 0.03 -or $SidewayMaxLot -gt 1.2) {
  throw "SidewayMaxLot must be between 0.03 and 1.20 lot."
}
$sidewayCapUnits = $SidewayMaxLot / 0.03
if ([math]::Abs($sidewayCapUnits - [math]::Round($sidewayCapUnits)) -gt 1e-8) {
  throw "SidewayMaxLot must use 0.03 increments so +10 can close exactly one-third."
}
if ($SidewayRiskPercent -lt 0.01 -or $SidewayRiskPercent -gt 1) { throw "SidewayRiskPercent must be between 0.01 and 1.00 for DEMO." }

$lotSettingsExplicit =
  $PSBoundParameters.ContainsKey("TrendFixedVolume") -or
  $PSBoundParameters.ContainsKey("SidewayRiskPercent") -or
  $PSBoundParameters.ContainsKey("SidewayMaxLot")
if (-not $lotSettingsExists -or $lotSettingsExplicit) {
  $lotSettingsToWrite = [pscustomobject]@{
    version = 1
    trendFixedLot = $TrendFixedVolume
    sidewayRiskPercent = $SidewayRiskPercent
    sidewayMaxLot = $SidewayMaxLot
    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    updatedBy = "activation"
  }
  $lotJson = $lotSettingsToWrite | ConvertTo-Json -Depth 4
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($LotSettingsPath, "$lotJson`n", $utf8NoBom)
}

function Stop-TaskSafe([string]$Name) {
  try { Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue } catch {}
}

function Start-TaskSafe([string]$Name) {
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    throw "Scheduled Task is missing: $Name"
  }
  if ($task.State -eq "Disabled") {
    Enable-ScheduledTask -TaskName $Name -ErrorAction Stop | Out-Null
    Write-Host "PHASE7C_ACTIVATE_TASK_ENABLED=$Name"
  }
  Start-ScheduledTask -TaskName $Name -ErrorAction Stop
}

function Resolve-ExistingTaskName([string[]]$Candidates, [string]$Role) {
  foreach ($candidate in $Candidates) {
    if ($null -ne (Get-ScheduledTask -TaskName $candidate -ErrorAction SilentlyContinue)) {
      Write-Host "PHASE7C_ACTIVATE_${Role}_TASK=$candidate"
      return $candidate
    }
  }
  throw "Scheduled Task for $Role is missing. Tried: $($Candidates -join ', ')"
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  try {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    if (Test-Path -LiteralPath $taskkill) {
      & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
    } else {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Test-ProjectCoreCommand([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $hasProjectPath = $CommandLine.IndexOf(
    $ProjectRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0
  $hasProjectRuntimeMarker = $CommandLine -match '(?i)(run-phase7b-(web-autostart|api-runtime-local|bridge-service)\.ps1|phase7b-(api|web)-background-v\d+\.ps1|node_modules[\\/].*(vite|tsx)|mt5_bridge\.app:app)'
  $hasWorkspaceFilter = $CommandLine -match '(?i)--filter\s+["'']?@xauusd/(api|web)["'']?'
  return ($hasProjectPath -and $hasProjectRuntimeMarker) -or $hasWorkspaceFilter
}

function Stop-ProjectCoreProcesses([int[]]$Ports) {
  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byPid = @{}
  foreach ($process in $snapshot) {
    $byPid[[int]$process.ProcessId] = $process
  }

  $listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $Ports -contains [int]$_.LocalPort }
  )

  # Scope cleanup to ancestors of the exact localhost port listeners. Pick the
  # highest recognized project ancestor so taskkill /T removes pnpm/cmd/node
  # descendants together and a dev watcher cannot respawn the API.
  $roots = @()
  foreach ($listener in $listeners) {
    $cursor = [int]$listener.OwningProcess
    $rootPid = 0
    for ($depth = 0; $depth -lt 16; $depth++) {
      if (-not $byPid.ContainsKey($cursor)) { break }
      if (Test-ProjectCoreCommand ([string]$byPid[$cursor].CommandLine)) {
        $rootPid = $cursor
      }
      $parentId = [int]$byPid[$cursor].ParentProcessId
      if ($parentId -le 0) { break }
      $cursor = $parentId
    }
    if ($rootPid -gt 0) { $roots += $rootPid }
  }

  foreach ($rootPid in @($roots | Sort-Object -Unique)) {
    Write-Host "PHASE7C_ACTIVATE_CORE_TREE_STOP=PID=$rootPid"
    Stop-ProcessTree $rootPid
  }
}

function Assert-CorePortsAvailable([int[]]$Ports) {
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    Stop-ProjectCoreProcesses $Ports
    Start-Sleep -Milliseconds 500
    $listeners = @(
      Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $Ports -contains [int]$_.LocalPort }
    )
    if ($listeners.Count -eq 0) {
      Write-Host "PHASE7C_ACTIVATE_CORE_PORTS_CLEAN=PASS"
      return
    }
  }

  $remaining = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $Ports -contains [int]$_.LocalPort } |
      ForEach-Object { "PORT=$($_.LocalPort)|PID=$($_.OwningProcess)" }
  )
  throw "Phase 7C core restart could not obtain its localhost ports without killing an unrecognized process. Remaining=$($remaining -join ','). Keep PAUSE and inspect those PIDs."
}

function Stop-BotProcess {
  $runtimePath = Join-Path $DemoDir "phase7b-demo-runtime.json"
  if (-not (Test-Path $runtimePath)) { return }
  try {
    $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
    if ($null -ne $runtime.pid -and [int]$runtime.pid -gt 0) {
      Stop-Process -Id ([int]$runtime.pid) -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Read-EnvValue([string]$Name) {
  $line = Get-Content $BridgeEnv | Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if ($null -eq $line) { return "" }
  $value = ($line -split '=', 2)[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Assert-LocalIdleState {
  $statePath = Join-Path $DemoDir "phase7b-demo-state.json"
  if (-not (Test-Path $statePath)) {
    Write-Host "PHASE7C_ACTIVATE_LOCAL_STATE=NOT_FOUND"
    return
  }

  try {
    $localState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  } catch {
    throw "Could not parse Phase 7B local state at $statePath. $($_.Exception.Message)"
  }

  if ($null -ne $localState.managed) {
    throw "Phase 7C activation blocked: Phase 7B local state still contains a managed position. Do not delete the state file; reconcile the broker position first."
  }

  if (
    $localState.PSObject.Properties.Name -contains "pendingPullback" -and
    $null -ne $localState.pendingPullback
  ) {
    throw "Phase 7C activation blocked: Phase 7B local state still contains a pendingPullback setup. Do not delete the state file; let it resolve or review it first."
  }

  Write-Host "PHASE7C_ACTIVATE_LOCAL_STATE=IDLE"
}

function Start-Phase7CExecutors {
  $commonArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $ExecutorSupervisor),
    "-WorkDir", ('"{0}"' -f $WorkDir),
    "-ControlApiUrl", ('"{0}"' -f $apiUrl),
    "-EnvFile", ('"{0}"' -f $BridgeEnv),
    "-TrendFixedVolume", $TrendFixedVolume.ToString([System.Globalization.CultureInfo]::InvariantCulture),
    "-SidewayRiskPercent", $SidewayRiskPercent.ToString([System.Globalization.CultureInfo]::InvariantCulture),
    "-SidewayMaxLot", $SidewayMaxLot.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  )

  if (-not $ArmExecutors) {
    Write-Host "PHASE7C_EXECUTORS=SHADOW_PREFLIGHT"
    $preflightArgs = @($commonArgs)
    $preflightArgs += "-Once"
    & powershell.exe @preflightArgs
    if ($LASTEXITCODE -ne 0) { throw "Phase 7C executor shadow/preflight failed with exit code $LASTEXITCODE" }
    Write-Host "PHASE7C_EXECUTORS_SHADOW=PASS"
  }

  $supervisorArgs = @($commonArgs)
  if ($ArmExecutors) {
    $supervisorArgs += "-Armed"
  }
  New-Item -ItemType Directory -Force -Path $ExecutorRuntime | Out-Null
  $supervisorOut = Join-Path $ExecutorRuntime "supervisor.out.log"
  $supervisorErr = Join-Path $ExecutorRuntime "supervisor.err.log"
  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $supervisorArgs -WorkingDirectory $ProjectRoot -RedirectStandardOutput $supervisorOut -RedirectStandardError $supervisorErr -PassThru
  Start-Sleep -Seconds 5
  $process.Refresh()
  if ($process.HasExited) {
    throw "Phase 7C executor supervisor exited during startup with code $($process.ExitCode). Check $supervisorErr"
  }
  Write-Host "PHASE7C_EXECUTOR_SUPERVISOR_PID=$($process.Id)"
  if ($ArmExecutors) {
    Write-Host "PHASE7C_EXECUTORS_ARMED=YES"
  } else {
    Write-Host "PHASE7C_EXECUTORS_ARMED=NO"
    Write-Host "PHASE7C_EXECUTOR_SUPERVISOR_MODE=TELEGRAM_ONLY"
  }
}

$apiUrl = "http://127.0.0.1:$ApiPort"
$webUrl = "http://127.0.0.1:$WebPort"
$bridgeUrl = "http://127.0.0.1:$BridgePort"
$apiKey = Read-EnvValue "MT5_API_KEY"
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 16) {
  throw "MT5_API_KEY is missing/invalid in $BridgeEnv"
}

$BridgeTask = Resolve-ExistingTaskName @("XAUUSD-Phase7B-Bridge", "XAUUSD-MT5-Bridge") "BRIDGE"
$WebTask = Resolve-ExistingTaskName @("XAUUSD-Phase7B-Web") "WEB"

# Freeze every entry-capable executor before validating state. Safety is
# enforced by process/task state, never by mutating the operator's persistent
# AUTO/TREND/SIDEWAY/PAUSE selection.
Write-Host "PHASE7C_ACTIVATE_ENTRY_FREEZE=START"
Stop-TaskSafe $LegacyBotTask
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ExecutorStopper -WorkDir $WorkDir
if ($LASTEXITCODE -ne 0) { throw "Could not stop existing Phase 7C executors safely." }
Write-Host "PHASE7C_ACTIVATE_ENTRY_FREEZE_MODE=PERSISTENT_BOT_MODE_PRESERVED"
Write-Host "PHASE7C_ACTIVATE_ENTRY_FREEZE=PASS"

Write-Host "PHASE7C_ACTIVATE_PREFLIGHT=START"
$preflightSource = "API_PLUS_LOCAL_STATE"
try {
  $current = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 5
  Write-Host "PHASE7C_ACTIVATE_PREFLIGHT_API=AVAILABLE"
  Write-Host "PHASE7C_ACTIVATE_CURRENT_BOT_STATUS=$($current.botStatus)"
  $acceptedIdleStatuses = @("WAITING_SIGNAL", "READY_NOT_ARMED")
  if ([string]$current.botStatus -eq "BOT_STALE") {
    if ($current.runtime.alive -eq $true) {
      throw "BOT_STALE response is inconsistent because runtime.alive=true. Activation remains blocked."
    }
    $preflightSource = "STALE_RUNTIME_PLUS_LOCAL_STATE_PLUS_BRIDGE"
    Write-Host "PHASE7C_ACTIVATE_BOT_STALE_RECOVERY=SAFE_COLD_START_PENDING_LOCAL_AND_BROKER_CHECKS"
  } elseif ([string]$current.botStatus -eq "MT5_OFFLINE") {
    # The API can outlive a closed/stale MetaTrader5 IPC session. Executors
    # are already frozen above, so allow activation to restart only the core
    # services and then revalidate the DEMO account and every broker position
    # directly before any executor is launched.
    $preflightSource = "MT5_OFFLINE_PLUS_LOCAL_STATE_PLUS_BRIDGE"
    Write-Host "PHASE7C_ACTIVATE_MT5_OFFLINE_RECOVERY=SAFE_RESTART_PENDING_LOCAL_AND_BROKER_CHECKS"
  } elseif ($acceptedIdleStatuses -notcontains [string]$current.botStatus) {
    throw "Phase 7C activation requires an idle botStatus in [WAITING_SIGNAL, READY_NOT_ARMED]. Current=$($current.botStatus)"
  } else {
    Write-Host "PHASE7C_ACTIVATE_PREFLIGHT_BOT_STATUS=SAFE_IDLE"
  }
  if ($null -ne $current.mt5.managedPosition) {
    throw "Managed XAUUSD position is present. Activation is blocked until the trade is closed."
  }
} catch {
  $message = $_.Exception.Message
  if (
    $message -like "*requires an idle botStatus*" -or
    $message -like "*Managed XAUUSD*" -or
    $message -like "*BOT_STALE response is inconsistent*"
  ) { throw }
  $preflightSource = "COLD_START_LOCAL_STATE_PLUS_BRIDGE"
  Write-Host "PHASE7C_ACTIVATE_PREFLIGHT_API=UNAVAILABLE_COLD_START"
  Write-Host "PHASE7C_ACTIVATE_PREFLIGHT_API_DETAIL=$message"
}

Assert-LocalIdleState
Write-Host "PHASE7C_ACTIVATE_PREFLIGHT_SOURCE=$preflightSource"
Write-Host "PHASE7C_ACTIVATE_PREFLIGHT_LOCAL=PASS"

if (-not $SkipBuild) {
  Push-Location $ProjectRoot
  try {
    Write-Host "PHASE7C_ACTIVATE_API_BUILD=START"
    & pnpm --filter '@xauusd/api...' build
    if ($LASTEXITCODE -ne 0) { throw "API build failed with exit code $LASTEXITCODE" }
    Write-Host "PHASE7C_ACTIVATE_API_BUILD=PASS"

    Write-Host "PHASE7C_ACTIVATE_WEB_BUILD=START"
    & pnpm --filter '@xauusd/web...' build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed with exit code $LASTEXITCODE" }
    Write-Host "PHASE7C_ACTIVATE_WEB_BUILD=PASS"
  } finally {
    Pop-Location
  }
}

Write-Host "PHASE7C_ACTIVATE_RESTART=START"
# Raw Phase 7B executor must never run beside the Phase 7C gated executors.
Stop-TaskSafe $LegacyBotTask
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ExecutorStopper -WorkDir $WorkDir
if ($LASTEXITCODE -ne 0) { throw "Could not stop existing Phase 7C executors safely during restart." }
Stop-TaskSafe $WebTask
Stop-TaskSafe $BridgeTask
Stop-BotProcess
Start-Sleep -Seconds 1
Assert-CorePortsAvailable @($ApiPort, $WebPort, $BridgePort)
Start-Sleep -Seconds 1

Start-TaskSafe $BridgeTask
$bridgeDeadline = (Get-Date).AddSeconds(60)
$health = $null
while ((Get-Date) -lt $bridgeDeadline) {
  try {
    $probe = Invoke-RestMethod -Uri "$bridgeUrl/health" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 4
    if ($probe.connected -and $probe.status -eq "ok" -and $probe.accountMode -eq "demo") {
      $health = $probe
      break
    }
  } catch {}
  Start-Sleep -Seconds 2
}
if ($null -eq $health) { throw "Bridge did not become healthy on DEMO within 60 seconds." }
Write-Host "PHASE7C_ACTIVATE_BRIDGE=PASS"
Write-Host "PHASE7C_ACTIVATE_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7C_ACTIVATE_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7C_ACTIVATE_SERVER=$($health.server)"

# Broker truth is authoritative for clean activation. Always check positions,
# even when the API warm-start preflight was available. Windows PowerShell 5.1
# can preserve a JSON array returned by Invoke-RestMethod as one pipeline object,
# so capture first, then expand the variable into a normal PowerShell array.
$positionsResponse = Invoke-RestMethod -Uri "$bridgeUrl/v1/positions?symbol=XAUUSD" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 10
$positions = @($positionsResponse | Where-Object { $null -ne $_ })
if ($positions.Count -gt 0) {
  $tickets = ($positions | ForEach-Object { $_.ticket }) -join ","
  throw "Phase 7C activation blocked: open XAUUSD broker position(s) detected. Count=$($positions.Count), tickets=$tickets. Do not delete local state; reconcile/close the position before clean activation."
}
Write-Host "PHASE7C_ACTIVATE_OPEN_XAUUSD_POSITIONS=0"
Write-Host "PHASE7C_ACTIVATE_PREFLIGHT=PASS"

# Validate broker history using the latest fully closed M15 candles. This is
# market-hours agnostic, so safe activation can run on weekends/holidays while
# still proving the MT5 history feed is available and parsable.
$history = Invoke-RestMethod -Uri "$bridgeUrl/v1/candles/XAUUSD?timeframe=M15&count=2" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 10
$historyBars = @($history).Count
if ($historyBars -lt 2) { throw "Phase 7C closed M15 candle endpoint returned insufficient data." }
Write-Host "PHASE7C_ACTIVATE_HISTORY_ENDPOINT=PASS"
Write-Host "PHASE7C_ACTIVATE_HISTORY_BARS=$historyBars"

# Web task owns the API/UI surface. Do not restart the raw Phase 7B bot task.
Start-TaskSafe $WebTask

$webDeadline = (Get-Date).AddSeconds(90)
$demo = $null
$risk = $null
$lotSettings = $null
$mode = $null
$decision = $null
$uiReady = $false
$webSelfTestStep = "scheduled-task-start"
$webSelfTestError = "No successful API/UI probe completed."
$sidewayRiskParam = $SidewayRiskPercent.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$sidewayMaxLotParam = $SidewayMaxLot.ToString([System.Globalization.CultureInfo]::InvariantCulture)
while ((Get-Date) -lt $webDeadline) {
  try {
    $webSelfTestStep = "phase7b-demo"
    $demoProbe = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 4
    $webSelfTestStep = "account-risk"
    $riskProbe = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/account-risk?riskPercent=$sidewayRiskParam&maxLot=$sidewayMaxLotParam" -Method Get -TimeoutSec 4
    $webSelfTestStep = "lot-settings"
    $lotProbe = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/lot-settings" -Method Get -TimeoutSec 4
    $webSelfTestStep = "bot-mode"
    $modeProbe = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 4
    $webSelfTestStep = "decision-monitor"
    $decisionProbe = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/decision-monitor?symbol=XAUUSD" -Method Get -TimeoutSec 8
    $webSelfTestStep = "web-ui"
    $uiProbe = Invoke-WebRequest -Uri "$webUrl/" -Method Get -UseBasicParsing -TimeoutSec 4
    if (
      $demoProbe -and
      $riskProbe -and
      $lotProbe -and
      $modeProbe -and
      $decisionProbe.source -eq "PHASE7C_CANONICAL_DECISION_OBSERVABILITY" -and
      $decisionProbe.safety.mt5PanelOrderPermission -eq "NONE" -and
      $uiProbe.StatusCode -ge 200 -and
      $uiProbe.StatusCode -lt 400
    ) {
      $demo = $demoProbe
      $risk = $riskProbe
      $lotSettings = $lotProbe
      $mode = $modeProbe
      $decision = $decisionProbe
      $uiReady = $true
      break
    }
    $webSelfTestError = "Probe response did not satisfy the Phase 7C safety contract."
  } catch {
    $webSelfTestError = $_.Exception.Message
  }
  Start-Sleep -Seconds 2
}

if ($null -eq $demo -or $null -eq $risk -or $null -eq $lotSettings -or $null -eq $mode -or $null -eq $decision -or -not $uiReady) {
  $webLogDir = Join-Path $WorkDir "phase7b-web"
  throw "Phase 7C API/UI self-test failed after restart. STEP=$webSelfTestStep DETAIL=$webSelfTestError LOGS=$webLogDir"
}
if (
  [string]$risk.source -ne "MT5_ACCOUNT_READ_ONLY" -or
  [string]$risk.safety.mode -ne "ACCOUNT_RISK_PREVIEW" -or
  $risk.safety.executionMutation -ne $false -or
  [string]$risk.safety.orderPermission -ne "NONE" -or
  [string]$risk.safety.accountMode -ne "DEMO" -or
  $risk.safety.liveExecutionEnabled -ne $false -or
  $risk.safety.accountGuardValid -ne $true
) {
  throw "Phase 7C Auto Lot safety assertion failed. source=$($risk.source) mode=$($risk.safety.mode) mutation=$($risk.safety.executionMutation) permission=$($risk.safety.orderPermission) accountMode=$($risk.safety.accountMode) liveExecution=$($risk.safety.liveExecutionEnabled) guardValid=$($risk.safety.accountGuardValid)"
}
if (
  [math]::Abs([double]$lotSettings.state.trendFixedLot - $TrendFixedVolume) -gt 1e-8 -or
  [math]::Abs([double]$lotSettings.state.sidewayRiskPercent - $SidewayRiskPercent) -gt 1e-8 -or
  [math]::Abs([double]$lotSettings.state.sidewayMaxLot - $SidewayMaxLot) -gt 1e-8
) {
  throw "Phase 7C API lot-settings runtime does not match activation WorkDir. Expected=$TrendFixedVolume/$SidewayRiskPercent/$SidewayMaxLot Actual=$($lotSettings.state.trendFixedLot)/$($lotSettings.state.sidewayRiskPercent)/$($lotSettings.state.sidewayMaxLot)"
}

Write-Host "PHASE7C_ACTIVATE_LEGACY_BOT_TASK=STOPPED_NOT_RESTARTED"
Write-Host "PHASE7C_ACTIVATE_MODE=$($mode.state.mode)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_MODE=$($risk.safety.mode)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_EXECUTION_MUTATION=$($risk.safety.executionMutation)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_SOURCE=$($risk.source)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_ORDER_PERMISSION=$($risk.safety.orderPermission)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_ACCOUNT_MODE=$($risk.safety.accountMode)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_LIVE_EXECUTION_ENABLED=$($risk.safety.liveExecutionEnabled)"
Write-Host "PHASE7C_ACTIVATE_AUTO_LOT_ACCOUNT_GUARD_VALID=$($risk.safety.accountGuardValid)"
Write-Host "PHASE7C_ACTIVATE_TREND_FIXED_LOT=$TrendFixedVolume"
Write-Host "PHASE7C_ACTIVATE_SIDEWAY_RISK_PERCENT=$SidewayRiskPercent"
Write-Host "PHASE7C_ACTIVATE_SIDEWAY_MAX_LOT=$SidewayMaxLot"
Write-Host "PHASE7C_ACTIVATE_LOT_APPLIES_TO=NEW_POSITIONS_ONLY"
Write-Host "PHASE7C_ACTIVATE_DECISION_MONITOR=PASS"
Write-Host "PHASE7C_ACTIVATE_MT5_PANEL_ORDER_PERMISSION=$($decision.safety.mt5PanelOrderPermission)"

Start-Phase7CExecutors

$activeLotDeadline = (Get-Date).AddSeconds(20)
$activeLotReady = $false
$activeLotLastDetail = "No lot-settings response received."
$expectedActiveArmed = $ArmExecutors.IsPresent
while ((Get-Date) -lt $activeLotDeadline) {
  try {
    $activeProbe = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7c/lot-settings" -Method Get -TimeoutSec 4
    $activeLotLastDetail = "ACTIVE_PRESENT=$($null -ne $activeProbe.active)|ACTIVE_ALIVE=$($activeProbe.activeAlive)|ARMED=$($activeProbe.active.armed)|RESTART_REQUIRED=$($activeProbe.restartRequired)|LOT=$($activeProbe.active.trendFixedLot)/$($activeProbe.active.sidewayRiskPercent)/$($activeProbe.active.sidewayMaxLot)"
    # An armed supervisor must make restartRequired=false. The intentional
    # TELEGRAM_ONLY shadow supervisor stays armed=false, so restartRequired=true
    # remains the fail-closed API signal while its PID/settings still prove that
    # the canonical runtime binding is correct.
    $activeArmedMatches = [bool]$activeProbe.active.armed -eq $expectedActiveArmed
    $restartStateMatches = if ($expectedActiveArmed) {
      $activeProbe.restartRequired -eq $false
    } else {
      $activeProbe.restartRequired -eq $true
    }
    if (
      $activeProbe.activeAlive -eq $true -and
      $activeArmedMatches -and
      $restartStateMatches -and
      [math]::Abs([double]$activeProbe.active.trendFixedLot - $TrendFixedVolume) -le 1e-8 -and
      [math]::Abs([double]$activeProbe.active.sidewayRiskPercent - $SidewayRiskPercent) -le 1e-8 -and
      [math]::Abs([double]$activeProbe.active.sidewayMaxLot - $SidewayMaxLot) -le 1e-8
    ) {
      $activeLotReady = $true
      break
    }
  } catch {
    $activeLotLastDetail = $_.Exception.Message
  }
  Start-Sleep -Seconds 1
}
if (-not $activeLotReady) {
  Write-Host "PHASE7C_ACTIVATE_LOT_ACTIVE_DETAIL=$activeLotLastDetail"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ExecutorStopper -WorkDir $WorkDir
  throw "Phase 7C executor active lot settings did not bind to the API runtime. DETAIL=$activeLotLastDetail Executors were stopped; keep PAUSE."
}
$activeLotMode = if ($expectedActiveArmed) { "ARMED_ACTIVE" } else { "SHADOW_BOUND_UNARMED" }
Write-Host "PHASE7C_ACTIVATE_LOT_ACTIVE=PASS|MODE=$activeLotMode"

$executorMode = if ($ArmExecutors) { "ARMED_DEMO_ONLY" } else { "SHADOW_ONLY" }
Write-Host "PHASE7C_ACTIVATE_CONTROL_CENTER=$webUrl/"
Write-Host "PHASE7C_ACTIVATE_BACKTEST=$webUrl/phase7c-backtest"
Write-Host "PHASE7C_ACTIVATE_RISK=$webUrl/phase7c-risk"
Write-Host "PHASE7C_ACTIVATE_MT5_PANEL_API=$apiUrl/api/v1/phase7c-ui/mt5?symbol=XAUUSD"
Write-Host "PHASE7C_ACTIVATE_EXECUTORS=$executorMode"
Write-Host "PHASE7C_ACTIVATE_STATUS=PASS"
