param(
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [string]$ProjectRoot = "",
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
} else {
  $ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
}
$ScriptsRoot = Join-Path $ProjectRoot "scripts"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$AccountLibrary = Join-Path $ScriptsRoot "lib\phase7c-account-mode.ps1"
$OwnershipLibrary = Join-Path $ScriptsRoot "lib\phase7c-scheduled-task-ownership.ps1"
$RuntimeOwnershipLibrary = Join-Path $ScriptsRoot "lib\phase7c-runtime-ownership-probe.ps1"
$RuntimeSourceAttestationLibrary = Join-Path $ScriptsRoot "lib\phase7c-runtime-source-attestation.ps1"
$TaskName = "XAUUSD-Phase7C-Executors"
$ReadyStableMs = 5000
$SystemComponents = @('lifecycle-broker','supervisor','trend','sideway','telegram','regime-notifier')
$ExpectedGenerationMismatchReasons = @('SOURCE_COMMIT_MISMATCH','SOURCE_TREE_MISMATCH','DEPLOYMENT_ID_MISMATCH')

if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw "ExpectedCommit must be an exact 40-character Git SHA."
}
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) {
  throw "TimeoutSeconds must be between 30 and 600."
}
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary, $RuntimeSourceAttestationLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Runtime source generation reconciliation required file not found: $required"
  }
}

. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary
. $RuntimeSourceAttestationLibrary

$ExpectedCommit = $ExpectedCommit.ToLowerInvariant()
$gitExe = (Get-Command git -ErrorAction Stop).Source

function Resolve-ConfigPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing: $Path"
  }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label file is invalid: $Path. $($_.Exception.Message)" }
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-ApiPost([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod `
    -Uri "$ControlApiUrl$Path" `
    -Method Post `
    -ContentType "application/json" `
    -Body $json `
    -TimeoutSec 55
}

function Set-Pause([string]$Source) {
  $mode = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$mode.state.mode -eq 'PAUSE') { return }
  $result = Invoke-ApiPost "/api/v1/phase7c/bot-mode" @{ mode = "PAUSE"; source = $Source }
  if ([string]$result.state.mode -ne "PAUSE") {
    throw "Control API did not confirm PAUSE."
  }
}

function Invoke-LiveArmAction([ValidateSet('ARM_LIVE','DISARM_LIVE')] [string]$Action) {
  $preflight = Invoke-ApiPost "/api/v1/phase7c-live-arm-control/preflight" @{ action = $Action }
  if (-not [bool]$preflight.approved -or [string]::IsNullOrWhiteSpace([string]$preflight.preflightToken)) {
    throw "$Action preflight rejected. blockedBy=$(@($preflight.blockedBy) -join ',')"
  }
  $request = Invoke-ApiPost "/api/v1/phase7c-live-arm-control/execute" @{
    action = $Action
    preflightToken = [string]$preflight.preflightToken
    confirmation = $Action
  }
  $requestId = [string]$request.requestId
  if ([string]::IsNullOrWhiteSpace($requestId)) {
    throw "$Action execute did not return requestId."
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $status = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/status?requestId=$requestId" }
    catch { continue }
    if ([string]$status.status -eq 'PASS') { return $status }
    if ([string]$status.status -eq 'FAIL') {
      throw "$Action failed. phase=$($status.phase) message=$($status.message)"
    }
  }
  throw "$Action timed out after $TimeoutSeconds seconds."
}

function Get-BridgeHealth {
  return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
}

function Assert-BridgeSession([string]$ExpectedSession, [string]$Stage) {
  $health = Get-BridgeHealth
  if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') {
    throw "$Stage bridge is not healthy."
  }
  if ([string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') {
    throw "$Stage bridge is not LIVE/real."
  }
  $actual = [string]$health.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($actual) -or $actual -ne $ExpectedSession) {
    throw "$Stage bridge session changed. expected=$ExpectedSession actual=$actual"
  }
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest `
    -Uri "$BridgeBase$Path" `
    -Headers $BridgeHeaders `
    -Method Get `
    -UseBasicParsing `
    -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-FlatBroker([string]$Stage) {
  $positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0) {
    throw "$Stage requires zero XAUUSD positions. current=$($positions.Count)"
  }
  if ($orders.Count -ne 0) {
    throw "$Stage requires zero pending XAUUSD orders. current=$($orders.Count)"
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_${Stage}_POSITIONS=0"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_${Stage}_PENDING_ORDERS=0"
}

function Test-SystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Get-BrokerPidFromHeartbeat {
  $heartbeatPath = Join-Path $WorkDir "phase7c-lifecycle-broker\state\heartbeat.json"
  if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) { return 0 }
  try {
    $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
    if ([int]$heartbeat.version -ne 1) { return 0 }
    $pid = [int]$heartbeat.brokerPid
    if ($pid -le 0) { return 0 }
    return $pid
  } catch { return 0 }
}

function Test-BrokerHeartbeatFresh {
  $heartbeatPath = Join-Path $WorkDir "phase7c-lifecycle-broker\state\heartbeat.json"
  if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) { return $false }
  try {
    $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
    if ([int]$heartbeat.version -ne 1) { return $false }
    $pid = [int]$heartbeat.brokerPid
    if ($pid -le 0 -or $null -eq (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { return $false }
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$heartbeat.updatedAt
    return $age -ge 0 -and $age -le 5000
  } catch { return $false }
}

function Wait-ProcessExit([int[]]$Pids, [string]$Stage) {
  $valid = @($Pids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($valid.Count -eq 0) { return }
  $deadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 45))
  while ((Get-Date) -lt $deadline) {
    $alive = @($valid | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
    if ($alive.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  $remaining = @($valid | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
  throw "$Stage processes did not exit. pids=$($remaining -join ',')"
}

function Test-LifecycleHasAliveProcess($State) {
  if ($null -eq $State -or $null -eq $State.processes) { return $true }
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) { return $true }
  }
  return $false
}

function Wait-LifecycleStopped {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
      $state = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
      if (-not [bool]$state.running -and -not (Test-LifecycleHasAliveProcess -State $state)) { return $state }
    } catch {}
  }
  throw "Lifecycle did not stop within $TimeoutSeconds seconds."
}

function Wait-LifecycleReadyStable {
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_READY_STABLE_MS=5000"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableSince = 0L
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $ready = $false
    try {
      $state = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
      $ready = `
        [bool]$state.running -and `
        [bool]$state.ready -and `
        [string]$state.mode.mode -eq 'PAUSE' -and `
        [string]$state.accountMode.accountMode -eq 'LIVE' -and `
        [bool]$state.accountMode.valid
    } catch { $ready = $false }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($ready) {
      if ($stableSince -le 0) { $stableSince = $now }
      if (($now - $stableSince) -ge $ReadyStableMs) { return $state }
    } else {
      $stableSince = 0L
    }
  }
  throw "Lifecycle did not remain continuously READY for 5000ms after generation reconciliation."
}

function Get-AttestationSnapshot {
  return Invoke-ApiGet "/api/v1/phase7c/runtime-source-attestation"
}

function Get-AttestationComponent($Snapshot, [string]$Name) {
  return @($Snapshot.components | Where-Object { [string]$_.component -eq $Name }) | Select-Object -First 1
}

function Assert-ApiWebExactAndSystemGenerationMismatch($Snapshot, [string]$DeploymentId) {
  $components = @($Snapshot.components)
  if ($components.Count -ne 8) {
    throw "Generation reconciliation requires exactly 8 attestation components. actual=$($components.Count)"
  }
  foreach ($name in @('api','web')) {
    $component = Get-AttestationComponent -Snapshot $Snapshot -Name $name
    if ($null -eq $component -or [string]$component.verdict -ne 'EXACT_MATCH') {
      throw "Generation reconciliation requires $name EXACT_MATCH before mutation."
    }
    if ([string]$component.sourceCommit -ne $ExpectedCommit -or [string]$component.deploymentId -ne $DeploymentId) {
      throw "Generation reconciliation requires $name on the accepted deployment identity."
    }
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_API_WEB_EXACT_PREFLIGHT=PASS"

  $oldDeploymentIds = @()
  $oldCommits = @()
  foreach ($name in $SystemComponents) {
    $component = Get-AttestationComponent -Snapshot $Snapshot -Name $name
    if ($null -eq $component -or [string]$component.verdict -ne 'MISMATCH') {
      throw "Generation reconciliation only accepts a preflight generation MISMATCH for $name. actual=$([string]$component.verdict)"
    }
    $reasons = @($component.reasonCodes | ForEach-Object { [string]$_ })
    foreach ($required in $ExpectedGenerationMismatchReasons) {
      if ($required -notin $reasons) {
        throw "Generation reconciliation $name mismatch is not the expected generation-only shape. missing=$required reasons=$($reasons -join ',')"
      }
    }
    $unexpected = @($reasons | Where-Object { $_ -notin $ExpectedGenerationMismatchReasons })
    if ($unexpected.Count -ne 0) {
      throw "Generation reconciliation refuses non-generation mismatch reasons for $name. unexpected=$($unexpected -join ',')"
    }
    if ([string]::IsNullOrWhiteSpace([string]$component.sourceCommit) -or [string]::IsNullOrWhiteSpace([string]$component.deploymentId)) {
      throw "Generation reconciliation requires complete previous generation identity for $name."
    }
    if ([string]$component.sourceCommit -eq $ExpectedCommit -or [string]$component.deploymentId -eq $DeploymentId) {
      throw "Generation reconciliation expected $name to belong to a previous generation."
    }
    $oldCommits += [string]$component.sourceCommit
    $oldDeploymentIds += [string]$component.deploymentId
  }
  if (@($oldCommits | Sort-Object -Unique).Count -ne 1 -or @($oldDeploymentIds | Sort-Object -Unique).Count -ne 1) {
    throw "Generation reconciliation requires all six SYSTEM components to share one previous generation identity."
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_SYSTEM_GENERATION_MISMATCH_PREFLIGHT=PASS"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_PREVIOUS_SOURCE_COMMIT=$($oldCommits[0])"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_PREVIOUS_DEPLOYMENT_ID=$($oldDeploymentIds[0])"
}

function Assert-FullRuntimeExact($Snapshot, [string]$DeploymentId) {
  $components = @($Snapshot.components)
  if ($components.Count -ne 8) {
    throw "Full runtime source attestation requires 8 components. actual=$($components.Count)"
  }
  $nonExact = @($components | Where-Object {
    [string]$_.verdict -ne 'EXACT_MATCH' -or
    [string]$_.sourceCommit -ne $ExpectedCommit -or
    [string]$_.deploymentId -ne $DeploymentId
  })
  if ([string]$Snapshot.overall -ne 'EXACT_MATCH' -or $nonExact.Count -ne 0) {
    $details = @($nonExact | ForEach-Object { "$($_.component):$($_.verdict):$($_.reasonCodes -join ',')" }) -join ';'
    throw "Full runtime source attestation did not converge. overall=$($Snapshot.overall) nonExact=$details"
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_FULL_RUNTIME_SOURCE_ATTESTATION=PASS"
}

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw "Runtime source generation reconciliation requires branch main. actual=$branch"
  }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Runtime source generation reconciliation requires a clean worktree."
  }
  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
    throw "Runtime source generation reconciliation exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
  $sourceTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') {
    throw "Could not resolve exact source tree for generation reconciliation."
  }
} finally {
  Pop-Location
}
Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_GIT_GUARD=PASS"
Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_EXPECTED_COMMIT=$ExpectedCommit"

$config = Read-JsonFile -Path $ConfigPath -Label "Executor task config"
if ([int]$config.version -ne 2) { throw "Generation reconciliation requires executor task config version 2." }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE') { throw "Generation reconciliation requires configured LIVE account mode." }
if (-not [bool]$config.liveExecutionEnabled) { throw "Generation reconciliation requires liveExecutionEnabled=true." }
if (-not [bool]$config.armed) { throw "Generation reconciliation requires executor task config armed=true." }

$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) { throw "Executor task controlApiUrl is missing." }

$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$deployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
if ([string]$deployment.sourceCommit -ne $ExpectedCommit -or [string]$deployment.sourceTree -ne $sourceTree -or [string]$deployment.branch -ne 'main' -or -not [bool]$deployment.worktreeClean) {
  throw "Generation reconciliation requires an already accepted deployment manifest for the exact main source."
}
$DeploymentId = [string]$deployment.deploymentId
Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_DEPLOYMENT_ID=$DeploymentId"

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskOwnership = Test-Phase7CExecutorTaskActionOwnership `
  -Actions $task.Actions `
  -ExpectedRunnerPath $runnerPath `
  -ExpectedRunnerSha256 $trustedRunnerSha256
$taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
if (-not [bool]$taskOwnership.owned -or -not [bool]$taskOwnership.canonical -or [bool]$taskOwnership.repairRequired -or $taskDrift.Count -ne 0) {
  throw "Generation reconciliation requires an exact canonical Scheduled Task. ownership=$($taskOwnership.reason) drift=$($taskDrift -join ',')"
}
if (-not (Test-SystemTaskPrincipal $task.Principal)) {
  throw "Generation reconciliation requires SYSTEM + ServiceAccount + Highest."
}
if ([string]$task.State -ne 'Running') {
  throw "Generation reconciliation requires the canonical Scheduled Task running before mutation. actual=$($task.State)"
}
Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_TASK_OWNERSHIP=PASS"
Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_TASK_RUNNER_SHA256=$trustedRunnerSha256"

$modeBefore = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
if ([string]$modeBefore.state.mode -ne 'PAUSE') {
  throw "Generation reconciliation requires current bot mode PAUSE. actual=$($modeBefore.state.mode)"
}
$armBefore = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
if ([string]$armBefore.accountMode -ne 'LIVE' -or [string]$armBefore.liveArmStatus -ne 'ARMED' -or -not [bool]$armBefore.liveExecutionArmed) {
  throw "Generation reconciliation requires LIVE ARM=ARMED before controlled reconciliation."
}
$lifecycleBefore = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
if (-not [bool]$lifecycleBefore.running -or -not [bool]$lifecycleBefore.ready) {
  throw "Generation reconciliation requires lifecycle ready/running before mutation."
}

$healthBefore = Get-BridgeHealth
if (-not [bool]$healthBefore.connected -or [string]$healthBefore.status -ne 'ok') { throw "PREFLIGHT bridge is not healthy." }
$bridgeSessionId = [string]$healthBefore.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw "PREFLIGHT bridge health is missing bridgeSessionId." }
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'PREFLIGHT'
Assert-FlatBroker -Stage 'PREFLIGHT'

$attestationBefore = Get-AttestationSnapshot
Assert-ApiWebExactAndSystemGenerationMismatch -Snapshot $attestationBefore -DeploymentId $DeploymentId
$oldSystemPids = @{}
foreach ($name in $SystemComponents) {
  $component = Get-AttestationComponent -Snapshot $attestationBefore -Name $name
  $oldSystemPids[$name] = [int]$component.pid
}

$mutationStarted = $false
try {
  $mutationStarted = $true

  [void](Invoke-LiveArmAction 'DISARM_LIVE')
  $armDisarmed = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armDisarmed.liveArmStatus -ne 'DISARMED' -or [bool]$armDisarmed.liveExecutionArmed) {
    throw "Generation reconciliation could not confirm DISARMED before lifecycle stop."
  }
  $modeFrozen = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeFrozen.state.mode -ne 'PAUSE') { throw "Generation reconciliation lost PAUSE after DISARM." }
  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_DISARM'
  Assert-FlatBroker -Stage 'POST_DISARM'
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_DISARM_LIVE=PASS"

  [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})
  [void](Wait-LifecycleStopped)
  $executorPids = @(
    [int]$oldSystemPids['supervisor'],
    [int]$oldSystemPids['trend'],
    [int]$oldSystemPids['sideway'],
    [int]$oldSystemPids['telegram'],
    [int]$oldSystemPids['regime-notifier']
  )
  Wait-ProcessExit -Pids $executorPids -Stage 'LIFECYCLE_STOP'
  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_LIFECYCLE_STOP'
  Assert-FlatBroker -Stage 'POST_LIFECYCLE_STOP'
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_LIFECYCLE_STOP=PASS"

  $taskBeforeRestart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $ownershipBeforeRestart = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $taskBeforeRestart.Actions `
    -ExpectedRunnerPath $runnerPath `
    -ExpectedRunnerSha256 $trustedRunnerSha256
  $driftBeforeRestart = @(Get-Phase7CExecutorTaskDrift -Task $taskBeforeRestart)
  if (-not [bool]$ownershipBeforeRestart.owned -or -not [bool]$ownershipBeforeRestart.canonical -or [bool]$ownershipBeforeRestart.repairRequired -or $driftBeforeRestart.Count -ne 0 -or -not (Test-SystemTaskPrincipal $taskBeforeRestart.Principal)) {
    throw "Scheduled Task ownership changed before generation restart."
  }

  $oldBrokerPid = Get-BrokerPidFromHeartbeat
  if ($oldBrokerPid -le 0 -or $oldBrokerPid -ne [int]$oldSystemPids['lifecycle-broker']) {
    throw "Generation reconciliation could not prove current broker PID against attestation. heartbeat=$oldBrokerPid attested=$($oldSystemPids['lifecycle-broker'])"
  }

  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $taskStopDeadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 30))
  $taskStopped = $false
  do {
    Start-Sleep -Milliseconds 250
    $taskAfterStop = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ([string]$taskAfterStop.State -notin @('Running','Queued')) {
      $taskStopped = $true
      break
    }
  } while ((Get-Date) -lt $taskStopDeadline)
  if (-not $taskStopped) { throw "Canonical Scheduled Task did not quiesce during generation reconciliation." }
  Wait-ProcessExit -Pids @($oldBrokerPid) -Stage 'BROKER_TASK_STOP'
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_TASK_STOP=PASS|PREVIOUS_BROKER_PID=$oldBrokerPid"

  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $taskStartDeadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 45))
  $newBrokerPid = 0
  do {
    Start-Sleep -Milliseconds 250
    $taskAfterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ([string]$taskAfterStart.State -eq 'Running' -and (Test-BrokerHeartbeatFresh)) {
      $newBrokerPid = Get-BrokerPidFromHeartbeat
      if ($newBrokerPid -gt 0 -and $newBrokerPid -ne $oldBrokerPid) { break }
    }
  } while ((Get-Date) -lt $taskStartDeadline)
  if ($newBrokerPid -le 0 -or $newBrokerPid -eq $oldBrokerPid) {
    throw "Scheduled Task restart did not produce a fresh lifecycle broker. previous=$oldBrokerPid current=$newBrokerPid"
  }

  $taskAfterRestart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $ownershipAfterRestart = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $taskAfterRestart.Actions `
    -ExpectedRunnerPath $runnerPath `
    -ExpectedRunnerSha256 $trustedRunnerSha256
  $driftAfterRestart = @(Get-Phase7CExecutorTaskDrift -Task $taskAfterRestart)
  if (-not [bool]$ownershipAfterRestart.owned -or -not [bool]$ownershipAfterRestart.canonical -or [bool]$ownershipAfterRestart.repairRequired -or $driftAfterRestart.Count -ne 0 -or -not (Test-SystemTaskPrincipal $taskAfterRestart.Principal)) {
    throw "Scheduled Task definition changed during generation reconciliation."
  }

  $brokerAttestationPath = Join-Path $WorkDir "phase7c-source-attestation\components\lifecycle-broker.json"
  $brokerAttestation = Read-JsonFile -Path $brokerAttestationPath -Label "Lifecycle broker source attestation"
  if ([string]$brokerAttestation.component -ne 'lifecycle-broker' -or `
      [string]$brokerAttestation.deploymentId -ne $DeploymentId -or `
      [string]$brokerAttestation.sourceCommit -ne $ExpectedCommit -or `
      [string]$brokerAttestation.sourceTree -ne $sourceTree -or `
      [int]$brokerAttestation.pid -ne $newBrokerPid) {
    throw "Fresh lifecycle broker attestation does not match the accepted deployment."
  }

  $lockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
  $lockState = Get-Phase7CReadOnlyLockState -Path $lockPath
  if ($lockState -ne 'HELD') {
    throw "Scheduled Task restart did not restore startup-runner singleton lock. state=$lockState"
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_TASK_RESTART=PASS|BROKER_PID=$newBrokerPid"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_STARTUP_RUNNER_LOCK=HELD"

  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_BROKER_RESTART'
  Assert-FlatBroker -Stage 'POST_BROKER_RESTART'
  $modeAfterBroker = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeAfterBroker.state.mode -ne 'PAUSE') { throw "Bot mode changed during broker generation restart." }
  $armAfterBroker = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armAfterBroker.liveArmStatus -ne 'DISARMED' -or [bool]$armAfterBroker.liveExecutionArmed) { throw "LIVE ARM changed during broker generation restart." }

  [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
  [void](Wait-LifecycleReadyStable)
  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_LIFECYCLE_START'
  Assert-FlatBroker -Stage 'POST_LIFECYCLE_START'
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_LIFECYCLE_START=PASS"

  $attestationReconciled = Get-AttestationSnapshot
  Assert-FullRuntimeExact -Snapshot $attestationReconciled -DeploymentId $DeploymentId
  foreach ($name in $SystemComponents) {
    $component = Get-AttestationComponent -Snapshot $attestationReconciled -Name $name
    if ([int]$component.pid -eq [int]$oldSystemPids[$name]) {
      throw "Generation reconciliation did not replace $name PID. pid=$($component.pid)"
    }
  }

  $modeBeforeArm = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeBeforeArm.state.mode -ne 'PAUSE') { throw "Generation reconciliation requires PAUSE before restoring ARM." }
  $armBeforeRestore = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armBeforeRestore.liveArmStatus -ne 'DISARMED' -or [bool]$armBeforeRestore.liveExecutionArmed) {
    throw "Generation reconciliation requires DISARMED immediately before ARM restore."
  }

  [void](Invoke-LiveArmAction 'ARM_LIVE')
  $armFinal = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armFinal.liveArmStatus -ne 'ARMED' -or -not [bool]$armFinal.liveExecutionArmed) {
    throw "Generation reconciliation could not restore canonical LIVE ARM."
  }
  $modeFinal = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeFinal.state.mode -ne 'PAUSE') { throw "Generation reconciliation must finish in PAUSE." }
  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'FINAL'
  Assert-FlatBroker -Stage 'FINAL'
  $attestationFinal = Get-AttestationSnapshot
  Assert-FullRuntimeExact -Snapshot $attestationFinal -DeploymentId $DeploymentId

  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_FINAL_MODE=PAUSE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_FINAL_ARM=ARMED"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_BRIDGE_SESSION_UNCHANGED=PASS"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_WEB_API_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_LIVE_TEST_ORDER=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_STATUS=PASS"
} catch {
  $originalError = $_.Exception.Message
  if ($mutationStarted) {
    try { Set-Pause 'runtime-source-generation-reconciliation-fail-closed' } catch {}
    try {
      $armNow = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
      if ([string]$armNow.liveArmStatus -ne 'DISARMED' -or [bool]$armNow.liveExecutionArmed) {
        [void](Invoke-LiveArmAction 'DISARM_LIVE')
      }
    } catch {}
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_FAIL_CLOSED_MODE=PAUSE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_WEB_API_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RECONCILIATION_LIVE_TEST_ORDER=NONE"
  throw $originalError
}
