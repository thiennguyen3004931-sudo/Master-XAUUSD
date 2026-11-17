param(
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CoreRecovery = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$OwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"
$RuntimeOwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-ownership-probe.ps1"
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
$TaskName = "XAUUSD-Phase7C-Executors"

if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw "ExpectedCommit must be an exact 40-character Git SHA."
}
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) {
  throw "TimeoutSeconds must be between 30 and 600."
}
foreach ($required in @($CoreRecovery, $ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary, $RuntimeSourceAttestationLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Guarded runtime-ready recovery required file not found: $required"
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

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-ApiPost([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Post -ContentType "application/json" -Body $json -TimeoutSec 55
}

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Get-Phase7CCanonicalTaskProcessIds($Task) {
  try {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return @(-1) }
    $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$actions[0].Arguments))
    if ($tokens.Count -ne 5 -or -not $tokens[3].Equals('-EncodedCommand', [System.StringComparison]::OrdinalIgnoreCase)) {
      return @(-1)
    }
    $encodedToken = [string]$tokens[4]
    if ([string]::IsNullOrWhiteSpace($encodedToken)) { return @(-1) }
    $matches = @(
      Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
          ([string]$_.CommandLine).Contains($encodedToken)
        }
    )
    return @($matches | ForEach-Object { [int]$_.ProcessId })
  } catch {
    return @(-1)
  }
}

function Get-Phase7CRunningTaskInstanceCount([string]$Name) {
  try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $root = $service.GetFolder('\')
    $registered = $root.GetTask($Name)
    return [int]$registered.GetInstances(0).Count
  } catch {
    return -1
  }
}

function Get-Phase7CRunningTaskInstanceProcessIds([string]$Name) {
  try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $root = $service.GetFolder('\')
    $registered = $root.GetTask($Name)
    $instances = @($registered.GetInstances(0))
    $pids = @()
    foreach ($instance in $instances) {
      $enginePid = 0
      try { $enginePid = [int]$instance.EnginePID } catch { return @(-1) }
      if ($enginePid -le 0) { return @(-1) }
      $pids += $enginePid
    }
    return @($pids)
  } catch {
    return @(-1)
  }
}

function Test-Phase7CLifecycleHasAliveProcess($State) {
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
      if (-not [bool]$state.running -and -not (Test-Phase7CLifecycleHasAliveProcess $state)) { return }
    } catch {}
  }
  throw "Guarded recovery lifecycle did not stop within $TimeoutSeconds seconds."
}

function Assert-PauseDisarmed {
  $mode = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$mode.state.mode -ne 'PAUSE') {
    throw "Guarded recovery requires current bot mode PAUSE. actual=$($mode.state.mode)"
  }
  $arm = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) {
    throw "Guarded recovery requires canonical LIVE ARM=DISARMED."
  }
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-BridgeAndFlat([string]$ExpectedSession) {
  $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
  if (-not [bool]$health.connected -or [string]$health.status -ne 'ok' -or [string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') {
    throw "Guarded recovery requires healthy LIVE/real Bridge."
  }
  if ([string]$health.bridgeSessionId -ne $ExpectedSession) {
    throw "Guarded recovery bridge session changed."
  }
  $positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0 -or $orders.Count -ne 0) {
    throw "Guarded recovery requires flat XAUUSD broker. positions=$($positions.Count) pendingOrders=$($orders.Count)"
  }
}

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw "Guarded recovery requires branch main. actual=$branch"
  }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Guarded recovery requires a clean worktree."
  }
  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
    throw "Guarded recovery exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
  $sourceTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') {
    throw "Guarded recovery could not resolve exact source tree."
  }
} finally {
  Pop-Location
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([int]$config.version -ne 2 -or (ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE' -or -not [bool]$config.liveExecutionEnabled -or -not [bool]$config.armed) {
  throw "Guarded recovery requires canonical LIVE executor config V2 with trading enabled and config armed=true."
}
$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) { throw "Guarded recovery controlApiUrl is missing." }

$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

Assert-PauseDisarmed
$bridgeHealth = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
$bridgeSessionId = [string]$bridgeHealth.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw "Guarded recovery Bridge session is missing." }
Assert-BridgeAndFlat -ExpectedSession $bridgeSessionId

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$taskOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256
$taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
if (-not [bool]$taskOwnership.owned -or -not [bool]$taskOwnership.canonical -or [bool]$taskOwnership.repairRequired -or $taskDrift.Count -ne 0 -or -not (Test-Phase7CSystemTaskPrincipal $task.Principal)) {
  throw "Guarded recovery requires an exact canonical SYSTEM executor task before held-lock pre-quiesce. ownership=$($taskOwnership.reason) drift=$($taskDrift -join ',')"
}

$configIdentity = Get-Phase7CRuntimeSourceConfigIdentity -RuntimeRoot $WorkDir -AccountMode LIVE -LiveExecutionEnabled $true -ControlApiUrl $ControlApiUrl
$previousDeployment = $null
try { $previousDeployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir } catch { $previousDeployment = $null }
$targetDeployment = Initialize-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir -SourceCommit $ExpectedCommit -SourceTree $sourceTree -Branch main -ConfigIdentity $configIdentity
$generationDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision -RuntimeRoot $WorkDir -PreviousDeployment $previousDeployment -TargetDeployment $targetDeployment
$reloadRequired = [bool]$generationDecision.reloadRequired

$runtimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
$lifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
$heldObserved = `
  $reloadRequired -and `
  [bool]$lifecycle.running -and `
  [bool]$lifecycle.ready -and `
  [string]$lifecycle.mode.mode -eq 'PAUSE' -and `
  [string]$lifecycle.accountMode.accountMode -eq 'LIVE' -and `
  [bool]$lifecycle.accountMode.valid -and `
  [string]$runtimeGeneration.startupRunnerLockState -eq 'HELD'

if ($heldObserved) {
  $runningTaskInstancePids = @(Get-Phase7CRunningTaskInstanceProcessIds -Name $TaskName)
  $brokerAttestationPath = Join-Path $WorkDir "phase7c-source-attestation\components\lifecycle-broker.json"
  if (-not (Test-Path -LiteralPath $brokerAttestationPath -PathType Leaf)) {
    throw "Guarded recovery lifecycle broker attestation is missing."
  }
  $brokerAttestation = Get-Content -LiteralPath $brokerAttestationPath -Raw | ConvertFrom-Json
  $brokerAttestationVersionValid = $null -ne $brokerAttestation.PSObject.Properties['version'] -and [int]$brokerAttestation.version -eq 1
  $brokerAttestationGenerationValid = `
    $null -ne $brokerAttestation.PSObject.Properties['deploymentId'] -and `
    $null -ne $brokerAttestation.PSObject.Properties['sourceCommit'] -and `
    $null -ne $brokerAttestation.PSObject.Properties['sourceTree'] -and `
    $null -ne $brokerAttestation.PSObject.Properties['launcherSha256'] -and `
    [string]$brokerAttestation.deploymentId -match '^[0-9a-fA-F]{32}$' -and `
    [string]$brokerAttestation.sourceCommit -match '^[0-9a-fA-F]{40}$' -and `
    [string]$brokerAttestation.sourceTree -match '^[0-9a-fA-F]{40}$' -and `
    [string]$brokerAttestation.launcherSha256 -match '^sha256:[0-9a-fA-F]{64}$'
  $brokerAttestationIsStale = `
    $brokerAttestationGenerationValid -and `
    (-not [string]::Equals([string]$brokerAttestation.deploymentId, [string]$targetDeployment.deploymentId, [System.StringComparison]::OrdinalIgnoreCase) -or `
     -not [string]::Equals([string]$brokerAttestation.sourceCommit, [string]$targetDeployment.sourceCommit, [System.StringComparison]::OrdinalIgnoreCase) -or `
     -not [string]::Equals([string]$brokerAttestation.sourceTree, [string]$targetDeployment.sourceTree, [System.StringComparison]::OrdinalIgnoreCase))

  $heldEligible = `
    [string]$task.State -eq 'Running' -and `
    [string]$runtimeGeneration.statusReadState -eq 'OK' -and `
    [string]$runtimeGeneration.heartbeatReadState -eq 'OK' -and `
    [bool]$runtimeGeneration.brokerStatusPidMatch -and `
    [bool]$runtimeGeneration.brokerProcessAlive -and `
    [bool]$runtimeGeneration.brokerHeartbeatFresh -and `
    [string]$runtimeGeneration.startupRunnerLockState -eq 'HELD' -and `
    $runningTaskInstancePids.Count -eq 1 -and `
    [int]$runningTaskInstancePids[0] -eq [int]$runtimeGeneration.statusBrokerPid -and `
    [string]$brokerAttestation.component -eq 'lifecycle-broker' -and `
    [int]$brokerAttestation.pid -eq [int]$runtimeGeneration.statusBrokerPid -and `
    $brokerAttestationVersionValid -and `
    $brokerAttestationGenerationValid -and `
    $brokerAttestationIsStale
  if (-not $heldEligible) {
    throw "Guarded recovery observed RUNNING+READY HELD stale generation but could not prove exact canonical broker tuple."
  }

  Assert-PauseDisarmed
  Assert-BridgeAndFlat -ExpectedSession $bridgeSessionId
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_HELD_LOCK=ELIGIBLE_QUIESCE_REQUIRED"

  # Re-prove mutable evidence immediately before the only wrapper mutation. The
  # current task trust is verified against the current trusted runner SHA separately
  # from the stale running broker's historical launcher SHA and action token.
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $runtimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  $lifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
  $runningTaskInstancePids = @(Get-Phase7CRunningTaskInstanceProcessIds -Name $TaskName)
  $taskOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256
  $taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
  $brokerAttestation = Get-Content -LiteralPath $brokerAttestationPath -Raw | ConvertFrom-Json
  $brokerAttestationVersionValid = $null -ne $brokerAttestation.PSObject.Properties['version'] -and [int]$brokerAttestation.version -eq 1
  $brokerAttestationGenerationValid = `
    $null -ne $brokerAttestation.PSObject.Properties['deploymentId'] -and `
    $null -ne $brokerAttestation.PSObject.Properties['sourceCommit'] -and `
    $null -ne $brokerAttestation.PSObject.Properties['sourceTree'] -and `
    $null -ne $brokerAttestation.PSObject.Properties['launcherSha256'] -and `
    [string]$brokerAttestation.deploymentId -match '^[0-9a-fA-F]{32}$' -and `
    [string]$brokerAttestation.sourceCommit -match '^[0-9a-fA-F]{40}$' -and `
    [string]$brokerAttestation.sourceTree -match '^[0-9a-fA-F]{40}$' -and `
    [string]$brokerAttestation.launcherSha256 -match '^sha256:[0-9a-fA-F]{64}$'
  $brokerAttestationIsStale = `
    $brokerAttestationGenerationValid -and `
    (-not [string]::Equals([string]$brokerAttestation.deploymentId, [string]$targetDeployment.deploymentId, [System.StringComparison]::OrdinalIgnoreCase) -or `
     -not [string]::Equals([string]$brokerAttestation.sourceCommit, [string]$targetDeployment.sourceCommit, [System.StringComparison]::OrdinalIgnoreCase) -or `
     -not [string]::Equals([string]$brokerAttestation.sourceTree, [string]$targetDeployment.sourceTree, [System.StringComparison]::OrdinalIgnoreCase))
  $stillEligible = `
    [bool]$lifecycle.running -and [bool]$lifecycle.ready -and `
    [string]$lifecycle.mode.mode -eq 'PAUSE' -and `
    [string]$lifecycle.accountMode.accountMode -eq 'LIVE' -and [bool]$lifecycle.accountMode.valid -and `
    [string]$task.State -eq 'Running' -and `
    [string]$runtimeGeneration.statusReadState -eq 'OK' -and [string]$runtimeGeneration.heartbeatReadState -eq 'OK' -and `
    [bool]$runtimeGeneration.brokerStatusPidMatch -and [bool]$runtimeGeneration.brokerProcessAlive -and [bool]$runtimeGeneration.brokerHeartbeatFresh -and `
    [string]$runtimeGeneration.startupRunnerLockState -eq 'HELD' -and `
    $runningTaskInstancePids.Count -eq 1 -and `
    [int]$runningTaskInstancePids[0] -eq [int]$runtimeGeneration.statusBrokerPid -and `
    [string]$brokerAttestation.component -eq 'lifecycle-broker' -and [int]$brokerAttestation.pid -eq [int]$runtimeGeneration.statusBrokerPid -and `
    $brokerAttestationVersionValid -and $brokerAttestationGenerationValid -and $brokerAttestationIsStale -and `
    [bool]$taskOwnership.owned -and [bool]$taskOwnership.canonical -and -not [bool]$taskOwnership.repairRequired -and `
    $taskDrift.Count -eq 0 -and (Test-Phase7CSystemTaskPrincipal $task.Principal)
  if (-not $stillEligible) {
    throw "Guarded recovery RUNNING+READY HELD tuple changed during safety recheck; lifecycle stop blocked."
  }

  Assert-PauseDisarmed
  Assert-BridgeAndFlat -ExpectedSession $bridgeSessionId
  [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})
  Wait-LifecycleStopped
  Assert-PauseDisarmed
  Assert-BridgeAndFlat -ExpectedSession $bridgeSessionId
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_HELD_LOCK_LIFECYCLE_STOP=PASS"
}

# The canonical recovery owns all task stop/restart, fresh broker PID proof, exact
# source attestation, lock HELD verification, lifecycle START and strict Web/API deploy.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CoreRecovery `
  -ExpectedCommit $ExpectedCommit `
  -TimeoutSeconds $TimeoutSeconds
if ($LASTEXITCODE -ne 0) {
  throw "Canonical runtime-ready stable recovery failed with exit code $LASTEXITCODE."
}

Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GUARDED_ENTRY=PASS"
