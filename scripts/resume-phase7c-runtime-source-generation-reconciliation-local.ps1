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

if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw "ExpectedCommit must be an exact 40-character Git SHA." }
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) { throw "TimeoutSeconds must be between 30 and 600." }
foreach ($required in @($ConfigPath,$AccountLibrary,$OwnershipLibrary,$RuntimeOwnershipLibrary,$RuntimeSourceAttestationLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Fail-closed resume required file not found: $required" }
}

. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary
. $RuntimeSourceAttestationLibrary

$ExpectedCommit = $ExpectedCommit.ToLowerInvariant()
$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

function Resolve-ConfigPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-JsonFile([string]$Path,[string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label file is missing: $Path" }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label file is invalid: $Path. $($_.Exception.Message)" }
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-ApiPost([string]$Path,[object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Post -ContentType "application/json" -Body $json -TimeoutSec 55
}

function Set-Pause([string]$Source) {
  $mode = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$mode.state.mode -eq 'PAUSE') { return }
  $result = Invoke-ApiPost "/api/v1/phase7c/bot-mode" @{ mode = 'PAUSE'; source = $Source }
  if ([string]$result.state.mode -ne 'PAUSE') { throw "Control API did not confirm PAUSE." }
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
  if ([string]::IsNullOrWhiteSpace($requestId)) { throw "$Action execute did not return requestId." }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $status = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/status?requestId=$requestId" } catch { continue }
    if ([string]$status.status -eq 'PASS') { return $status }
    if ([string]$status.status -eq 'FAIL') { throw "$Action failed. phase=$($status.phase) message=$($status.message)" }
  }
  throw "$Action timed out after $TimeoutSeconds seconds."
}

function Get-BridgeHealth {
  return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
}

function Assert-BridgeSession([string]$ExpectedSession,[string]$Stage) {
  $health = Get-BridgeHealth
  if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') { throw "$Stage bridge is not healthy." }
  if ([string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') { throw "$Stage bridge is not LIVE/real." }
  $actual = [string]$health.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($actual) -or $actual -ne $ExpectedSession) { throw "$Stage bridge session changed. expected=$ExpectedSession actual=$actual" }
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-FlatBroker([string]$Stage) {
  $positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0) { throw "$Stage requires zero XAUUSD positions. current=$($positions.Count)" }
  if ($orders.Count -ne 0) { throw "$Stage requires zero pending XAUUSD orders. current=$($orders.Count)" }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_${Stage}_POSITIONS=0"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_${Stage}_PENDING_ORDERS=0"
}

function Test-SystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  return ($user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')) -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Test-LifecycleHasAliveProcess($State) {
  if ($null -eq $State -or $null -eq $State.processes) { return $false }
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) { return $true }
  }
  return $false
}

function Get-AttestationSnapshot { return Invoke-ApiGet "/api/v1/phase7c/runtime-source-attestation" }

function Get-AttestationComponent($Snapshot,[string]$Name) {
  return @($Snapshot.components | Where-Object { [string]$_.component -eq $Name }) | Select-Object -First 1
}

function Assert-ResumeAttestationShape($Snapshot,[string]$DeploymentId) {
  $components = @($Snapshot.components)
  if ($components.Count -ne 8) { throw "Fail-closed resume requires exactly 8 attestation components. actual=$($components.Count)" }
  foreach ($name in @('api','web')) {
    $component = Get-AttestationComponent $Snapshot $name
    if ($null -eq $component -or [string]$component.verdict -ne 'EXACT_MATCH') { throw "Fail-closed resume requires $name EXACT_MATCH." }
    if ([string]$component.sourceCommit -ne $ExpectedCommit -or [string]$component.deploymentId -ne $DeploymentId) { throw "Fail-closed resume requires $name on accepted deployment identity." }
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_API_WEB_EXACT_PREFLIGHT=PASS"

  $oldCommits = @()
  $oldDeployments = @()
  foreach ($name in $SystemComponents) {
    $component = Get-AttestationComponent $Snapshot $name
    if ($null -eq $component -or [string]$component.verdict -ne 'MISMATCH') { throw "Fail-closed resume requires generation MISMATCH for $name. actual=$([string]$component.verdict)" }
    $reasons = @($component.reasonCodes | ForEach-Object { [string]$_ })
    foreach ($required in $ExpectedGenerationMismatchReasons) {
      if ($required -notin $reasons) { throw "Fail-closed resume $name mismatch is missing $required. reasons=$($reasons -join ',')" }
    }
    $unexpected = @($reasons | Where-Object { $_ -notin $ExpectedGenerationMismatchReasons })
    if ($unexpected.Count -ne 0) { throw "Fail-closed resume refuses non-generation mismatch for $name. unexpected=$($unexpected -join ',')" }
    if ([string]::IsNullOrWhiteSpace([string]$component.sourceCommit) -or [string]::IsNullOrWhiteSpace([string]$component.deploymentId)) { throw "Fail-closed resume requires complete previous generation identity for $name." }
    $oldCommits += [string]$component.sourceCommit
    $oldDeployments += [string]$component.deploymentId
  }
  if (@($oldCommits | Sort-Object -Unique).Count -ne 1 -or @($oldDeployments | Sort-Object -Unique).Count -ne 1) { throw "Fail-closed resume requires all SYSTEM components to share one previous generation." }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_SYSTEM_GENERATION_MISMATCH_PREFLIGHT=PASS"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_PREVIOUS_SOURCE_COMMIT=$($oldCommits[0])"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_PREVIOUS_DEPLOYMENT_ID=$($oldDeployments[0])"
}

function Assert-FullRuntimeExact($Snapshot,[string]$DeploymentId) {
  $components = @($Snapshot.components)
  if ($components.Count -ne 8) { throw "Full runtime source attestation requires 8 components. actual=$($components.Count)" }
  $nonExact = @($components | Where-Object { [string]$_.verdict -ne 'EXACT_MATCH' -or [string]$_.sourceCommit -ne $ExpectedCommit -or [string]$_.deploymentId -ne $DeploymentId })
  if ([string]$Snapshot.overall -ne 'EXACT_MATCH' -or $nonExact.Count -ne 0) {
    $details = @($nonExact | ForEach-Object { "$($_.component):$($_.verdict):$($_.reasonCodes -join ',')" }) -join ';'
    throw "Full runtime source attestation did not converge. overall=$($Snapshot.overall) nonExact=$details"
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_RUNTIME_SOURCE_ATTESTATION_EXACT_COUNT=8/8"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_FULL_RUNTIME_SOURCE_ATTESTATION=PASS"
}

function Get-Phase7CProcessCommandLine([int]$ProcessId) {
  try {
    $item = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop | Select-Object -First 1
    if ($null -eq $item) { return '' }
    return [string]$item.CommandLine
  } catch { return '' }
}

function Get-TaskEncodedCommandToken($Task) {
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { throw "Canonical task must have exactly one action." }
  $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$actions[0].Arguments))
  if ($tokens.Count -ne 5 -or -not $tokens[3].Equals('-EncodedCommand',[System.StringComparison]::OrdinalIgnoreCase)) { throw "Canonical task action is not encoded-command V1." }
  return [string]$tokens[4]
}

function Assert-AttestedBrokerIdentity($Task,$BrokerComponent,[string]$EncodedToken,[string]$WorkDir) {
  $attestedPid = [int]$BrokerComponent.pid
  if ($attestedPid -le 0) { throw "Lifecycle broker attestation PID is invalid." }
  $process = Get-Process -Id $attestedPid -ErrorAction SilentlyContinue
  $taskState = [string]$Task.State
  $lockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
  $lockState = Get-Phase7CReadOnlyLockState -Path $lockPath

  $matching = @()
  try {
    $matching = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop | Where-Object {
      -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and ([string]$_.CommandLine).Contains($EncodedToken)
    })
  } catch { throw "Cannot enumerate canonical task process provenance. $($_.Exception.Message)" }

  if ($null -ne $process) {
    if ($taskState -ne 'Running') { throw "Attested broker PID is alive but Scheduled Task is not Running. state=$taskState pid=$attestedPid" }
    $commandLine = Get-Phase7CProcessCommandLine -ProcessId $attestedPid
    if ([string]::IsNullOrWhiteSpace($commandLine) -or -not $commandLine.Contains($EncodedToken)) { throw "Attested broker PID is not bound to the canonical Scheduled Task encoded command. pid=$attestedPid" }
    if ($matching.Count -ne 1 -or [int]$matching[0].ProcessId -ne $attestedPid) { throw "Canonical task process provenance is ambiguous. matches=$($matching.Count) attested=$attestedPid" }
    if ($lockState -ne 'HELD') { throw "Live attested broker must own startup-runner lock. state=$lockState" }
    Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BROKER_IDENTITY_PREFLIGHT=ATTESTED_PROCESS_ALIVE|PID=$attestedPid"
    return [pscustomobject]@{ pid=$attestedPid; alive=$true; taskState=$taskState }
  }

  if ($matching.Count -ne 0) { throw "Attested broker is absent but another canonical task process exists. matches=$($matching.Count)" }
  if ($taskState -in @('Running','Queued')) { throw "Attested broker is absent but Scheduled Task still reports active. state=$taskState" }
  if ($lockState -notin @('MISSING','RELEASED')) { throw "Attested broker is absent but startup-runner lock is not released. state=$lockState" }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BROKER_IDENTITY_PREFLIGHT=ATTESTED_PROCESS_ABSENT|PID=$attestedPid|TASK_STATE=$taskState"
  return [pscustomobject]@{ pid=$attestedPid; alive=$false; taskState=$taskState }
}

function Wait-TaskInactive([int]$OldPid) {
  $deadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds,45))
  while ((Get-Date) -lt $deadline) {
    $taskNow = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $oldAlive = $null -ne (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)
    if ([string]$taskNow.State -notin @('Running','Queued') -and -not $oldAlive) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Canonical Scheduled Task/broker did not become inactive. previousPid=$OldPid"
}

function Get-FreshBrokerHeartbeat {
  $heartbeatPath = Join-Path $WorkDir "phase7c-lifecycle-broker\state\heartbeat.json"
  if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) { return $null }
  try {
    $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
    if ([int]$heartbeat.version -ne 1) { return $null }
    $pid = [int]$heartbeat.brokerPid
    $updatedAt = [long]$heartbeat.updatedAt
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $updatedAt
    if ($pid -le 0 -or $age -lt 0 -or $age -gt 5000 -or $null -eq (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { return $null }
    return $heartbeat
  } catch { return $null }
}

function Wait-FreshBroker([int]$PreviousPid,[string]$EncodedToken) {
  $deadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds,60))
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $taskNow = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $heartbeat = Get-FreshBrokerHeartbeat
    if ([string]$taskNow.State -eq 'Running' -and $null -ne $heartbeat) {
      $pid = [int]$heartbeat.brokerPid
      if ($pid -gt 0 -and $pid -ne $PreviousPid) {
        $commandLine = Get-Phase7CProcessCommandLine -ProcessId $pid
        if (-not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine.Contains($EncodedToken)) { return $pid }
      }
    }
  }
  throw "Scheduled Task start did not produce a fresh canonical lifecycle broker. previous=$PreviousPid"
}

function Wait-FreshBrokerAttestation([int]$BrokerPid,[string]$DeploymentId,[string]$SourceTree) {
  $path = Join-Path $WorkDir "phase7c-source-attestation\components\lifecycle-broker.json"
  $deadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds,45))
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    try {
      $record = Read-JsonFile $path "Lifecycle broker source attestation"
      if ([string]$record.component -eq 'lifecycle-broker' -and [int]$record.pid -eq $BrokerPid -and [string]$record.deploymentId -eq $DeploymentId -and [string]$record.sourceCommit -eq $ExpectedCommit -and [string]$record.sourceTree -eq $SourceTree) { return $record }
    } catch {}
  }
  throw "Fresh lifecycle broker attestation did not match accepted deployment. pid=$BrokerPid"
}

function Wait-LifecycleReadyStable {
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_READY_STABLE_MS=5000"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableSince = 0L
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $ready = $false
    try {
      $state = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
      $ready = [bool]$state.running -and [bool]$state.ready -and [string]$state.mode.mode -eq 'PAUSE' -and [string]$state.accountMode.accountMode -eq 'LIVE' -and [bool]$state.accountMode.valid
    } catch { $ready = $false }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($ready) {
      if ($stableSince -le 0) { $stableSince = $now }
      if (($now - $stableSince) -ge $ReadyStableMs) { return $state }
    } else { $stableSince = 0L }
  }
  throw "Lifecycle did not remain continuously READY for 5000ms after fail-closed resume."
}

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Fail-closed resume requires branch main. actual=$branch" }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Fail-closed resume requires a clean worktree." }
  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) { throw "Fail-closed resume exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit" }
  $sourceTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') { throw "Could not resolve exact source tree for fail-closed resume." }
} finally { Pop-Location }
Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_GIT_GUARD=PASS"

$config = Read-JsonFile $ConfigPath "Executor task config"
if ([int]$config.version -ne 2) { throw "Fail-closed resume requires task config version 2." }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE' -or -not [bool]$config.liveExecutionEnabled -or -not [bool]$config.armed) { throw "Fail-closed resume requires canonical LIVE task config armed=true." }
$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$deployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
if ([string]$deployment.sourceCommit -ne $ExpectedCommit -or [string]$deployment.sourceTree -ne $sourceTree -or [string]$deployment.branch -ne 'main' -or -not [bool]$deployment.worktreeClean) { throw "Fail-closed resume requires accepted deployment manifest for exact main source." }
$DeploymentId = [string]$deployment.deploymentId
Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_DEPLOYMENT_ID=$DeploymentId"

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256
$taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
if (-not [bool]$taskOwnership.owned -or -not [bool]$taskOwnership.canonical -or [bool]$taskOwnership.repairRequired -or $taskDrift.Count -ne 0 -or -not (Test-SystemTaskPrincipal $task.Principal)) { throw "Fail-closed resume requires exact canonical SYSTEM task. ownership=$($taskOwnership.reason) drift=$($taskDrift -join ',')" }
$encodedToken = Get-TaskEncodedCommandToken $task
Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_TASK_OWNERSHIP=PASS"

$mode = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
if ([string]$mode.state.mode -ne 'PAUSE') { throw "Fail-closed resume requires PAUSE. actual=$($mode.state.mode)" }
$arm = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) { throw "Fail-closed resume requires LIVE PAUSE + DISARMED." }
$lifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
if ([bool]$lifecycle.running -or (Test-LifecycleHasAliveProcess $lifecycle)) { throw "Fail-closed resume requires lifecycle already stopped with no executor process alive." }

$health = Get-BridgeHealth
if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') { throw "Fail-closed resume bridge is not healthy." }
$bridgeSessionId = [string]$health.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw "Fail-closed resume bridgeSessionId is missing." }
Assert-BridgeSession $bridgeSessionId 'PREFLIGHT'
Assert-FlatBroker 'PREFLIGHT'

$attestationBefore = Get-AttestationSnapshot
Assert-ResumeAttestationShape $attestationBefore $DeploymentId
$oldSystemPids = @{}
foreach ($name in $SystemComponents) { $oldSystemPids[$name] = [int](Get-AttestationComponent $attestationBefore $name).pid }
$brokerComponent = Get-AttestationComponent $attestationBefore 'lifecycle-broker'
$brokerIdentity = Assert-AttestedBrokerIdentity $task $brokerComponent $encodedToken $WorkDir
$oldBrokerPid = [int]$brokerIdentity.pid
Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_FAIL_CLOSED_PREFLIGHT=PASS"
Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_ORDER_MUTATION=NONE"
Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_LIVE_TEST_ORDER=NONE"

$mutationStarted = $false
try {
  $mutationStarted = $true
  if ([bool]$brokerIdentity.alive) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Wait-TaskInactive $oldBrokerPid
    Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BROKER_TASK_STOP=PASS|PREVIOUS_BROKER_PID=$oldBrokerPid"
  } else {
    Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BROKER_TASK_STOP=NOOP_ALREADY_STOPPED|PREVIOUS_BROKER_PID=$oldBrokerPid"
  }

  Assert-BridgeSession $bridgeSessionId 'POST_TASK_STOP'
  Assert-FlatBroker 'POST_TASK_STOP'
  $armStill = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armStill.liveArmStatus -ne 'DISARMED' -or [bool]$armStill.liveExecutionArmed) { throw "LIVE ARM changed during fail-closed broker recovery." }

  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $newBrokerPid = Wait-FreshBroker $oldBrokerPid $encodedToken
  [void](Wait-FreshBrokerAttestation $newBrokerPid $DeploymentId $sourceTree)
  $taskAfterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $ownershipAfterStart = Test-Phase7CExecutorTaskActionOwnership -Actions $taskAfterStart.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256
  $driftAfterStart = @(Get-Phase7CExecutorTaskDrift -Task $taskAfterStart)
  if (-not [bool]$ownershipAfterStart.owned -or -not [bool]$ownershipAfterStart.canonical -or [bool]$ownershipAfterStart.repairRequired -or $driftAfterStart.Count -ne 0 -or -not (Test-SystemTaskPrincipal $taskAfterStart.Principal)) { throw "Canonical task definition changed during fail-closed resume." }
  $lockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
  if ((Get-Phase7CReadOnlyLockState -Path $lockPath) -ne 'HELD') { throw "Fresh broker did not restore startup-runner lock." }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_TASK_RESTART=PASS|BROKER_PID=$newBrokerPid"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_STARTUP_RUNNER_LOCK=HELD"

  Assert-BridgeSession $bridgeSessionId 'POST_BROKER_RESTART'
  Assert-FlatBroker 'POST_BROKER_RESTART'
  $modeAfterBroker = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeAfterBroker.state.mode -ne 'PAUSE') { throw "Bot mode changed during fail-closed broker recovery." }
  $armAfterBroker = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armAfterBroker.liveArmStatus -ne 'DISARMED' -or [bool]$armAfterBroker.liveExecutionArmed) { throw "LIVE ARM changed during fail-closed broker recovery." }

  [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
  [void](Wait-LifecycleReadyStable)
  Assert-BridgeSession $bridgeSessionId 'POST_LIFECYCLE_START'
  Assert-FlatBroker 'POST_LIFECYCLE_START'
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_LIFECYCLE_START=PASS"

  $attestationReconciled = Get-AttestationSnapshot
  Assert-FullRuntimeExact $attestationReconciled $DeploymentId
  foreach ($name in $SystemComponents) {
    $component = Get-AttestationComponent $attestationReconciled $name
    if ([int]$component.pid -eq [int]$oldSystemPids[$name]) { throw "Fail-closed resume did not replace $name PID. pid=$($component.pid)" }
  }

  $modeBeforeArm = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeBeforeArm.state.mode -ne 'PAUSE') { throw "Fail-closed resume requires PAUSE before ARM restore." }
  $armBeforeRestore = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armBeforeRestore.liveArmStatus -ne 'DISARMED' -or [bool]$armBeforeRestore.liveExecutionArmed) { throw "Fail-closed resume requires DISARMED immediately before ARM restore." }
  Assert-FlatBroker 'PRE_ARM'

  [void](Invoke-LiveArmAction 'ARM_LIVE')
  $armFinal = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armFinal.liveArmStatus -ne 'ARMED' -or -not [bool]$armFinal.liveExecutionArmed) { throw "Fail-closed resume could not restore canonical LIVE ARM." }
  $modeFinal = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeFinal.state.mode -ne 'PAUSE') { throw "Fail-closed resume must finish PAUSE." }
  Assert-BridgeSession $bridgeSessionId 'FINAL'
  Assert-FlatBroker 'FINAL'
  Assert-FullRuntimeExact (Get-AttestationSnapshot) $DeploymentId

  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_FINAL_MODE=PAUSE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_FINAL_ARM=ARMED"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BRIDGE_SESSION_UNCHANGED=PASS"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_WEB_API_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_POSITION_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_LIVE_TEST_ORDER=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_STATUS=PASS"
} catch {
  $originalError = $_.Exception.Message
  if ($mutationStarted) {
    try { Set-Pause 'runtime-source-generation-resume-fail-closed' } catch {}
    try {
      $armNow = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
      if ([string]$armNow.liveArmStatus -ne 'DISARMED' -or [bool]$armNow.liveExecutionArmed) { [void](Invoke-LiveArmAction 'DISARM_LIVE') }
    } catch {}
  }
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_FAIL_CLOSED_MODE=PAUSE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_WEB_API_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_POSITION_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_SOURCE_RESUME_LIVE_TEST_ORDER=NONE"
  throw $originalError
}
