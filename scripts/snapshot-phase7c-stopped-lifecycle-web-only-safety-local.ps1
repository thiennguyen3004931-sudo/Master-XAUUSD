param(
  [string]$WorkDir = '.runtime',
  [int]$ApiPort = 3711
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-source-attestation.ps1'
$ExecutorConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$ExecutorTaskName = 'XAUUSD-Phase7C-Executors'

foreach ($required in @($AccountLibrary, $OwnershipLibrary, $RuntimeSourceAttestationLibrary, $ExecutorConfigPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Stopped-lifecycle safety snapshot required file is missing: $required"
  }
}
. $AccountLibrary
. $OwnershipLibrary
. $RuntimeSourceAttestationLibrary

if ($ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw 'ApiPort is invalid.' }

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label is invalid JSON: $Path. $($_.Exception.Message)" }
}

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path value is required.' }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Invoke-ControlGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-BridgeGet([string]$Path) {
  return Invoke-RestMethod -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-LifecycleStopped($State) {
  if ($null -eq $State) { throw 'Lifecycle state is missing.' }
  if ([bool]$State.running) { throw 'Safety snapshot requires LIFECYCLE_RUNNING=false.' }
  if ([bool]$State.ready) { throw 'Safety snapshot requires LIFECYCLE_READY=false.' }
  if ($null -eq $State.processes) { throw 'Lifecycle process status is unavailable.' }

  $alive = @()
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) { $alive += [string]$property.Name }
  }
  if ($alive.Count -ne 0) {
    throw "Safety snapshot requires zero alive lifecycle processes. alive=$($alive -join ',')"
  }
}

function Get-SingleBridgeListenerPid([int]$Port) {
  $listeners = @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [string]$_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') }
  )
  if ($listeners.Count -ne 1) { throw "Safety snapshot requires exactly one Bridge listener on port $Port. current=$($listeners.Count)" }
  return [int]$listeners[0].OwningProcess
}

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Assert-CanonicalExecutorTask {
  $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
  $runnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
  $task = Get-ScheduledTask -TaskName $ExecutorTaskName -ErrorAction Stop
  if ($null -eq $task) { throw 'Safety snapshot requires the canonical Phase7C executor Scheduled Task.' }
  if (-not (Test-Phase7CSystemTaskPrincipal -Principal $task.Principal)) {
    throw 'Safety snapshot requires canonical executor task principal SYSTEM + ServiceAccount + Highest.'
  }

  $ownership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $task.Actions `
    -ExpectedRunnerPath $runnerPath `
    -ExpectedRunnerSha256 $runnerSha256
  if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired) {
    throw "Safety snapshot requires exact canonical executor task ownership. reason=$($ownership.reason)"
  }

  $drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
  if ($drift.Count -ne 0) {
    throw "Safety snapshot rejects executor Scheduled Task definition drift. drift=$($drift -join ',')"
  }

  Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_TASK_OWNERSHIP=CANONICAL'
  Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_TASK_DRIFT=NONE'
  return [pscustomobject]@{
    state = [string]$task.State
    runnerPath = [string]$runnerPath
    runnerSha256 = [string]$runnerSha256
  }
}

function Get-AttestationComponent($Snapshot, [string]$Name) {
  if ($null -eq $Snapshot -or $null -eq $Snapshot.components) {
    throw 'Safety snapshot runtime-source attestation components are unavailable.'
  }
  $matches = @($Snapshot.components | Where-Object { [string]$_.component -eq $Name })
  if ($matches.Count -ne 1) {
    throw "Safety snapshot requires exactly one runtime-source component '$Name'. current=$($matches.Count)"
  }
  return $matches[0]
}

function Resolve-RegimeNotifierInactiveState($Component) {
  if ([string]$Component.verdict -eq 'STALE' -and $Component.alive -eq $false) {
    return 'STALE_DEAD'
  }
  if ([string]$Component.verdict -ne 'MISMATCH' -or $Component.alive -ne $true -or [int]$Component.pid -le 0) {
    throw "Safety snapshot cannot classify regime-notifier as safely inactive. verdict=$($Component.verdict) alive=$($Component.alive) pid=$($Component.pid)"
  }

  $allowedReasons = @('SOURCE_COMMIT_MISMATCH', 'SOURCE_TREE_MISMATCH', 'DEPLOYMENT_ID_MISMATCH')
  $reasons = @($Component.reasonCodes)
  if ($reasons.Count -eq 0) {
    throw 'Safety snapshot regime-notifier PID-reuse proof requires provenance-only mismatch reasons.'
  }
  foreach ($reason in $reasons) {
    if ([string]$reason -notin $allowedReasons) {
      throw "Safety snapshot regime-notifier PID-reuse proof rejects non-provenance reason. reason=$reason"
    }
  }

  $pidFile = Join-Path $resolvedWorkDir 'phase7c-executors\regime-notifier.pid'
  if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    throw "Safety snapshot regime-notifier PID-reuse proof requires canonical PID file absent. path=$pidFile"
  }

  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $attestedPidRows = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$Component.pid })
  if ($attestedPidRows.Count -ne 1) {
    throw "Safety snapshot regime-notifier PID-reuse proof requires exactly one OS process at attested PID. pid=$($Component.pid) current=$($attestedPidRows.Count)"
  }

  $markers = @('run-phase7c-regime-notifier-local.ps1', 'run-phase7c-regime-notifier.mjs')
  $componentProcesses = @()
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
    foreach ($marker in $markers) {
      if ($commandLine.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $componentProcesses += $process
        break
      }
    }
  }
  if ($componentProcesses.Count -ne 0) {
    $processIds = @($componentProcesses | ForEach-Object { [string]$_.ProcessId })
    throw "Safety snapshot found a real regime-notifier wrapper/child process. pids=$($processIds -join ',')"
  }

  $attestedPidProcess = $attestedPidRows[0]
  if ([string]::IsNullOrWhiteSpace([string]$attestedPidProcess.CommandLine)) {
    throw "Safety snapshot regime-notifier PID-reuse proof requires readable command-line identity. pid=$($Component.pid)"
  }

  Write-Host "PHASE7C_STOPPED_WEB_SAFETY_INACTIVE_PID_REUSE=VERIFIED_UNRELATED|COMPONENT=regime-notifier|PID=$($Component.pid)|PROCESS=$($attestedPidProcess.Name)"
  return 'PID_REUSED_UNRELATED'
}

function Assert-InactiveRuntimeSourceAttestations($Snapshot) {
  foreach ($name in @('supervisor', 'trend', 'sideway', 'telegram', 'regime-notifier')) {
    $component = Get-AttestationComponent -Snapshot $Snapshot -Name $name
    if ($name -eq 'regime-notifier') {
      $state = Resolve-RegimeNotifierInactiveState -Component $component
      if ([string]$state -notin @('STALE_DEAD', 'PID_REUSED_UNRELATED')) {
        throw "Safety snapshot regime-notifier produced unexpected effective state. state=$state"
      }
      continue
    }
    if ([string]$component.verdict -ne 'STALE' -or $component.alive -ne $false) {
      throw "Safety snapshot inactive runtime-source component must be STALE/dead. component=$name verdict=$($component.verdict) alive=$($component.alive)"
    }
  }
  Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_INACTIVE_ATTESTATIONS=SAFE'
}

$executorConfig = Read-JsonFile -Path $ExecutorConfigPath -Label 'Executor task config'
if ([int]$executorConfig.version -ne 2) { throw 'Executor task config version 2 is required.' }
$resolvedWorkDir = Resolve-ProjectPath $WorkDir
$configuredWorkDir = Resolve-ProjectPath ([string]$executorConfig.workDir)
if ($resolvedWorkDir -ne $configuredWorkDir) {
  throw "WorkDir must match canonical runtime root. requested=$resolvedWorkDir configured=$configuredWorkDir"
}
$ControlApiUrl = ([string]$executorConfig.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -ne "http://127.0.0.1:$ApiPort") {
  throw "Control API URL/ApiPort mismatch. configured=$ControlApiUrl expected=http://127.0.0.1:$ApiPort"
}

$accountStatePath = Join-Path $resolvedWorkDir 'phase7c-account-mode.json'
$accountState = Read-JsonFile -Path $accountStatePath -Label 'Canonical account-mode state'
if ([int]$accountState.version -ne 1 -or (ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)) -ne 'LIVE' -or -not [bool]$accountState.liveExecutionEnabled) {
  throw 'Safety snapshot requires canonical LIVE account-mode state.'
}
$envFile = Resolve-ProjectPath ([string]$accountState.envFile)
$envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode 'LIVE' -RequireTrading
$BridgePort = [int]$envInfo.bridgePort
$BridgeBase = "http://$($envInfo.bridgeHost):$BridgePort"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$mode = Invoke-ControlGet '/api/v1/phase7c/bot-mode'
if ([string]$mode.state.mode -ne 'PAUSE') { throw "Safety snapshot requires BOT_MODE=PAUSE. actual=$($mode.state.mode)" }

$arm = Invoke-ControlGet '/api/v1/phase7c-live-arm-control/capability'
if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) {
  throw 'Safety snapshot requires ARM=DISARMED with liveExecutionArmed=false.'
}

$lifecycle = Invoke-ControlGet '/api/v1/phase7c/lifecycle'
Assert-LifecycleStopped -State $lifecycle

$positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
$orders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')
if ($positions.Count -ne 0) { throw "Safety snapshot requires POSITIONS=0. current=$($positions.Count)" }
if ($orders.Count -ne 0) { throw "Safety snapshot requires PENDING_ORDERS=0. current=$($orders.Count)" }

$health = Invoke-BridgeGet '/health'
if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') { throw 'Safety snapshot requires Bridge connected/ok.' }
if ([string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') { throw 'Safety snapshot requires Bridge LIVE/real.' }
$bridgeSessionId = [string]$health.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw 'Safety snapshot requires bridgeSessionId.' }
$bridgePid = Get-SingleBridgeListenerPid -Port $BridgePort

$taskProof = Assert-CanonicalExecutorTask
$runtimeSourceAttestation = Invoke-ControlGet '/api/v1/phase7c/runtime-source-attestation'
Assert-InactiveRuntimeSourceAttestations -Snapshot $runtimeSourceAttestation

Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_BOT_MODE=PAUSE'
Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_ARM=DISARMED'
Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_LIFECYCLE_RUNNING=false'
Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_LIFECYCLE_READY=false'
Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_POSITIONS=0'
Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_PENDING_ORDERS=0'
Write-Host "PHASE7C_STOPPED_WEB_SAFETY_BRIDGE_SESSION_ID=$bridgeSessionId"
Write-Host "PHASE7C_STOPPED_WEB_SAFETY_BRIDGE_PID=$bridgePid"
Write-Host "PHASE7C_STOPPED_WEB_SAFETY_TASK_STATE=$($taskProof.state)"
Write-Host "PHASE7C_STOPPED_WEB_SAFETY_RUNTIME_SOURCE_OVERALL=$($runtimeSourceAttestation.overall)"
Write-Host 'PHASE7C_STOPPED_WEB_SAFETY_SNAPSHOT=PASS'

[pscustomobject]@{
  mode = 'PAUSE'
  arm = 'DISARMED'
  lifecycleRunning = $false
  lifecycleReady = $false
  positionCount = 0
  pendingOrderCount = 0
  bridgeSessionId = $bridgeSessionId
  bridgePid = $bridgePid
  executorTaskOwnership = 'CANONICAL'
  executorTaskDrift = 'NONE'
  executorTaskState = [string]$taskProof.state
  inactiveAttestations = 'SAFE'
  runtimeSourceOverall = [string]$runtimeSourceAttestation.overall
}
