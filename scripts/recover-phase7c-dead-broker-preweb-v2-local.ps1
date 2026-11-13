param(
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [Parameter(Mandatory = $true)] [string]$ExpectedRuntimeCommit,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $PSScriptRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeOwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-source-attestation.ps1'
$TaskName = 'XAUUSD-Phase7C-Executors'
$ReadyStableMs = 5000
$sourceOnlyTransitionAllowlist = @(
  '.github/workflows/phase7c-dead-broker-preweb-recovery-ci.yml',
  'scripts/recover-phase7c-dead-broker-preweb-v2-local.ps1',
  'scripts/test-phase7c-dead-broker-preweb-recovery-source.ps1'
)

if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'ExpectedCommit must be an exact 40-character Git SHA.'
}
if ($ExpectedRuntimeCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'ExpectedRuntimeCommit must be an exact 40-character Git SHA.'
}
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) {
  throw 'TimeoutSeconds must be between 30 and 600.'
}
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary, $RuntimeSourceAttestationLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Dead-broker recovery required file not found: $required"
  }
}

. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary
. $RuntimeSourceAttestationLibrary

$ExpectedCommit = $ExpectedCommit.Trim().ToLowerInvariant()
$ExpectedRuntimeCommit = $ExpectedRuntimeCommit.Trim().ToLowerInvariant()
$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

Write-Host '============================================================'
Write-Host '=== PHASE7C DEAD BROKER PRE-WEB RECOVERY V2 ==='
Write-Host '============================================================'
Write-Host 'MUTATION_SCOPE=START_EXISTING_CANONICAL_TASK_THEN_LIFECYCLE_START_ONLY'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'BRIDGE_RESTART=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'WEB_API_DEPLOY=NONE'

function Resolve-ConfigPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing: $Path"
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "$Label file is invalid: $Path. $($_.Exception.Message)"
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Dead-broker recovery requires PowerShell Administrator to start the canonical Scheduled Task.'
  }
}

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-ApiPost([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod `
    -Uri "$ControlApiUrl$Path" `
    -Method Post `
    -ContentType 'application/json' `
    -Body $json `
    -TimeoutSec 55
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

function Get-BridgeHealth {
  return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
}

function Assert-PauseDisarmed([string]$Stage) {
  $mode = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
  if ([string]$mode.state.mode -ne 'PAUSE') {
    throw "$Stage current bot mode PAUSE is required. actual=$($mode.state.mode)"
  }

  $arm = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
  if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) {
    throw "$Stage canonical LIVE ARM=DISARMED is required."
  }
}

function Assert-BridgeSession([string]$ExpectedSession, [string]$Stage) {
  $health = Get-BridgeHealth
  if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') {
    throw "$Stage bridge is not healthy."
  }
  if ([string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') {
    throw "$Stage bridge is not LIVE/real."
  }
  $actualSession = [string]$health.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($actualSession) -or $actualSession -ne $ExpectedSession) {
    throw "$Stage bridge session changed. expected=$ExpectedSession actual=$actualSession"
  }
}

function Assert-FlatBroker([string]$Stage) {
  $positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
  $orders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')
  if ($positions.Count -ne 0) {
    throw "$Stage requires zero XAUUSD positions. current=$($positions.Count)"
  }
  if ($orders.Count -ne 0) {
    throw "$Stage requires zero pending XAUUSD orders. current=$($orders.Count)"
  }
  Write-Host "PHASE7C_DEAD_BROKER_${Stage}_POSITIONS=0"
  Write-Host "PHASE7C_DEAD_BROKER_${Stage}_PENDING_ORDERS=0"
}

function Get-Phase7CCanonicalTaskProcessCount($Task) {
  try {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return -1 }
    $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$actions[0].Arguments))
    if ($tokens.Count -ne 5 -or -not $tokens[3].Equals('-EncodedCommand', [System.StringComparison]::OrdinalIgnoreCase)) {
      return -1
    }
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
  } catch {
    return -1
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

function Get-Phase7CBrokerPidFromHeartbeat([string]$HeartbeatPath) {
  if (-not (Test-Path -LiteralPath $HeartbeatPath -PathType Leaf)) { return 0 }
  try {
    $heartbeat = Get-Content -LiteralPath $HeartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ([int]$heartbeat.version -ne 1) { return 0 }
    $brokerPid = [int]$heartbeat.brokerPid
    if ($brokerPid -le 0) { return 0 }
    return $brokerPid
  } catch {
    return 0
  }
}

function Test-Phase7CBrokerHeartbeatFresh([string]$HeartbeatPath) {
  if (-not (Test-Path -LiteralPath $HeartbeatPath -PathType Leaf)) { return $false }
  try {
    $heartbeat = Get-Content -LiteralPath $HeartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ([int]$heartbeat.version -ne 1) { return $false }
    $brokerPid = [int]$heartbeat.brokerPid
    if ($brokerPid -le 0 -or $null -eq (Get-Process -Id $brokerPid -ErrorAction SilentlyContinue)) { return $false }
    $updatedAt = [long]$heartbeat.updatedAt
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $updatedAt
    return $age -ge 0 -and $age -le 5000
  } catch {
    return $false
  }
}

function Wait-LifecycleReadyStable([int]$ProbeTimeoutSeconds) {
  Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_READY_STABLE_MS=5000'
  $deadline = [DateTime]::UtcNow.AddSeconds($ProbeTimeoutSeconds)
  $stableSinceMs = 0L

  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $sampleReady = $false
    try {
      $state = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
      $sampleReady = `
        [bool]$state.running -and `
        [bool]$state.ready -and `
        [string]$state.mode.mode -eq 'PAUSE' -and `
        [string]$state.accountMode.accountMode -eq 'LIVE' -and `
        [bool]$state.accountMode.valid
    } catch {
      $sampleReady = $false
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($sampleReady) {
      if ($stableSinceMs -le 0) { $stableSinceMs = $nowMs }
      if (($nowMs - $stableSinceMs) -ge $ReadyStableMs) { return $true }
    } else {
      if ($stableSinceMs -gt 0) {
        Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_READY_STABLE_RESET=TRUE'
      }
      $stableSinceMs = 0L
    }
  }
  return $false
}

function Assert-TaskCanonical($Task, [string]$ExpectedRunnerPath, [string]$ExpectedRunnerSha256, [string]$Stage) {
  $ownership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $Task.Actions `
    -ExpectedRunnerPath $ExpectedRunnerPath `
    -ExpectedRunnerSha256 $ExpectedRunnerSha256
  $drift = @(Get-Phase7CExecutorTaskDrift -Task $Task)
  if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired -or $drift.Count -ne 0) {
    throw "$Stage requires exact canonical Scheduled Task ownership. ownership=$($ownership.reason) drift=$($drift -join ',')"
  }
  if (-not (Test-Phase7CSystemTaskPrincipal $Task.Principal)) {
    throw "$Stage requires SYSTEM + ServiceAccount + Highest Scheduled Task principal."
  }
}

function Assert-BrokerAttestationExact(
  [string]$Path,
  $Deployment,
  [int]$ExpectedPid,
  [string]$ExpectedLauncherSha256,
  [string]$Stage
) {
  $attestation = Read-JsonFile -Path $Path -Label "$Stage lifecycle broker source attestation"
  if ([int]$attestation.version -ne 1 -or `
      [string]$attestation.component -ne 'lifecycle-broker' -or `
      [string]$attestation.deploymentId -ne [string]$Deployment.deploymentId -or `
      [string]$attestation.sourceCommit -ne [string]$Deployment.sourceCommit -or `
      [string]$attestation.sourceTree -ne [string]$Deployment.sourceTree -or `
      [string]$attestation.configFingerprint -ne [string]$Deployment.configFingerprint -or `
      [int]$attestation.pid -ne $ExpectedPid -or `
      ([string]$attestation.launcherSha256).Trim().ToLowerInvariant() -ne $ExpectedLauncherSha256) {
    throw "$Stage lifecycle broker attestation does not match the accepted deployment."
  }
  return $attestation
}

Assert-Administrator

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw "Dead-broker recovery requires branch main. actual=$branch"
  }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'Dead-broker recovery requires a clean worktree.'
  }
  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
    throw "Dead-broker recovery exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
  $sourceTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') {
    throw 'Dead-broker recovery could not resolve the exact source tree.'
  }
  $resolvedRuntimeCommit = ([string](& $gitExe rev-parse "$ExpectedRuntimeCommit`^{commit}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $resolvedRuntimeCommit -ne $ExpectedRuntimeCommit) {
    throw "Dead-broker recovery could not resolve ExpectedRuntimeCommit exactly. expected=$ExpectedRuntimeCommit actual=$resolvedRuntimeCommit"
  }
  $expectedRuntimeTree = ([string](& $gitExe rev-parse "$ExpectedRuntimeCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $expectedRuntimeTree -notmatch '^[0-9a-f]{40}$') {
    throw 'Dead-broker recovery could not resolve the pre-existing runtime source tree.'
  }

  $runtimeTransitionChangedPaths = @(& $gitExe diff --name-only "$ExpectedRuntimeCommit..$ExpectedCommit" --)
  if ($LASTEXITCODE -ne 0) {
    throw 'Dead-broker recovery could not inspect the runtime-to-local source transition.'
  }
  $runtimeTransitionChangedPaths = @($runtimeTransitionChangedPaths | ForEach-Object { ([string]$_).Trim().Replace('\','/') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $runtimeTransitionUnexpectedPaths = @($runtimeTransitionChangedPaths | Where-Object { $_ -notin $sourceOnlyTransitionAllowlist })
  $runtimeTransitionMissingPaths = @($sourceOnlyTransitionAllowlist | Where-Object { $_ -notin $runtimeTransitionChangedPaths })
  if ($runtimeTransitionUnexpectedPaths.Count -ne 0 -or $runtimeTransitionMissingPaths.Count -ne 0) {
    throw "Dead-broker recovery source transition is not the exact source-only allowlist. unexpected=$($runtimeTransitionUnexpectedPaths -join ',') missing=$($runtimeTransitionMissingPaths -join ',') changed=$($runtimeTransitionChangedPaths -join ',')"
  }
} finally {
  Pop-Location
}
Write-Host "PHASE7C_DEAD_BROKER_PRE_WEB_GIT_GUARD=PASS|COMMIT=$ExpectedCommit|TREE=$sourceTree"
Write-Host "PHASE7C_DEAD_BROKER_PRE_WEB_RUNTIME_SOURCE_TRANSITION=UNCHANGED_RUNTIME_FILES|FROM=$ExpectedRuntimeCommit|TO=$ExpectedCommit|CHANGED=$($runtimeTransitionChangedPaths -join ',')"

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
$expectedLauncherSha256 = 'sha256:' + $trustedRunnerSha256.ToLowerInvariant()

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
if ([int]$config.version -ne 2) { throw 'Dead-broker recovery requires executor task config version 2.' }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE') { throw 'Dead-broker recovery requires configured LIVE account mode.' }
if (-not [bool]$config.liveExecutionEnabled) { throw 'Dead-broker recovery requires liveExecutionEnabled=true.' }
if (-not [bool]$config.armed) { throw 'Dead-broker recovery requires executor task config armed=true.' }

$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) { throw 'Dead-broker recovery controlApiUrl is missing.' }

$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }
$BrokerHeartbeatPath = Join-Path $WorkDir 'phase7c-lifecycle-broker\state\heartbeat.json'
$BrokerAttestationPath = Join-Path $WorkDir 'phase7c-source-attestation\components\lifecycle-broker.json'

$deployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
if ([string]$deployment.sourceCommit -ne $ExpectedRuntimeCommit -or `
    [string]$deployment.sourceTree -ne $expectedRuntimeTree -or `
    [string]$deployment.branch -ne 'main' -or `
    -not [bool]$deployment.worktreeClean) {
  throw "Dead-broker recovery requires the pre-existing accepted runtime deployment exactly. expectedCommit=$ExpectedRuntimeCommit expectedTree=$expectedRuntimeTree actualCommit=$($deployment.sourceCommit) actualTree=$($deployment.sourceTree)"
}

Assert-PauseDisarmed -Stage 'PREFLIGHT'
$healthBefore = Get-BridgeHealth
if (-not [bool]$healthBefore.connected -or [string]$healthBefore.status -ne 'ok') { throw 'PREFLIGHT bridge is not healthy.' }
if ([string]$healthBefore.configuredAccountMode -ne 'LIVE' -or [string]$healthBefore.accountMode -ne 'real') { throw 'PREFLIGHT bridge is not LIVE/real.' }
$bridgeSessionId = [string]$healthBefore.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw 'PREFLIGHT bridge health is missing bridgeSessionId.' }
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'PREFLIGHT'
Assert-FlatBroker -Stage 'PREFLIGHT'

$deadBrokerTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$deadBrokerTaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
Assert-TaskCanonical -Task $deadBrokerTask -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256 -Stage 'DEAD_BROKER_PRE_WEB'
$deadBrokerCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $deadBrokerTask
$deadBrokerRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
$deadBrokerGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
$deadBrokerLifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'

$deadBrokerOldPidProcess = Get-Process -Id ([int]$deadBrokerGeneration.statusBrokerPid) -ErrorAction SilentlyContinue
$deadBrokerHeartbeatEvidenceSafe = $false
if ([string]$deadBrokerGeneration.heartbeatReadState -eq 'MISSING') {
  $deadBrokerHeartbeatEvidenceSafe = [int]$deadBrokerGeneration.heartbeatBrokerPid -eq 0
} elseif ([string]$deadBrokerGeneration.heartbeatReadState -eq 'OK') {
  $deadBrokerHeartbeatEvidenceSafe = `
    [int]$deadBrokerGeneration.heartbeatBrokerPid -eq [int]$deadBrokerGeneration.statusBrokerPid -and `
    -not [bool]$deadBrokerGeneration.brokerHeartbeatFresh
}

$deadBrokerPreWebRecoveryRequired = `
  -not [bool]$deadBrokerLifecycle.running -and `
  -not [bool]$deadBrokerLifecycle.ready -and `
  [string]$deadBrokerTask.State -eq 'Ready' -and `
  [long]$deadBrokerTaskInfo.LastTaskResult -ne 0 -and `
  $deadBrokerCanonicalProcessCount -eq 0 -and `
  $deadBrokerRunningInstanceCount -eq 0 -and `
  [string]$deadBrokerGeneration.statusReadState -eq 'OK' -and `
  [string]$deadBrokerGeneration.heartbeatReadState -in @('MISSING', 'OK') -and `
  [int]$deadBrokerGeneration.statusBrokerPid -gt 0 -and `
  $null -eq $deadBrokerOldPidProcess -and `
  -not [bool]$deadBrokerGeneration.brokerProcessAlive -and `
  -not [bool]$deadBrokerGeneration.brokerHeartbeatFresh -and `
  $deadBrokerHeartbeatEvidenceSafe -and `
  [string]$deadBrokerGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED')

if (-not $deadBrokerPreWebRecoveryRequired) {
  throw "Dead-broker recovery tuple is not exact; mutation blocked. taskState=$($deadBrokerTask.State) lastResult=$($deadBrokerTaskInfo.LastTaskResult) canonicalProcesses=$deadBrokerCanonicalProcessCount taskInstances=$deadBrokerRunningInstanceCount lifecycleRunning=$($deadBrokerLifecycle.running) lifecycleReady=$($deadBrokerLifecycle.ready) statusRead=$($deadBrokerGeneration.statusReadState) heartbeatRead=$($deadBrokerGeneration.heartbeatReadState) statusPid=$($deadBrokerGeneration.statusBrokerPid) brokerAlive=$($deadBrokerGeneration.brokerProcessAlive) heartbeatFresh=$($deadBrokerGeneration.brokerHeartbeatFresh) lock=$($deadBrokerGeneration.startupRunnerLockState)"
}

[void](Assert-BrokerAttestationExact `
  -Path $BrokerAttestationPath `
  -Deployment $deployment `
  -ExpectedPid ([int]$deadBrokerGeneration.statusBrokerPid) `
  -ExpectedLauncherSha256 $expectedLauncherSha256 `
  -Stage 'PRE_RECOVERY')

Write-Host "PHASE7C_DEAD_BROKER_PRE_WEB=ELIGIBLE|OLD_BROKER_PID=$($deadBrokerGeneration.statusBrokerPid)|TASK_LAST_RESULT=$($deadBrokerTaskInfo.LastTaskResult)"

# Re-prove every mutable safety boundary immediately before the only task mutation.
Assert-PauseDisarmed -Stage "DEAD_BROKER_PRE_WEB"
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "DEAD_BROKER_PRE_WEB"
Assert-FlatBroker -Stage "DEAD_BROKER_PRE_WEB"

$deadBrokerTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$deadBrokerTaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
Assert-TaskCanonical -Task $deadBrokerTask -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256 -Stage 'DEAD_BROKER_PRE_WEB_RECHECK'
$deadBrokerCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $deadBrokerTask
$deadBrokerRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
$deadBrokerGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
$deadBrokerLifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
$deadBrokerOldPidProcess = Get-Process -Id ([int]$deadBrokerGeneration.statusBrokerPid) -ErrorAction SilentlyContinue
$deadBrokerHeartbeatEvidenceSafe = $false
if ([string]$deadBrokerGeneration.heartbeatReadState -eq 'MISSING') {
  $deadBrokerHeartbeatEvidenceSafe = [int]$deadBrokerGeneration.heartbeatBrokerPid -eq 0
} elseif ([string]$deadBrokerGeneration.heartbeatReadState -eq 'OK') {
  $deadBrokerHeartbeatEvidenceSafe = `
    [int]$deadBrokerGeneration.heartbeatBrokerPid -eq [int]$deadBrokerGeneration.statusBrokerPid -and `
    -not [bool]$deadBrokerGeneration.brokerHeartbeatFresh
}
$deadBrokerStillEligible = `
  -not [bool]$deadBrokerLifecycle.running -and `
  -not [bool]$deadBrokerLifecycle.ready -and `
  [string]$deadBrokerTask.State -eq 'Ready' -and `
  [long]$deadBrokerTaskInfo.LastTaskResult -ne 0 -and `
  $deadBrokerCanonicalProcessCount -eq 0 -and `
  $deadBrokerRunningInstanceCount -eq 0 -and `
  [string]$deadBrokerGeneration.statusReadState -eq 'OK' -and `
  [string]$deadBrokerGeneration.heartbeatReadState -in @('MISSING', 'OK') -and `
  [int]$deadBrokerGeneration.statusBrokerPid -gt 0 -and `
  $null -eq $deadBrokerOldPidProcess -and `
  -not [bool]$deadBrokerGeneration.brokerProcessAlive -and `
  -not [bool]$deadBrokerGeneration.brokerHeartbeatFresh -and `
  $deadBrokerHeartbeatEvidenceSafe -and `
  [string]$deadBrokerGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED')
if (-not $deadBrokerStillEligible) {
  throw 'Dead-broker recovery tuple changed during final safety recheck; task start blocked.'
}
[void](Assert-BrokerAttestationExact `
  -Path $BrokerAttestationPath `
  -Deployment $deployment `
  -ExpectedPid ([int]$deadBrokerGeneration.statusBrokerPid) `
  -ExpectedLauncherSha256 $expectedLauncherSha256 `
  -Stage 'PRE_START_RECHECK')

$oldBrokerPid = [int]$deadBrokerGeneration.statusBrokerPid
Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop

$restartDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
$newBrokerPid = 0
$taskRestarted = $false
do {
  Start-Sleep -Milliseconds 250
  $taskAfterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$taskAfterStart.State -eq 'Running' -and (Test-Phase7CBrokerHeartbeatFresh -HeartbeatPath $BrokerHeartbeatPath)) {
    $newBrokerPid = Get-Phase7CBrokerPidFromHeartbeat -HeartbeatPath $BrokerHeartbeatPath
    if ($newBrokerPid -gt 0 -and $newBrokerPid -ne $oldBrokerPid) {
      $taskRestarted = $true
      break
    }
  }
} while ([DateTime]::UtcNow -lt $restartDeadline)

if (-not $taskRestarted) {
  $failureTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $failureGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  throw "Canonical Scheduled Task start did not produce a fresh lifecycle broker. oldPid=$oldBrokerPid newPid=$newBrokerPid taskState=$([string]$failureTask.State) brokerAlive=$($failureGeneration.brokerProcessAlive) heartbeatFresh=$($failureGeneration.brokerHeartbeatFresh) lock=$($failureGeneration.startupRunnerLockState)"
}
Write-Host "PHASE7C_DEAD_BROKER_PRE_WEB_TASK_RESTART=PASS|BROKER_PID=$newBrokerPid"

$taskVerified = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Assert-TaskCanonical -Task $taskVerified -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedRunnerSha256 -Stage 'POST_TASK_START'
$postCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $taskVerified
$postRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
if ($postCanonicalProcessCount -ne 1 -or $postRunningInstanceCount -ne 1) {
  throw "Started canonical task ownership is ambiguous. canonicalProcesses=$postCanonicalProcessCount taskInstances=$postRunningInstanceCount"
}

[void](Assert-BrokerAttestationExact `
  -Path $BrokerAttestationPath `
  -Deployment $deployment `
  -ExpectedPid $newBrokerPid `
  -ExpectedLauncherSha256 $expectedLauncherSha256 `
  -Stage 'POST_TASK_START')
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_BROKER_ATTESTATION=EXACT'

$postGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
if ([string]$postGeneration.statusReadState -ne 'OK' -or `
    [string]$postGeneration.heartbeatReadState -ne 'OK' -or `
    -not [bool]$postGeneration.brokerStatusPidMatch -or `
    -not [bool]$postGeneration.brokerProcessAlive -or `
    -not [bool]$postGeneration.brokerHeartbeatFresh -or `
    [int]$postGeneration.statusBrokerPid -ne $newBrokerPid -or `
    [string]$postGeneration.startupRunnerLockState -ne 'HELD') {
  throw "Fresh broker runtime proof failed. statusRead=$($postGeneration.statusReadState) heartbeatRead=$($postGeneration.heartbeatReadState) pidMatch=$($postGeneration.brokerStatusPidMatch) brokerAlive=$($postGeneration.brokerProcessAlive) heartbeatFresh=$($postGeneration.brokerHeartbeatFresh) statusPid=$($postGeneration.statusBrokerPid) lock=$($postGeneration.startupRunnerLockState)"
}
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_STARTUP_RUNNER_LOCK=HELD'

Assert-PauseDisarmed -Stage 'POST_BROKER_START'
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_BROKER_START'
Assert-FlatBroker -Stage 'POST_BROKER_START'

# Canonical broker START owns bounded orphan reconciliation from PR #348. This helper
# does not inspect or terminate orphan wrapper processes directly.
[void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
if (-not (Wait-LifecycleReadyStable -ProbeTimeoutSeconds ([Math]::Min($TimeoutSeconds, 45)))) {
  throw 'Lifecycle did not remain continuously READY for 5000ms after dead-broker recovery.'
}
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_LIFECYCLE_READY=PASS'

Assert-PauseDisarmed -Stage 'FINAL'
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'FINAL'
Assert-FlatBroker -Stage 'FINAL'

$finalSourceStatus = Get-Phase7CRuntimeSourceGenerationAttestationStatus `
  -RuntimeRoot $WorkDir `
  -TargetDeployment $deployment
if (-not [bool]$finalSourceStatus.exactMatch) {
  throw "Final runtime source generation attestation mismatch. components=$(@($finalSourceStatus.mismatchComponents) -join ',') reasons=$(@($finalSourceStatus.reasonCodes) -join ',')"
}
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_FINAL_SOURCE_ATTESTATION=EXACT'

$finalRuntimeSource = Invoke-ApiGet '/api/v1/phase7c/runtime-source-attestation'
if ([string]$finalRuntimeSource.overall -ne 'EXACT_MATCH') {
  $nonExact = @($finalRuntimeSource.components | Where-Object { [string]$_.verdict -ne 'EXACT_MATCH' } | ForEach-Object { "$($_.component):$($_.verdict)" })
  throw "Final runtime-source API is not EXACT_MATCH. overall=$($finalRuntimeSource.overall) components=$($nonExact -join ',')"
}
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_RUNTIME_SOURCE_API=EXACT_MATCH'
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_FINAL_MODE=PAUSE'
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_FINAL_ARM=DISARMED'
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_STATUS=PASS'
Write-Host 'PHASE7C_DEAD_BROKER_PRE_WEB_NEXT_ACTION=RUN_RUNTIME_READY_STABLE_RECOVERY'
