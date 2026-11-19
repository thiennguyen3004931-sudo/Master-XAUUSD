param(
  [string]$TaskName = 'XAUUSD-Phase7C-Executors',
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [Parameter(Mandatory = $true)] [string]$ExpectedTree,
  [Parameter(Mandatory = $true)] [string]$ExpectedDeploymentId,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $PSScriptRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeOwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-source-attestation.ps1'

foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary, $RuntimeSourceAttestationLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Broker provenance reconciliation required file is missing: $required"
  }
}
if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'ExpectedCommit must be an exact 40-character Git SHA.' }
if ($ExpectedTree -notmatch '^[0-9a-fA-F]{40}$') { throw 'ExpectedTree must be an exact 40-character Git tree SHA.' }
if ($ExpectedDeploymentId -notmatch '^[0-9a-fA-F]{32}$') { throw 'ExpectedDeploymentId must be an exact 32-character deployment id.' }
if ($TimeoutSeconds -lt 15 -or $TimeoutSeconds -gt 120) { throw 'TimeoutSeconds must be between 15 and 120.' }

. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary
. $RuntimeSourceAttestationLibrary

$ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
$ExpectedTree = $ExpectedTree.Trim().ToLowerInvariant()
$ExpectedDeploymentId = $ExpectedDeploymentId.Trim().ToLowerInvariant()
$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "$Label is invalid JSON: $Path. $($_.Exception.Message)" }
}

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path value is required.' }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Broker provenance reconciliation requires PowerShell Administrator for the canonical Scheduled Task stop/start.'
  }
}

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
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

function Get-SingleBridgeListenerPid([int]$Port) {
  $listeners = @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [string]$_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') }
  )
  if ($listeners.Count -ne 1) { throw "Broker provenance reconciliation requires exactly one Bridge listener on port $Port. current=$($listeners.Count)" }
  return [int]$listeners[0].OwningProcess
}

function Get-AttestationComponent($Snapshot, [string]$Name) {
  if ($null -eq $Snapshot -or $null -eq $Snapshot.components) { throw 'Runtime source attestation components are unavailable.' }
  $matches = @($Snapshot.components | Where-Object { [string]$_.component -eq $Name })
  if ($matches.Count -ne 1) { throw "Runtime source attestation must contain exactly one component '$Name'. current=$($matches.Count)" }
  return $matches[0]
}

function Get-InactiveComponentProcessContract([string]$Name) {
  if ($Name -ne 'regime-notifier') {
    throw "PID-reuse normalization is restricted to regime-notifier. component=$Name"
  }
  return [pscustomobject]@{
    pidFile = Join-Path $WorkDir 'phase7c-executors\regime-notifier.pid'
    commandLineMarkers = @('run-phase7c-regime-notifier-local.ps1', 'run-phase7c-regime-notifier.mjs')
  }
}

function Resolve-InactiveAttestationState($Component, [string]$Name) {
  if ($null -eq $Component) { throw "Inactive component evidence is missing. component=$Name" }

  if ([string]$Component.verdict -eq 'STALE' -and $Component.alive -eq $false) {
    return 'STALE_DEAD'
  }

  if ($Name -ne 'regime-notifier') {
    throw "Only regime-notifier is eligible for PID-reuse normalization. component=$Name verdict=$($Component.verdict) alive=$($Component.alive)"
  }

  if ([string]$Component.verdict -ne 'MISMATCH' -or $Component.alive -ne $true -or [int]$Component.pid -le 0) {
    throw "Inactive component is not safely classifiable. component=$Name verdict=$($Component.verdict) alive=$($Component.alive) pid=$($Component.pid)"
  }

  $allowedReasons = @('SOURCE_COMMIT_MISMATCH', 'SOURCE_TREE_MISMATCH', 'DEPLOYMENT_ID_MISMATCH')
  $reasons = @($Component.reasonCodes)
  if ($reasons.Count -eq 0) {
    throw "Inactive live mismatch requires provenance-only reasons. component=$Name"
  }
  foreach ($reason in $reasons) {
    if ([string]$reason -notin $allowedReasons) {
      throw "Inactive live mismatch contains a non-provenance reason. component=$Name reason=$reason"
    }
  }

  $contract = Get-InactiveComponentProcessContract -Name $Name
  if (Test-Path -LiteralPath ([string]$contract.pidFile) -PathType Leaf) {
    throw "Inactive PID-reuse normalization requires the canonical PID file to be absent. component=$Name path=$($contract.pidFile)"
  }

  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $attestedPidRows = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$Component.pid })
  if ($attestedPidRows.Count -ne 1) {
    throw "Inactive PID-reuse normalization requires exactly one current OS process at the attested PID. component=$Name pid=$($Component.pid) current=$($attestedPidRows.Count)"
  }

  $componentProcesses = @()
  foreach ($process in $processes) {
    $commandLine = [string]$process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }
    foreach ($marker in @($contract.commandLineMarkers)) {
      if ($commandLine.IndexOf([string]$marker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $componentProcesses += $process
        break
      }
    }
  }
  if ($componentProcesses.Count -ne 0) {
    $processIds = @($componentProcesses | ForEach-Object { [string]$_.ProcessId })
    throw "Inactive component still has a matching wrapper/child process; PID-reuse normalization blocked. component=$Name pids=$($processIds -join ',')"
  }

  $attestedPidProcess = $attestedPidRows[0]
  if ([string]::IsNullOrWhiteSpace([string]$attestedPidProcess.CommandLine)) {
    throw "Inactive PID-reuse normalization requires readable command-line identity for the reused PID. component=$Name pid=$($Component.pid)"
  }

  Write-Host "PHASE7C_BROKER_RECONCILE_INACTIVE_PID_REUSE=VERIFIED_UNRELATED|COMPONENT=$Name|PID=$($Component.pid)|PROCESS=$($attestedPidProcess.Name)"
  return 'PID_REUSED_UNRELATED'
}

function Assert-InactiveAttestations($Snapshot) {
  foreach ($name in @('supervisor', 'trend', 'sideway', 'telegram', 'regime-notifier')) {
    $component = Get-AttestationComponent -Snapshot $Snapshot -Name $name
    if ($name -eq 'regime-notifier') {
      $state = Resolve-InactiveAttestationState -Component $component -Name $name
      if ([string]$state -notin @('STALE_DEAD', 'PID_REUSED_UNRELATED')) {
        throw "Regime notifier produced an unexpected effective state. state=$state"
      }
      continue
    }
    if ([string]$component.verdict -ne 'STALE' -or $component.alive -ne $false) {
      throw "Inactive component must remain STALE/dead. component=$name verdict=$($component.verdict) alive=$($component.alive)"
    }
  }
  Write-Host 'PHASE7C_BROKER_RECONCILE_INACTIVE_ATTESTATIONS=STALE_DEAD'
}

function Assert-ApiWebExact($Snapshot, [Nullable[int]]$ExpectedApiPid, [Nullable[int]]$ExpectedWebPid) {
  $api = Get-AttestationComponent -Snapshot $Snapshot -Name 'api'
  $web = Get-AttestationComponent -Snapshot $Snapshot -Name 'web'
  if ([string]$api.verdict -ne 'EXACT_MATCH' -or $api.alive -ne $true -or [int]$api.pid -le 0) {
    throw "API attestation must be active EXACT_MATCH. verdict=$($api.verdict) alive=$($api.alive) pid=$($api.pid)"
  }
  if ([string]$web.verdict -ne 'EXACT_MATCH' -or $web.alive -ne $true -or [int]$web.pid -le 0) {
    throw "Web attestation must be active EXACT_MATCH. verdict=$($web.verdict) alive=$($web.alive) pid=$($web.pid)"
  }
  if ($null -ne $ExpectedApiPid -and [int]$api.pid -ne [int]$ExpectedApiPid) { throw 'API PID changed during broker-only reconciliation.' }
  if ($null -ne $ExpectedWebPid -and [int]$web.pid -ne [int]$ExpectedWebPid) { throw 'Web PID changed during broker-only reconciliation.' }
  return [pscustomobject]@{ api = $api; web = $web }
}

function Assert-DeploymentAttestationIdentity($Snapshot) {
  if ($null -eq $Snapshot.deployment) { throw 'Runtime-source API deployment snapshot is missing.' }
  if ([string]$Snapshot.deployment.deploymentId -ne $ExpectedDeploymentId -or
      [string]$Snapshot.deployment.sourceCommit -ne $ExpectedCommit -or
      [string]$Snapshot.deployment.sourceTree -ne $ExpectedTree -or
      [string]$Snapshot.deployment.branch -ne 'main' -or
      -not [bool]$Snapshot.deployment.worktreeClean) {
    throw 'Runtime-source API deployment identity differs from the accepted deployment.'
  }
}

function Assert-PreflightAttestation($Snapshot) {
  Assert-DeploymentAttestationIdentity -Snapshot $Snapshot
  if ([string]$Snapshot.overall -ne 'MISMATCH') { throw "Preflight attestation overall must be MISMATCH. actual=$($Snapshot.overall)" }
  $apiWeb = Assert-ApiWebExact -Snapshot $Snapshot -ExpectedApiPid $null -ExpectedWebPid $null
  Write-Host 'PHASE7C_BROKER_RECONCILE_API_ATTESTATION=EXACT_MATCH'
  Write-Host 'PHASE7C_BROKER_RECONCILE_WEB_ATTESTATION=EXACT_MATCH'

  $broker = Get-AttestationComponent -Snapshot $Snapshot -Name 'lifecycle-broker'
  if ([string]$broker.verdict -ne 'MISMATCH' -or $broker.alive -ne $true -or [int]$broker.pid -le 0) {
    throw "Lifecycle broker preflight must be live MISMATCH. verdict=$($broker.verdict) alive=$($broker.alive) pid=$($broker.pid)"
  }
  $allowedReasons = @('SOURCE_COMMIT_MISMATCH', 'SOURCE_TREE_MISMATCH', 'DEPLOYMENT_ID_MISMATCH')
  $reasons = @($broker.reasonCodes)
  if ($reasons.Count -eq 0) { throw 'Lifecycle broker mismatch must include at least one provenance reason.' }
  foreach ($reason in $reasons) {
    if ([string]$reason -notin $allowedReasons) {
      throw "Lifecycle broker mismatch contains a non-provenance reason; reconciliation blocked. reason=$reason"
    }
  }
  Write-Host "PHASE7C_BROKER_RECONCILE_BROKER_ATTESTATION=MISMATCH_PROVENANCE_ONLY|REASONS=$($reasons -join ',')"
  Assert-InactiveAttestations -Snapshot $Snapshot
  return [pscustomobject]@{
    apiPid = [int]$apiWeb.api.pid
    webPid = [int]$apiWeb.web.pid
    brokerPid = [int]$broker.pid
  }
}

function Assert-StoppedTransitionAttestation($Snapshot, [int]$ExpectedApiPid, [int]$ExpectedWebPid, [int]$ExpectedBrokerPid) {
  Assert-DeploymentAttestationIdentity -Snapshot $Snapshot
  [void](Assert-ApiWebExact -Snapshot $Snapshot -ExpectedApiPid $ExpectedApiPid -ExpectedWebPid $ExpectedWebPid)
  Assert-InactiveAttestations -Snapshot $Snapshot

  $broker = Get-AttestationComponent -Snapshot $Snapshot -Name 'lifecycle-broker'
  if ([int]$broker.pid -ne $ExpectedBrokerPid) {
    throw "Stopped transition broker PID changed. expected=$ExpectedBrokerPid actual=$($broker.pid)"
  }

  if ([string]$broker.verdict -eq 'STALE' -and $broker.alive -eq $false) {
    return 'STALE_DEAD'
  }

  if ([string]$broker.verdict -eq 'MISMATCH' -and $broker.alive -eq $true) {
    $allowedReasons = @('SOURCE_COMMIT_MISMATCH', 'SOURCE_TREE_MISMATCH', 'DEPLOYMENT_ID_MISMATCH')
    $reasons = @($broker.reasonCodes)
    if ($reasons.Count -eq 0) {
      throw 'Stopped transition live MISMATCH must retain at least one provenance reason.'
    }
    foreach ($reason in $reasons) {
      if ([string]$reason -notin $allowedReasons) {
        throw "Stopped transition contains a non-provenance mismatch reason. reason=$reason"
      }
    }
    return 'API_LIVENESS_LAG'
  }

  throw "Stopped transition produced an unexpected lifecycle-broker attestation state. verdict=$($broker.verdict) alive=$($broker.alive) reasons=$(@($broker.reasonCodes) -join ',')"
}

function Assert-PostflightAttestation($Snapshot, [int]$ExpectedApiPid, [int]$ExpectedWebPid, [int]$NewBrokerPid) {
  if ([string]$Snapshot.overall -notin @('STALE', 'MISMATCH')) { throw "Postflight attestation overall must be STALE or a locally-resolvable PID-reuse MISMATCH. actual=$($Snapshot.overall)" }
  Assert-DeploymentAttestationIdentity -Snapshot $Snapshot
  [void](Assert-ApiWebExact -Snapshot $Snapshot -ExpectedApiPid $ExpectedApiPid -ExpectedWebPid $ExpectedWebPid)
  $broker = Get-AttestationComponent -Snapshot $Snapshot -Name 'lifecycle-broker'
  if ([string]$broker.verdict -ne 'EXACT_MATCH' -or $broker.alive -ne $true -or [int]$broker.pid -ne $NewBrokerPid) {
    throw "Postflight lifecycle broker must be active EXACT_MATCH at the new PID. verdict=$($broker.verdict) alive=$($broker.alive) pid=$($broker.pid)"
  }
  if ([string]$broker.sourceCommit -ne $ExpectedCommit -or [string]$broker.deploymentId -ne $ExpectedDeploymentId) {
    throw 'Postflight lifecycle-broker attestation does not match accepted commit/deployment.'
  }
  Write-Host 'PHASE7C_BROKER_RECONCILE_BROKER_ATTESTATION=EXACT_MATCH'
  Assert-InactiveAttestations -Snapshot $Snapshot
  Write-Host 'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_EFFECTIVE_OVERALL=STALE'
}

function Assert-LifecycleStoppedState($State, [string]$Stage) {
  if ($null -eq $State) { throw "$Stage lifecycle state is missing." }
  if ([bool]$State.running -or [bool]$State.ready) { throw "$Stage requires lifecycle running=false and ready=false." }
  if ($null -eq $State.processes) { throw "$Stage lifecycle process map is unavailable." }
  $alive = @()
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) { $alive += [string]$property.Name }
  }
  if ($alive.Count -ne 0) { throw "$Stage requires zero alive lifecycle processes. alive=$($alive -join ',')" }
}

function Get-SafetySnapshot([string]$Stage) {
  $mode = Invoke-ControlGet '/api/v1/phase7c/bot-mode'
  if ([string]$mode.state.mode -ne 'PAUSE') { throw "$Stage requires BOT_MODE=PAUSE. actual=$($mode.state.mode)" }

  $arm = Invoke-ControlGet '/api/v1/phase7c-live-arm-control/capability'
  if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) {
    throw "$Stage requires LIVE ARM=DISARMED and liveExecutionArmed=false."
  }

  $lifecycle = Invoke-ControlGet '/api/v1/phase7c/lifecycle'
  Assert-LifecycleStoppedState -State $lifecycle -Stage $Stage

  $positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
  $orders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')
  if ($positions.Count -ne 0) { throw "$Stage requires XAUUSD positions=0. current=$($positions.Count)" }
  if ($orders.Count -ne 0) { throw "$Stage requires XAUUSD pending orders=0. current=$($orders.Count)" }

  $health = Invoke-BridgeGet '/health'
  if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') { throw "$Stage requires Bridge connected/ok." }
  if ([string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') { throw "$Stage requires Bridge LIVE/real." }
  $bridgeSessionId = [string]$health.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw "$Stage requires bridgeSessionId." }
  $bridgePid = Get-SingleBridgeListenerPid -Port $BridgePort

  $attestation = Invoke-ControlGet '/api/v1/phase7c/runtime-source-attestation'

  if ($Stage -eq 'PREFLIGHT') {
    Write-Host 'PHASE7C_BROKER_RECONCILE_PREFLIGHT_MODE=PAUSE'
    Write-Host 'PHASE7C_BROKER_RECONCILE_PREFLIGHT_ARM=DISARMED'
    Write-Host 'PHASE7C_BROKER_RECONCILE_PREFLIGHT_LIFECYCLE=STOPPED'
    Write-Host 'PHASE7C_BROKER_RECONCILE_PREFLIGHT_POSITIONS=0'
    Write-Host 'PHASE7C_BROKER_RECONCILE_PREFLIGHT_PENDING_ORDERS=0'
    Write-Host 'PHASE7C_BROKER_RECONCILE_PREFLIGHT_BRIDGE=PASS'
  }
  if ($Stage -eq 'POSTFLIGHT') {
    Write-Host 'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_LIFECYCLE=STOPPED'
    Write-Host 'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_MODE=PAUSE'
    Write-Host 'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_ARM=DISARMED'
    Write-Host 'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_POSITIONS=0'
    Write-Host 'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_PENDING_ORDERS=0'
  }

  return [pscustomobject]@{
    mode = 'PAUSE'
    arm = 'DISARMED'
    lifecycle = $lifecycle
    positionCount = 0
    pendingOrderCount = 0
    bridgeSessionId = $bridgeSessionId
    bridgePid = [int]$bridgePid
    attestation = $attestation
  }
}

function Assert-StableExternalIdentity($Snapshot, [string]$ExpectedBridgeSessionId, [int]$ExpectedBridgePid) {
  if ([string]$Snapshot.bridgeSessionId -ne $ExpectedBridgeSessionId) { throw 'Bridge session changed during broker-only reconciliation.' }
  if ([int]$Snapshot.bridgePid -ne $ExpectedBridgePid) { throw 'Bridge PID changed during broker-only reconciliation.' }
}

function Get-Phase7CCanonicalTaskProcessCount($Task) {
  try {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return -1 }
    $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$actions[0].Arguments))
    if ($tokens.Count -ne 5 -or -not $tokens[3].Equals('-EncodedCommand', [System.StringComparison]::OrdinalIgnoreCase)) { return -1 }
    $encodedToken = [string]$tokens[4]
    if ([string]::IsNullOrWhiteSpace($encodedToken)) { return -1 }
    $matches = @(
      Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
          ([string]$_.CommandLine).Contains($encodedToken)
        }
    )
    return [int]$matches.Count
  } catch { return -1 }
}

function Get-Phase7CRunningTaskInstanceCount([string]$Name) {
  try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $root = $service.GetFolder('\')
    $registered = $root.GetTask($Name)
    $instances = $registered.GetInstances(0)
    return [int]$instances.Count
  } catch { return -1 }
}

function Assert-CanonicalTask($Task, [string]$RunnerPath, [string]$RunnerSha256) {
  if ($null -eq $Task) { throw 'Canonical Scheduled Task is missing.' }
  if (-not (Test-Phase7CSystemTaskPrincipal $Task.Principal)) { throw 'Canonical Scheduled Task must be SYSTEM + ServiceAccount + Highest.' }
  $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $Task.Actions -ExpectedRunnerPath $RunnerPath -ExpectedRunnerSha256 $RunnerSha256
  if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired) {
    throw "Scheduled Task action ownership is not exact canonical. reason=$($ownership.reason)"
  }
  $drift = @(Get-Phase7CExecutorTaskDrift -Task $Task)
  if ($drift.Count -ne 0) { throw "Scheduled Task definition drift blocks broker-only reconciliation. drift=$($drift -join ',')" }
  Write-Host 'PHASE7C_BROKER_RECONCILE_TASK_OWNERSHIP=CANONICAL'
  Write-Host 'PHASE7C_BROKER_RECONCILE_TASK_DRIFT=NONE'
}

function Wait-TaskQuiescedAndPreviousBrokerExit([int]$PreviousBrokerPid) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 250
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $generation = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $taskQuiesced = [string]$task.State -notin @('Running', 'Queued')
    $brokerExited = $null -eq (Get-Process -Id $PreviousBrokerPid -ErrorAction SilentlyContinue)
    $lockReleased = [string]$generation.startupRunnerLockState -in @('MISSING', 'RELEASED')
    if ($taskQuiesced -and $brokerExited -and $lockReleased) { return }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Canonical Scheduled Task/broker did not quiesce after stop. previousPid=$PreviousBrokerPid"
}

function Assert-StoppedLocalGeneration($Task, $Generation, [int]$PreviousBrokerPid) {
  $processCount = Get-Phase7CCanonicalTaskProcessCount -Task $Task
  $instanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
  $oldPidAlive = $null -ne (Get-Process -Id $PreviousBrokerPid -ErrorAction SilentlyContinue)
  if ([string]$Task.State -in @('Running', 'Queued') -or
      $processCount -ne 0 -or $instanceCount -ne 0 -or $oldPidAlive -or
      [string]$Generation.statusReadState -ne 'OK' -or
      [string]$Generation.heartbeatReadState -ne 'OK' -or
      -not [bool]$Generation.brokerStatusPidMatch -or
      [int]$Generation.statusBrokerPid -ne $PreviousBrokerPid -or
      [bool]$Generation.brokerProcessAlive -or
      [string]$Generation.startupRunnerLockState -notin @('MISSING', 'RELEASED')) {
    throw "Stopped local broker proof changed before START. taskState=$($Task.State) processCount=$processCount instanceCount=$instanceCount oldPidAlive=$oldPidAlive brokerAlive=$($Generation.brokerProcessAlive) lock=$($Generation.startupRunnerLockState)"
  }
}

function Test-StoppedMidpointEligible(
  $Task,
  $Generation,
  $BrokerAttestation,
  $Deployment,
  [string]$RunnerSha256,
  [int]$CanonicalProcessCount,
  [int]$RunningTaskInstanceCount
) {
  if ($null -eq $Task -or $null -eq $Generation -or $null -eq $BrokerAttestation -or $null -eq $Deployment) { return $false }
  if ([string]$Task.State -in @('Running', 'Queued')) { return $false }
  if ($CanonicalProcessCount -ne 0 -or $RunningTaskInstanceCount -ne 0) { return $false }
  if ([string]$Generation.statusReadState -ne 'OK' -or
      [string]$Generation.heartbeatReadState -ne 'OK' -or
      -not [bool]$Generation.brokerStatusPidMatch -or
      [bool]$Generation.brokerProcessAlive -or
      [bool]$Generation.brokerHeartbeatFresh -or
      [string]$Generation.startupRunnerLockState -notin @('MISSING', 'RELEASED') -or
      [int]$Generation.statusBrokerPid -le 0) { return $false }

  try {
    $trustedRunnerSha256 = Normalize-Phase7CRunnerSha256 -Sha256 $RunnerSha256
  } catch { return $false }
  $expectedLauncherSha256 = 'sha256:' + $trustedRunnerSha256.ToLowerInvariant()
  $attestedLauncherSha256 = ([string]$BrokerAttestation.launcherSha256).Trim().ToLowerInvariant()

  if ([string]$BrokerAttestation.component -ne 'lifecycle-broker' -or
      [int]$BrokerAttestation.pid -ne [int]$Generation.statusBrokerPid -or
      $attestedLauncherSha256 -ne $expectedLauncherSha256 -or
      [string]$BrokerAttestation.configFingerprint -ne [string]$Deployment.configFingerprint) { return $false }

  $provenanceDiff =
    [string]$BrokerAttestation.deploymentId -ne [string]$Deployment.deploymentId -or
    [string]$BrokerAttestation.sourceCommit -ne [string]$Deployment.sourceCommit -or
    [string]$BrokerAttestation.sourceTree -ne [string]$Deployment.sourceTree
  return [bool]$provenanceDiff
}

function Wait-NewBrokerGeneration([int]$PreviousBrokerPid, [int]$Seconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    Start-Sleep -Milliseconds 250
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $generation = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    if ([string]$task.State -eq 'Running' -and
        [string]$generation.statusReadState -eq 'OK' -and
        [string]$generation.heartbeatReadState -eq 'OK' -and
        [bool]$generation.brokerStatusPidMatch -and
        [bool]$generation.brokerProcessAlive -and
        [bool]$generation.brokerHeartbeatFresh -and
        [string]$generation.startupRunnerLockState -eq 'HELD' -and
        [int]$generation.statusBrokerPid -gt 0 -and
        [int]$generation.statusBrokerPid -ne $PreviousBrokerPid) {
      return [int]$generation.statusBrokerPid
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  return 0
}

function Test-OrphanQueuedEligible($Task, $Generation, [string]$RunnerPath, [string]$RunnerSha256) {
  $processCount = Get-Phase7CCanonicalTaskProcessCount -Task $Task
  $instanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
  try {
    Assert-CanonicalTask -Task $Task -RunnerPath $RunnerPath -RunnerSha256 $RunnerSha256
  } catch { return $false }
  return [string]$Task.State -eq 'Queued' -and
    $processCount -eq 0 -and
    $instanceCount -eq 0 -and
    [string]$Generation.statusReadState -eq 'OK' -and
    [string]$Generation.heartbeatReadState -eq 'OK' -and
    [bool]$Generation.brokerStatusPidMatch -and
    -not [bool]$Generation.brokerProcessAlive -and
    -not [bool]$Generation.brokerHeartbeatFresh -and
    [string]$Generation.startupRunnerLockState -in @('MISSING', 'RELEASED')
}

Assert-Administrator

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Broker provenance reconciliation requires branch main. actual=$branch" }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Broker provenance reconciliation requires a clean worktree.' }
  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) { throw "Exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit" }
  $actualTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualTree -ne $ExpectedTree) { throw "Exact source tree mismatch. expected=$ExpectedTree actual=$actualTree" }
} finally {
  Pop-Location
}
Write-Host 'PHASE7C_BROKER_RECONCILE_GIT_GUARD=PASS'

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
if ([int]$config.version -ne 2) { throw 'Broker provenance reconciliation requires executor task config version 2.' }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE' -or -not [bool]$config.liveExecutionEnabled -or -not [bool]$config.armed) {
  throw 'Broker provenance reconciliation requires canonical LIVE task config with liveExecutionEnabled=true and armed=true.'
}
$WorkDir = Resolve-ProjectPath ([string]$config.workDir)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^http://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$') { throw 'Control API URL must be loopback HTTP.' }

$accountStatePath = Join-Path $WorkDir 'phase7c-account-mode.json'
$accountState = Read-JsonFile -Path $accountStatePath -Label 'Canonical account-mode state'
if ([int]$accountState.version -ne 1 -or (ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)) -ne 'LIVE' -or -not [bool]$accountState.liveExecutionEnabled) {
  throw 'Broker provenance reconciliation requires canonical LIVE account-mode state.'
}
$envFile = Resolve-ProjectPath ([string]$accountState.envFile)
$envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode 'LIVE' -RequireTrading
$BridgePort = [int]$envInfo.bridgePort
$BridgeBase = "http://$($envInfo.bridgeHost):$BridgePort"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$deployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
if ([string]$deployment.deploymentId -ne $ExpectedDeploymentId -or
    [string]$deployment.sourceCommit -ne $ExpectedCommit -or
    [string]$deployment.sourceTree -ne $ExpectedTree -or
    [string]$deployment.branch -ne 'main' -or
    -not [bool]$deployment.worktreeClean) {
  throw 'Accepted runtime-source deployment manifest does not match expected commit/tree/deployment.'
}
Write-Host 'PHASE7C_BROKER_RECONCILE_DEPLOYMENT_GUARD=PASS'

$preSafety = Get-SafetySnapshot -Stage 'PREFLIGHT'
Assert-DeploymentAttestationIdentity -Snapshot $preSafety.attestation
$bridgePidBefore = [int]$preSafety.bridgePid
$bridgeSessionBefore = [string]$preSafety.bridgeSessionId

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
$taskBefore = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Assert-CanonicalTask -Task $taskBefore -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256
$generationBefore = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir

$rawBrokerAttestationPath = Join-Path $WorkDir 'phase7c-source-attestation\components\lifecycle-broker.json'
$rawBrokerAttestation = Read-JsonFile -Path $rawBrokerAttestationPath -Label 'Lifecycle broker component attestation'

$apiPidBefore = 0
$webPidBefore = 0
$previousBrokerPid = 0
$entryMode = ''

if ([string]$taskBefore.State -eq 'Running') {
  $preAttestation = Assert-PreflightAttestation -Snapshot $preSafety.attestation
  $apiPidBefore = [int]$preAttestation.apiPid
  $webPidBefore = [int]$preAttestation.webPid

  if ([string]$generationBefore.statusReadState -ne 'OK' -or
      [string]$generationBefore.heartbeatReadState -ne 'OK' -or
      -not [bool]$generationBefore.brokerStatusPidMatch -or
      -not [bool]$generationBefore.brokerProcessAlive -or
      -not [bool]$generationBefore.brokerHeartbeatFresh -or
      [string]$generationBefore.startupRunnerLockState -ne 'HELD') {
    throw 'Current lifecycle-broker generation is not a proven healthy singleton; reconciliation blocked.'
  }
  $previousBrokerPid = [int]$generationBefore.statusBrokerPid
  if ($previousBrokerPid -le 0 -or $previousBrokerPid -ne [int]$preAttestation.brokerPid) {
    throw 'Current lifecycle-broker PID does not match attestation/runtime-generation evidence.'
  }
  Write-Host 'PHASE7C_BROKER_RECONCILE_ENTRY=RUNNING_MISMATCH'
  Write-Host 'PHASE7C_BROKER_RECONCILE_BROKER_HEARTBEAT_FRESH=TRUE'
  Write-Host 'PHASE7C_BROKER_RECONCILE_STARTUP_RUNNER_LOCK=HELD'

  # Mutation boundary: stop/start only the already-proven canonical SYSTEM Scheduled Task.
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Wait-TaskQuiescedAndPreviousBrokerExit -PreviousBrokerPid $previousBrokerPid
  Write-Host "PHASE7C_BROKER_RECONCILE_BROKER_PREVIOUS_PID_EXIT=PASS|PREVIOUS_PID=$previousBrokerPid"

  $afterStopSafety = Get-SafetySnapshot -Stage 'AFTER_STOP'
  Assert-StableExternalIdentity -Snapshot $afterStopSafety -ExpectedBridgeSessionId $bridgeSessionBefore -ExpectedBridgePid $bridgePidBefore
  $transition = Assert-StoppedTransitionAttestation -Snapshot $afterStopSafety.attestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -ExpectedBrokerPid $previousBrokerPid
  Write-Host "PHASE7C_BROKER_RECONCILE_STOPPED_TRANSITION=$transition"

  $taskStopped = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Assert-CanonicalTask -Task $taskStopped -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256
  $stoppedGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  Assert-StoppedLocalGeneration -Task $taskStopped -Generation $stoppedGeneration -PreviousBrokerPid $previousBrokerPid
  $entryMode = 'RUNNING_MISMATCH'
} else {
  $processCount = Get-Phase7CCanonicalTaskProcessCount -Task $taskBefore
  $instanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
  if (-not (Test-StoppedMidpointEligible -Task $taskBefore -Generation $generationBefore -BrokerAttestation $rawBrokerAttestation -Deployment $deployment -RunnerSha256 $trustedRunnerSha256 -CanonicalProcessCount $processCount -RunningTaskInstanceCount $instanceCount)) {
    throw "Canonical Scheduled Task is neither a healthy running provenance-mismatch broker nor the strict stopped midpoint tuple. taskState=$($taskBefore.State)"
  }

  $previousBrokerPid = [int]$generationBefore.statusBrokerPid
  $apiWeb = Assert-ApiWebExact -Snapshot $preSafety.attestation -ExpectedApiPid $null -ExpectedWebPid $null
  $apiPidBefore = [int]$apiWeb.api.pid
  $webPidBefore = [int]$apiWeb.web.pid
  $transition = Assert-StoppedTransitionAttestation -Snapshot $preSafety.attestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -ExpectedBrokerPid $previousBrokerPid
  Write-Host 'PHASE7C_BROKER_RECONCILE_ENTRY=MIDPOINT_STOPPED'
  Write-Host "PHASE7C_BROKER_RECONCILE_STOPPED_TRANSITION=$transition"
  Write-Host "PHASE7C_BROKER_RECONCILE_BROKER_PREVIOUS_PID_EXIT=PASS|PREVIOUS_PID=$previousBrokerPid"
  $entryMode = 'MIDPOINT_STOPPED'
}

# Re-prove the complete stopped/flat envelope and local broker-dead tuple immediately before START.
$beforeStartSafety = Get-SafetySnapshot -Stage 'BEFORE_START'
Assert-StableExternalIdentity -Snapshot $beforeStartSafety -ExpectedBridgeSessionId $bridgeSessionBefore -ExpectedBridgePid $bridgePidBefore
$beforeStartTransition = Assert-StoppedTransitionAttestation -Snapshot $beforeStartSafety.attestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -ExpectedBrokerPid $previousBrokerPid
Write-Host "PHASE7C_BROKER_RECONCILE_STOPPED_TRANSITION=$beforeStartTransition"
$beforeStartTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Assert-CanonicalTask -Task $beforeStartTask -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256
$beforeStartGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
Assert-StoppedLocalGeneration -Task $beforeStartTask -Generation $beforeStartGeneration -PreviousBrokerPid $previousBrokerPid

if ($entryMode -eq 'MIDPOINT_STOPPED') {
  $beforeStartRawBrokerAttestation = Read-JsonFile -Path $rawBrokerAttestationPath -Label 'Lifecycle broker component attestation'
  $beforeStartProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $beforeStartTask
  $beforeStartInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
  if (-not (Test-StoppedMidpointEligible -Task $beforeStartTask -Generation $beforeStartGeneration -BrokerAttestation $beforeStartRawBrokerAttestation -Deployment $deployment -RunnerSha256 $trustedRunnerSha256 -CanonicalProcessCount $beforeStartProcessCount -RunningTaskInstanceCount $beforeStartInstanceCount)) {
    throw 'Stopped midpoint evidence changed during immediate pre-START reproof.'
  }
  Write-Host 'PHASE7C_BROKER_RECONCILE_MIDPOINT_REPROOF=PASS'
}

Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$newBrokerPid = Wait-NewBrokerGeneration -PreviousBrokerPid $previousBrokerPid -Seconds $TimeoutSeconds

if ($newBrokerPid -le 0) {
  $orphanTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $orphanGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  $orphanSafety = Get-SafetySnapshot -Stage 'ORPHAN_QUEUED'
  Assert-StableExternalIdentity -Snapshot $orphanSafety -ExpectedBridgeSessionId $bridgeSessionBefore -ExpectedBridgePid $bridgePidBefore
  [void](Assert-StoppedTransitionAttestation -Snapshot $orphanSafety.attestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -ExpectedBrokerPid $previousBrokerPid)

  if (-not (Test-OrphanQueuedEligible -Task $orphanTask -Generation $orphanGeneration -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256)) {
    throw "Canonical task restart did not produce a fresh broker and does not match the bounded orphan-Queued recovery tuple. taskState=$($orphanTask.State)"
  }

  # Re-prove the exact tuple immediately before the single bounded queue clear/retry.
  $orphanTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $orphanGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  if (-not (Test-OrphanQueuedEligible -Task $orphanTask -Generation $orphanGeneration -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256)) {
    throw 'Orphan-Queued evidence changed during safety recheck; bounded retry blocked.'
  }

  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $clearDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $cleared = $false
  do {
    Start-Sleep -Milliseconds 250
    $clearTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $clearGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $clearProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $clearTask
    $clearInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
    if ([string]$clearTask.State -notin @('Running', 'Queued') -and
        $clearProcessCount -eq 0 -and $clearInstanceCount -eq 0 -and
        -not [bool]$clearGeneration.brokerProcessAlive -and
        [string]$clearGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED')) {
      $cleared = $true
      break
    }
  } while ([DateTime]::UtcNow -lt $clearDeadline)
  if (-not $cleared) { throw 'Bounded orphan-Queued clear did not converge safely.' }

  $retrySafety = Get-SafetySnapshot -Stage 'ORPHAN_RETRY'
  Assert-StableExternalIdentity -Snapshot $retrySafety -ExpectedBridgeSessionId $bridgeSessionBefore -ExpectedBridgePid $bridgePidBefore
  [void](Assert-StoppedTransitionAttestation -Snapshot $retrySafety.attestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -ExpectedBrokerPid $previousBrokerPid)
  $retryTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Assert-CanonicalTask -Task $retryTask -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256

  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-Host 'PHASE7C_BROKER_RECONCILE_ORPHAN_QUEUED_RETRY=ONCE'
  $newBrokerPid = Wait-NewBrokerGeneration -PreviousBrokerPid $previousBrokerPid -Seconds $TimeoutSeconds
  if ($newBrokerPid -le 0) { throw 'Single bounded orphan-Queued retry did not produce a fresh lifecycle broker.' }
}

Write-Host "PHASE7C_BROKER_RECONCILE_BROKER_NEW_PID=PASS|PREVIOUS_PID=$previousBrokerPid|NEW_PID=$newBrokerPid"

$postSafety = Get-SafetySnapshot -Stage 'POSTFLIGHT'
Assert-StableExternalIdentity -Snapshot $postSafety -ExpectedBridgeSessionId $bridgeSessionBefore -ExpectedBridgePid $bridgePidBefore
Assert-PostflightAttestation -Snapshot $postSafety.attestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -NewBrokerPid $newBrokerPid

$postTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Assert-CanonicalTask -Task $postTask -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256
$postGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
if (-not [bool]$postGeneration.brokerProcessAlive -or
    -not [bool]$postGeneration.brokerHeartbeatFresh -or
    -not [bool]$postGeneration.brokerStatusPidMatch -or
    [int]$postGeneration.statusBrokerPid -ne $newBrokerPid -or
    [string]$postGeneration.startupRunnerLockState -ne 'HELD') {
  throw 'Postflight runtime generation is not a fresh healthy canonical broker singleton.'
}

$statusPath = Join-Path $WorkDir 'phase7c-lifecycle-broker\state\status.json'
$brokerStatus = Read-JsonFile -Path $statusPath -Label 'Lifecycle broker status'
if ([int]$brokerStatus.brokerPid -ne $newBrokerPid -or [string]$brokerStatus.state -ne 'IDLE' -or [string]$brokerStatus.desiredExecutorState -ne 'STOPPED') {
  throw "Postflight broker must remain IDLE with desiredExecutorState=STOPPED. state=$($brokerStatus.state) desired=$($brokerStatus.desiredExecutorState) pid=$($brokerStatus.brokerPid)"
}

Write-Host 'PHASE7C_BROKER_RECONCILE_API_PID_UNCHANGED=TRUE'
Write-Host 'PHASE7C_BROKER_RECONCILE_WEB_PID_UNCHANGED=TRUE'
Write-Host 'PHASE7C_BROKER_RECONCILE_BRIDGE_PID_UNCHANGED=TRUE'
Write-Host 'PHASE7C_BROKER_RECONCILE_BRIDGE_SESSION_UNCHANGED=TRUE'
Write-Host 'PHASE7C_BROKER_RECONCILE_WHOLE_RUNTIME_RECONCILED=True'
Write-Host 'PHASE7C_BROKER_RECONCILE_WHOLE_RUNTIME_EXACT=False'
Write-Host 'PHASE7C_BROKER_RECONCILE_WHOLE_RUNTIME_OVERALL=STALE'
Write-Host 'PHASE7C_BROKER_RECONCILE_EXECUTORS_STARTED=False'
Write-Host 'PHASE7C_BROKER_RECONCILE_MODE_MUTATION=NONE'
Write-Host 'PHASE7C_BROKER_RECONCILE_ARM_MUTATION=NONE'
Write-Host 'PHASE7C_BROKER_RECONCILE_ORDER_MUTATION=NONE'
Write-Host 'PHASE7C_BROKER_RECONCILE_POSITION_MUTATION=NONE'
Write-Host 'PHASE7C_BROKER_RECONCILE_LIVE_TEST_ORDER=NONE'
Write-Host 'PHASE7C_BROKER_PROVENANCE_RECONCILIATION=PASS'
