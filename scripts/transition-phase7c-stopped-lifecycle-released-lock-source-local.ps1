param(
  [Parameter(Mandatory = $true)] [string]$ProjectRoot,
  [Parameter(Mandatory = $true)] [string]$ExpectedCurrentCommit,
  [Parameter(Mandatory = $true)] [string]$TargetCommit,
  [Parameter(Mandatory = $true)] [string]$ExpectedRemoteMainCommit,
  [Parameter(Mandatory = $true)] [string]$ExpectedHelperBlobSha1
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedCurrentCommit = $ExpectedCurrentCommit.Trim().ToLowerInvariant()
$TargetCommit = $TargetCommit.Trim().ToLowerInvariant()
$ExpectedRemoteMainCommit = $ExpectedRemoteMainCommit.Trim().ToLowerInvariant()
$ExpectedHelperBlobSha1 = $ExpectedHelperBlobSha1.Trim().ToLowerInvariant()

$TaskName = 'XAUUSD-Phase7C-Executors'
$HelperRepoPath = 'scripts/transition-phase7c-stopped-lifecycle-released-lock-source-local.ps1'
$RunnerRepoPath = 'scripts/run-phase7c-executor-task-runner-local.ps1'
$ExpectedOriginUrls = @(
  'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master',
  'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git',
  'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master.git'
)

# Audit command contracts used below:
# git hash-object
# git status --porcelain
# git ls-remote
# git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
# git merge-base --is-ancestor
# git merge --ff-only

Write-Host '============================================================'
Write-Host '=== PHASE7C RELEASED-LOCK SOURCE-ONLY RESUME ==='
Write-Host '============================================================'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'SOURCE_MUTATION=EXACT_FF_ONLY'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'LIFECYCLE_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'BRIDGE_RESTART=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'

foreach ($value in @($ExpectedCurrentCommit, $TargetCommit, $ExpectedRemoteMainCommit, $ExpectedHelperBlobSha1)) {
  if ($value -notmatch '^[0-9a-f]{40}$') {
    throw "Exact 40-character lowercase Git identity is required. value=$value"
  }
}
if ($TargetCommit -ne $ExpectedRemoteMainCommit) {
  throw "Target commit must equal pinned canonical remote main. target=$TargetCommit remote=$ExpectedRemoteMainCommit"
}
if ($ExpectedCurrentCommit -eq $TargetCommit) {
  throw 'Source-only resume requires current and target commits to differ.'
}
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
  throw "ProjectRoot does not exist: $ProjectRoot"
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
  throw 'Released-lock source resume must run from an external helper file.'
}

$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$actualHelperBlob = ([string](& $gitExe hash-object -- $PSCommandPath)).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actualHelperBlob -notmatch '^[0-9a-f]{40}$') {
  throw 'Could not hash external released-lock source-resume helper.'
}
if ($actualHelperBlob -ne $ExpectedHelperBlobSha1) {
  throw "External helper blob mismatch. expected=$ExpectedHelperBlobSha1 actual=$actualHelperBlob"
}
Write-Host "PHASE7C_RELEASED_LOCK_SOURCE_RESUME_HELPER_FILE_PROVENANCE=PASS|BLOB=$actualHelperBlob"

$ScriptsRoot = Join-Path $ProjectRoot 'scripts'
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ScriptsRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeOwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$RuntimeSourceLibrary = Join-Path $ScriptsRoot 'lib\phase7c-runtime-source-attestation.ps1'
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary, $RuntimeSourceLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Current source dependency is missing: $required"
  }
}
. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary
. $RuntimeSourceLibrary

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "$Label is invalid: $Path. $($_.Exception.Message)"
  }
}

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path value is required.' }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
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

function Get-LifecycleAliveExecutorCount($State) {
  if ($null -eq $State -or $null -eq $State.processes) { return -1 }
  $count = 0
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) {
      $count++
    }
  }
  return $count
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 12
}

function Get-BridgeHealth {
  return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 12
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec 12
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Get-ReleasedLockSafetySnapshot {
  param(
    [Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$ExpectedBridgeSessionId,
    [Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$ExpectedBrokerPid,
    [Parameter(Mandatory = $true)] [string]$ExpectedDeploymentId,
    [Parameter(Mandatory = $true)] [string]$ExpectedDeploymentCommit,
    [Parameter(Mandatory = $true)] [string]$ExpectedDeploymentTree
  )

  $mode = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
  if ([string]$mode.state.mode -ne 'PAUSE') {
    throw "Released-lock source resume requires PAUSE. actual=$($mode.state.mode)"
  }

  $arm = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
  if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) {
    throw 'Released-lock source resume requires LIVE ARM DISARMED.'
  }

  $lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
  $aliveExecutorCount = Get-LifecycleAliveExecutorCount -State $lifecycle
  if ([bool]$lifecycle.running -or [bool]$lifecycle.ready -or $aliveExecutorCount -ne 0) {
    throw "Released-lock source resume requires stopped lifecycle with zero alive executors. running=$($lifecycle.running) ready=$($lifecycle.ready) alive=$aliveExecutorCount"
  }
  if ([string]$lifecycle.accountMode.accountMode -ne 'LIVE' -or -not [bool]$lifecycle.accountMode.valid) {
    throw 'Released-lock source resume requires valid LIVE lifecycle account context.'
  }

  $bridgeHealth = Get-BridgeHealth
  if (-not [bool]$bridgeHealth.connected -or [string]$bridgeHealth.status -ne 'ok') {
    throw 'Released-lock source resume requires healthy Bridge.'
  }
  if ([string]$bridgeHealth.configuredAccountMode -ne 'LIVE' -or [string]$bridgeHealth.accountMode -ne 'real') {
    throw 'Released-lock source resume requires Bridge LIVE/real.'
  }
  $bridgeSessionId = [string]$bridgeHealth.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) {
    throw 'Bridge session id is missing.'
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedBridgeSessionId) -and $bridgeSessionId -ne $ExpectedBridgeSessionId) {
    throw "Bridge session changed. expected=$ExpectedBridgeSessionId actual=$bridgeSessionId"
  }

  $positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
  $orders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')
  if ($positions.Count -ne 0 -or $orders.Count -ne 0) {
    throw "Released-lock source resume requires XAUUSD flat. positions=$($positions.Count) pendingOrders=$($orders.Count)"
  }

  Import-Module ScheduledTasks -ErrorAction Stop
  $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
  $trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$task.State -ne 'Running') {
    throw "Released-lock source resume requires canonical task Running. actual=$($task.State)"
  }
  $ownership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $task.Actions `
    -ExpectedRunnerPath $runnerPath `
    -ExpectedRunnerSha256 $trustedRunnerSha256
  $drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
  if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired -or $drift.Count -ne 0) {
    throw "Released-lock source resume requires exact canonical task ownership. reason=$($ownership.reason) drift=$($drift -join ',')"
  }
  if (-not (Test-Phase7CSystemTaskPrincipal $task.Principal)) {
    throw 'Released-lock source resume requires SYSTEM + ServiceAccount + Highest task principal.'
  }

  $canonicalProcessIds = @(Get-Phase7CCanonicalTaskProcessIds -Task $task)
  $runningTaskInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
  $generation = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  if ([string]$generation.statusReadState -ne 'OK' -or [string]$generation.heartbeatReadState -ne 'OK') {
    throw "Broker status/heartbeat must be readable. status=$($generation.statusReadState) heartbeat=$($generation.heartbeatReadState)"
  }
  $runtimeTupleExact = `
    [bool]$generation.brokerStatusPidMatch -and `
    [bool]$generation.brokerProcessAlive -and `
    [bool]$generation.brokerHeartbeatFresh -and `
    [string]$generation.startupRunnerLockState -in @('MISSING', 'RELEASED') -and `
    $canonicalProcessIds.Count -eq 1 -and `
    $runningTaskInstanceCount -eq 1 -and `
    [int]$canonicalProcessIds[0] -eq [int]$generation.statusBrokerPid
  if (-not $runtimeTupleExact) {
    throw "Released-lock broker tuple is not exact. brokerPid=$($generation.statusBrokerPid) alive=$($generation.brokerProcessAlive) fresh=$($generation.brokerHeartbeatFresh) lock=$($generation.startupRunnerLockState) processIds=$($canonicalProcessIds -join ',') taskInstances=$runningTaskInstanceCount"
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedBrokerPid) -and [string]$generation.statusBrokerPid -ne $ExpectedBrokerPid) {
    throw "Broker PID changed. expected=$ExpectedBrokerPid actual=$($generation.statusBrokerPid)"
  }

  $brokerAttestationPath = Join-Path $WorkDir 'phase7c-source-attestation\components\lifecycle-broker.json'
  $brokerAttestation = Read-JsonFile -Path $brokerAttestationPath -Label 'Lifecycle broker raw source attestation'
  $expectedLauncherSha256 = 'sha256:' + $trustedRunnerSha256.ToLowerInvariant()
  $attestedLauncherSha256 = ([string]$brokerAttestation.launcherSha256).Trim().ToLowerInvariant()
  $attestationIdentityExact = `
    [string]$brokerAttestation.component -eq 'lifecycle-broker' -and `
    [int]$brokerAttestation.pid -eq [int]$generation.statusBrokerPid -and `
    $attestedLauncherSha256 -eq $expectedLauncherSha256
  if (-not $attestationIdentityExact) {
    throw "Released-lock broker attestation identity mismatch. component=$($brokerAttestation.component) attestedPid=$($brokerAttestation.pid) brokerPid=$($generation.statusBrokerPid)"
  }

  $deployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
  if ([string]$deployment.deploymentId -ne $ExpectedDeploymentId -or
      [string]$deployment.sourceCommit -ne $ExpectedDeploymentCommit -or
      [string]$deployment.sourceTree -ne $ExpectedDeploymentTree -or
      [string]$deployment.branch -ne 'main' -or
      -not [bool]$deployment.worktreeClean) {
    throw "Accepted runtime deployment changed. expectedId=$ExpectedDeploymentId actualId=$($deployment.deploymentId) expectedCommit=$ExpectedDeploymentCommit actualCommit=$($deployment.sourceCommit)"
  }

  return [pscustomobject]@{
    bridgeSessionId = $bridgeSessionId
    brokerPid = [string]$generation.statusBrokerPid
    taskProcessPid = [string]$canonicalProcessIds[0]
    startupRunnerLockState = [string]$generation.startupRunnerLockState
    runnerSha256 = $trustedRunnerSha256
    deploymentId = [string]$deployment.deploymentId
    deploymentCommit = [string]$deployment.sourceCommit
    deploymentTree = [string]$deployment.sourceTree
    positionCount = [int]$positions.Count
    pendingOrderCount = [int]$orders.Count
  }
}

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
if ([int]$config.version -ne 2 -or (ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE' -or -not [bool]$config.liveExecutionEnabled -or -not [bool]$config.armed) {
  throw 'Released-lock source resume requires canonical LIVE executor task config.'
}
$WorkDir = Resolve-ProjectPath ([string]$config.workDir)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^http://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$') {
  throw 'Control API URL must be loopback HTTP.'
}

$accountStatePath = Join-Path $WorkDir 'phase7c-account-mode.json'
$accountState = Read-JsonFile -Path $accountStatePath -Label 'Canonical account-mode state'
if ([int]$accountState.version -ne 1 -or (ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)) -ne 'LIVE' -or -not [bool]$accountState.liveExecutionEnabled) {
  throw 'Released-lock source resume requires canonical LIVE account-mode state.'
}
$EnvFile = Resolve-ProjectPath ([string]$accountState.envFile)
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

Push-Location $ProjectRoot
try {
  $localBranch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $localBranch -ne 'main') {
    throw "Released-lock source resume requires branch main. actual=$localBranch"
  }
  $localHead = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $localHead -ne $ExpectedCurrentCommit) {
    throw "Current production commit mismatch. expected=$ExpectedCurrentCommit actual=$localHead"
  }
  $currentTree = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $currentTree -notmatch '^[0-9a-f]{40}$') {
    throw 'Could not resolve current source tree.'
  }
  $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
  if ($LASTEXITCODE -ne 0 -or @($dirty | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
    throw 'Released-lock source resume requires a clean worktree.'
  }
  $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
  if ($LASTEXITCODE -ne 0 -or $ExpectedOriginUrls -notcontains $originUrl) {
    throw "Unexpected origin remote. actual=$originUrl"
  }
  $remoteMainRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
  if ($LASTEXITCODE -ne 0 -or $remoteMainRaw.Count -ne 1) {
    throw 'Could not prove canonical origin/main.'
  }
  $remoteMain = ([string]$remoteMainRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
  if ($remoteMain -ne $ExpectedRemoteMainCommit) {
    throw "origin/main pin mismatch. expected=$ExpectedRemoteMainCommit actual=$remoteMain"
  }

  & $gitExe fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
  if ($LASTEXITCODE -ne 0) { throw 'Exact origin/main metadata fetch failed.' }

  & $gitExe cat-file -e "$TargetCommit`^{commit}"
  if ($LASTEXITCODE -ne 0) { throw 'Target commit is not locally resolvable after fetch.' }
  & $gitExe merge-base --is-ancestor $ExpectedCurrentCommit $TargetCommit
  if ($LASTEXITCODE -ne 0) { throw 'Target commit is not a fast-forward descendant of current production commit.' }
  & $gitExe merge-base --is-ancestor $TargetCommit $ExpectedRemoteMainCommit
  if ($LASTEXITCODE -ne 0) { throw 'Target commit is not reachable from pinned remote main.' }

  $targetHelperBlob = ([string](& $gitExe rev-parse "$TargetCommit`:$HelperRepoPath")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $targetHelperBlob -ne $ExpectedHelperBlobSha1) {
    throw "Target helper provenance mismatch. expected=$ExpectedHelperBlobSha1 actual=$targetHelperBlob"
  }
  $currentRunnerBlob = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $currentRunnerBlob -notmatch '^[0-9a-f]{40}$') {
    throw 'Could not resolve current guarded runner blob.'
  }
  $targetRunnerBlob = ([string](& $gitExe rev-parse "$TargetCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $targetRunnerBlob -notmatch '^[0-9a-f]{40}$') {
    throw 'Could not resolve target guarded runner blob.'
  }
  if ($currentRunnerBlob -ne $targetRunnerBlob) {
    throw "Guarded Scheduled Task runner blob changed across source transition. current=$currentRunnerBlob target=$targetRunnerBlob"
  }
} finally {
  Pop-Location
}
Write-Host "PHASE7C_RELEASED_LOCK_SOURCE_RESUME_GIT_PREFLIGHT=PASS|CURRENT=$ExpectedCurrentCommit|TARGET=$TargetCommit|REMOTE_MAIN=$ExpectedRemoteMainCommit"
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_GIT_MODE=EXACT_FF_ONLY'
Write-Host "PHASE7C_RELEASED_LOCK_SOURCE_RESUME_RUNNER_BLOB_UNCHANGED=PASS|BLOB=$currentRunnerBlob"

$acceptedDeployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
if ([string]$acceptedDeployment.sourceCommit -ne $ExpectedCurrentCommit -or [string]$acceptedDeployment.sourceTree -ne $currentTree -or [string]$acceptedDeployment.branch -ne 'main' -or -not [bool]$acceptedDeployment.worktreeClean) {
  throw "Accepted runtime deployment does not match current production source. deploymentCommit=$($acceptedDeployment.sourceCommit) current=$ExpectedCurrentCommit"
}
$acceptedDeploymentId = [string]$acceptedDeployment.deploymentId
if ([string]::IsNullOrWhiteSpace($acceptedDeploymentId)) {
  throw 'Accepted runtime deployment id is missing.'
}

$preflight = Get-ReleasedLockSafetySnapshot `
  -ExpectedBridgeSessionId '' `
  -ExpectedBrokerPid '' `
  -ExpectedDeploymentId $acceptedDeploymentId `
  -ExpectedDeploymentCommit $ExpectedCurrentCommit `
  -ExpectedDeploymentTree $currentTree
Write-Host "PHASE7C_RELEASED_LOCK_SOURCE_RESUME_PREFLIGHT=PASS|BROKER_PID=$($preflight.brokerPid)|LOCK=$($preflight.startupRunnerLockState)|DEPLOYMENT_ID=$acceptedDeploymentId"
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_TASK_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_LIFECYCLE_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_BRIDGE_RESTART=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_ORDER_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_POSITION_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_LIVE_TEST_ORDER=NONE'

# Re-prove Git identity and the full runtime tuple immediately before the only
# mutation in this helper. Any drift aborts before the worktree is changed.
Push-Location $ProjectRoot
try {
  $headBeforeMerge = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  $branchBeforeMerge = ([string](& $gitExe branch --show-current)).Trim()
  $dirtyBeforeMerge = @(& $gitExe status --porcelain --untracked-files=normal)
  if ($headBeforeMerge -ne $ExpectedCurrentCommit -or $branchBeforeMerge -ne 'main' -or @($dirtyBeforeMerge | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
    throw 'Production source changed after preflight and before source mutation.'
  }
  $remoteMainRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
  if ($LASTEXITCODE -ne 0 -or $remoteMainRaw.Count -ne 1) {
    throw 'Could not re-prove canonical origin/main immediately before source mutation.'
  }
  $remoteMain = ([string]$remoteMainRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
  if ($remoteMain -ne $ExpectedRemoteMainCommit) {
    throw "Canonical origin/main changed after preflight. expected=$ExpectedRemoteMainCommit actual=$remoteMain"
  }
} finally {
  Pop-Location
}

$preMutation = Get-ReleasedLockSafetySnapshot `
  -ExpectedBridgeSessionId ([string]$preflight.bridgeSessionId) `
  -ExpectedBrokerPid ([string]$preflight.brokerPid) `
  -ExpectedDeploymentId $acceptedDeploymentId `
  -ExpectedDeploymentCommit $ExpectedCurrentCommit `
  -ExpectedDeploymentTree $currentTree
if ([string]$preMutation.taskProcessPid -ne [string]$preflight.taskProcessPid) {
  throw "Canonical task process PID changed before source mutation. expected=$($preflight.taskProcessPid) actual=$($preMutation.taskProcessPid)"
}
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_PRE_MUTATION_RECHECK=PASS'

Push-Location $ProjectRoot
try {
  & $gitExe merge --ff-only $TargetCommit
  if ($LASTEXITCODE -ne 0) { throw 'Exact fast-forward source transition failed.' }
  $headAfterMerge = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  $branchAfterMerge = ([string](& $gitExe branch --show-current)).Trim()
  $dirtyAfterMerge = @(& $gitExe status --porcelain --untracked-files=normal)
  if ($headAfterMerge -ne $TargetCommit -or $branchAfterMerge -ne 'main' -or @($dirtyAfterMerge | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
    throw "Post-FF source identity invalid. head=$headAfterMerge branch=$branchAfterMerge dirty=$(@($dirtyAfterMerge).Count)"
  }
} finally {
  Pop-Location
}
Write-Host "PHASE7C_RELEASED_LOCK_SOURCE_RESUME_GIT_FAST_FORWARD=PASS|HEAD=$TargetCommit"

# The running broker/task are intentionally not touched by source sync. The accepted
# runtime deployment remains the prior generation until canonical recovery initializes
# the target deployment and restores the singleton lock through the same-task restart.
$postSource = Get-ReleasedLockSafetySnapshot `
  -ExpectedBridgeSessionId ([string]$preflight.bridgeSessionId) `
  -ExpectedBrokerPid ([string]$preflight.brokerPid) `
  -ExpectedDeploymentId $acceptedDeploymentId `
  -ExpectedDeploymentCommit $ExpectedCurrentCommit `
  -ExpectedDeploymentTree $currentTree
if ([string]$postSource.taskProcessPid -ne [string]$preflight.taskProcessPid) {
  throw "Canonical task process changed during source-only transition. expected=$($preflight.taskProcessPid) actual=$($postSource.taskProcessPid)"
}
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_POST_SOURCE=PASS'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_FINAL_MODE=PAUSE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_FINAL_ARM=DISARMED'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_TASK_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_LIFECYCLE_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_BRIDGE_RESTART=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_ORDER_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_POSITION_MUTATION=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_LIVE_TEST_ORDER=NONE'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_NEXT_ACTION=RUN_CANONICAL_RUNTIME_READY_RECOVERY'
Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_STATUS=PASS'
