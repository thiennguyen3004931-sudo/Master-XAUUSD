param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$ExpectedCurrentCommit,
    [Parameter(Mandatory = $true)] [string]$TargetCommit,
    [Parameter(Mandatory = $true)] [string]$ExpectedRemoteMainCommit,
    [Parameter(Mandatory = $true)] [string]$ExpectedHelperBlobSha1,
    [ValidateSet('ARMED','DISARMED')] [string]$ExpectedInitialArm = 'ARMED',
    [ValidateSet('HEALTHY','ORPHAN_QUEUED','STOPPED_LIFECYCLE')] [string]$ExpectedInitialRuntimeState = 'HEALTHY',
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedCurrentCommit = $ExpectedCurrentCommit.Trim().ToLowerInvariant()
$TargetCommit = $TargetCommit.Trim().ToLowerInvariant()
$ExpectedRemoteMainCommit = $ExpectedRemoteMainCommit.Trim().ToLowerInvariant()
$ExpectedHelperBlobSha1 = $ExpectedHelperBlobSha1.Trim().ToLowerInvariant()
$ReadyStableMs = 5000
$TaskName = 'XAUUSD-Phase7C-Executors'
$HelperRepoPath = 'scripts/rollout-phase7c-production-source-transition-local.ps1'
$RunnerRepoPath = 'scripts/run-phase7c-executor-task-runner-local.ps1'
$StoppedLifecycleMismatchComponents = @('api','web','supervisor','trend','sideway','telegram','regime-notifier')
$ExpectedGenerationMismatchReasons = @('SOURCE_COMMIT_MISMATCH','SOURCE_TREE_MISMATCH','DEPLOYMENT_ID_MISMATCH')
$ExpectedOriginUrls = @(
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core',
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core.git',
    'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master-core.git'
)

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) { throw "ProjectRoot does not exist: $ProjectRoot" }
foreach ($value in @($ExpectedCurrentCommit, $TargetCommit, $ExpectedRemoteMainCommit, $ExpectedHelperBlobSha1)) {
    if ($value -notmatch '^[0-9a-f]{40}$') { throw 'All commit/blob provenance inputs must be exact 40-character lowercase/uppercase hex identifiers.' }
}
if ($ExpectedCurrentCommit -eq $TargetCommit) { throw 'Production source transition requires a distinct target commit.' }
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
    throw 'Production source transition helper must execute from a real external file.'
}
if ($TimeoutSeconds -lt 60 -or $TimeoutSeconds -gt 600) { throw 'TimeoutSeconds must be between 60 and 600.' }

$ScriptsRoot = Join-Path $ProjectRoot 'scripts'
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ScriptsRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeOwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$RecoveryPath = Join-Path $ScriptsRoot 'recover-phase7c-runtime-ready-stable-deploy-local.ps1'
$P3VerifierPath = Join-Path $ScriptsRoot 'verify-phase7c-p3-production-acceptance-local.ps1'
$P4VerifierPath = Join-Path $ScriptsRoot 'verify-phase7c-p4-production-acceptance-local.ps1'
$gitExe = (Get-Command git -ErrorAction Stop).Source

$actualHelperBlob = ([string](& $gitExe hash-object -- $PSCommandPath)).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actualHelperBlob -ne $ExpectedHelperBlobSha1) {
    throw "External helper provenance mismatch. expectedBlob=$ExpectedHelperBlobSha1 actualBlob=$actualHelperBlob"
}
Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_HELPER_FILE_PROVENANCE=PASS|BLOB=$actualHelperBlob"

foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required current-generation rollout dependency is missing: $required" }
}
. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary

function Read-JsonFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "$Label is invalid: $($_.Exception.Message)" }
}
function Resolve-ConfigPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}
function Invoke-ApiGet([string]$Path) { return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 12 }
function Invoke-ApiPost([string]$Path, [object]$Body) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Post -ContentType 'application/json' -Body $json -TimeoutSec 60
}
function Get-BridgeHealth { return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 12 }
function Read-BridgeArray([string]$Path) {
    $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec 12
    $raw = ([string]$response.Content).Trim()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
    return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}
function Assert-BridgeSession([string]$ExpectedSession, [string]$Stage) {
    $health = Get-BridgeHealth
    if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') { throw "$Stage bridge is not healthy." }
    if ([string]$health.configuredAccountMode -ne 'LIVE' -or [string]$health.accountMode -ne 'real') { throw "$Stage bridge is not LIVE/real." }
    $actualSession = [string]$health.bridgeSessionId
    if ([string]::IsNullOrWhiteSpace($actualSession) -or $actualSession -ne $ExpectedSession) {
        throw "$Stage bridge session changed. expected=$ExpectedSession actual=$actualSession"
    }
}
function Assert-FlatBroker([string]$Stage) {
    $positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
    $orders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')
    if ($positions.Count -ne 0) { throw "$Stage requires zero XAUUSD positions. current=$($positions.Count)" }
    if ($orders.Count -ne 0) { throw "$Stage requires zero pending XAUUSD orders. current=$($orders.Count)" }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_POSITIONS=0"
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_PENDING_ORDERS=0"
}
function Assert-Pause([string]$Stage) {
    $mode = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
    if ([string]$mode.state.mode -ne 'PAUSE') { throw "$Stage requires bot mode PAUSE. actual=$($mode.state.mode)" }
}
function Get-ArmCapability { return Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability' }
function Assert-Arm([ValidateSet('ARMED','DISARMED')] [string]$Expected, [string]$Stage) {
    $arm = Get-ArmCapability
    if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne $Expected) {
        throw "$Stage ARM mismatch. expected=$Expected actual=$($arm.liveArmStatus) accountMode=$($arm.accountMode)"
    }
    if ($Expected -eq 'ARMED' -and -not [bool]$arm.liveExecutionArmed) { throw "$Stage expected liveExecutionArmed=true." }
    if ($Expected -eq 'DISARMED' -and [bool]$arm.liveExecutionArmed) { throw "$Stage expected liveExecutionArmed=false." }
}
function Invoke-LiveArmAction([ValidateSet('ARM_LIVE','DISARM_LIVE')] [string]$Action) {
    $preflight = Invoke-ApiPost '/api/v1/phase7c-live-arm-control/preflight' @{ action = $Action }
    if (-not [bool]$preflight.approved -or [string]::IsNullOrWhiteSpace([string]$preflight.preflightToken)) {
        throw "$Action preflight rejected. blockedBy=$(@($preflight.blockedBy) -join ',')"
    }
    $request = Invoke-ApiPost '/api/v1/phase7c-live-arm-control/execute' @{
        action = $Action; preflightToken = [string]$preflight.preflightToken; confirmation = $Action
    }
    $requestId = [string]$request.requestId
    if ([string]::IsNullOrWhiteSpace($requestId)) { throw "$Action execute did not return requestId." }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        try { $status = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/status?requestId=$requestId" } catch { continue }
        if ([string]$status.status -eq 'PASS') { return }
        if ([string]$status.status -eq 'FAIL') { throw "$Action failed. phase=$($status.phase) message=$($status.message)" }
    }
    throw "$Action timed out after $TimeoutSeconds seconds."
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
            $state = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
            if (-not [bool]$state.running -and -not (Test-LifecycleHasAliveProcess -State $state)) { return }
        } catch {}
    }
    throw "Lifecycle did not stop within $TimeoutSeconds seconds."
}
function Wait-LifecycleReadyStable([string]$Stage) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stableSince = 0L
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $ready = $false
        try {
            $state = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
            $ready = [bool]$state.running -and [bool]$state.ready -and [string]$state.mode.mode -eq 'PAUSE' -and [string]$state.accountMode.accountMode -eq 'LIVE' -and [bool]$state.accountMode.valid
        } catch { $ready = $false }
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($ready) {
            if ($stableSince -le 0) { $stableSince = $now }
            if (($now - $stableSince) -ge $ReadyStableMs) {
                Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_READY_STABLE_MS=$ReadyStableMs"
                return
            }
        } else { $stableSince = 0L }
    }
    throw "$Stage lifecycle did not remain continuously READY for $ReadyStableMs ms."
}
function Assert-RuntimeSourceExact([string]$ExpectedCommit, [string]$ExpectedTree, [string]$Stage) {
    $snapshot = Invoke-ApiGet '/api/v1/phase7c/runtime-source-attestation'
    if ([string]$snapshot.overall -ne 'EXACT_MATCH') { throw "$Stage runtime-source overall is not EXACT_MATCH. actual=$($snapshot.overall)" }
    if ($null -eq $snapshot.deployment) { throw "$Stage runtime-source deployment is missing." }
    if ([string]$snapshot.deployment.sourceCommit -ne $ExpectedCommit -or [string]$snapshot.deployment.sourceTree -ne $ExpectedTree) {
        throw "$Stage deployment source mismatch. commit=$($snapshot.deployment.sourceCommit) tree=$($snapshot.deployment.sourceTree)"
    }
    $deploymentId = [string]$snapshot.deployment.deploymentId
    if ([string]::IsNullOrWhiteSpace($deploymentId)) { throw "$Stage runtime-source deploymentId is missing." }
    $components = @($snapshot.components)
    if ($components.Count -ne 8) { throw "$Stage runtime-source requires exactly 8 components. actual=$($components.Count)" }
    foreach ($component in $components) {
        if ([string]$component.verdict -ne 'EXACT_MATCH' -or [string]$component.sourceCommit -ne $ExpectedCommit -or [string]$component.deploymentId -ne $deploymentId) {
            throw "$Stage runtime-source component mismatch. component=$($component.component) verdict=$($component.verdict)"
        }
    }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_RUNTIME_SOURCE_ATTESTATION=8/8_EXACT"
    return $deploymentId
}
function Test-SystemTaskPrincipal($Principal) {
    if ($null -eq $Principal) { return $false }
    $user = ([string]$Principal.UserId).Trim()
    $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
    return $systemUser -and [string]$Principal.LogonType -eq 'ServiceAccount' -and [string]$Principal.RunLevel -eq 'Highest'
}
function Assert-CanonicalTask([string]$Stage) {
    Import-Module ScheduledTasks -ErrorAction Stop
    $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
    $runnerSha = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $runnerSha
    $drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
    if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired -or $drift.Count -ne 0) {
        throw "$Stage Scheduled Task is not exact canonical. ownership=$($ownership.reason) drift=$($drift -join ',')"
    }
    if (-not (Test-SystemTaskPrincipal $task.Principal)) { throw "$Stage Scheduled Task principal is not SYSTEM + ServiceAccount + Highest." }
    if ([string]$task.State -ne 'Running') { throw "$Stage Scheduled Task must be Running. actual=$($task.State)" }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_TASK_OWNERSHIP=PASS"
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
        return [int]$registered.GetInstances(0).Count
    } catch { return -1 }
}
function Assert-LifecycleAlreadyStopped([string]$Stage) {
    $state = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
    if ([bool]$state.running -or (Test-LifecycleHasAliveProcess -State $state)) {
        throw "$Stage ORPHAN_QUEUED lifecycle must already be stopped with no executor process alive."
    }
}
function Assert-CanonicalTaskDefinition($Task, [string]$Stage) {
    $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
    $runnerSha = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
    $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $Task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $runnerSha
    $drift = @(Get-Phase7CExecutorTaskDrift -Task $Task)
    if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired -or $drift.Count -ne 0) {
        throw "$Stage Scheduled Task is not exact canonical. ownership=$($ownership.reason) drift=$($drift -join ',')"
    }
    if (-not (Test-SystemTaskPrincipal $Task.Principal)) { throw "$Stage Scheduled Task principal is not SYSTEM + ServiceAccount + Highest." }
}
function Assert-OrphanQueuedRuntimeState([string]$Stage) {
    Import-Module ScheduledTasks -ErrorAction Stop
    if ($ExpectedInitialArm -ne 'DISARMED') { throw 'ORPHAN_QUEUED requires initial DISARMED ARM state.' }
    Assert-LifecycleAlreadyStopped -Stage $Stage
    $orphanTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Assert-CanonicalTaskDefinition -Task $orphanTask -Stage $Stage
    $orphanCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $orphanTask
    $orphanRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
    $orphanGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $eligible = `
        [string]$orphanTask.State -eq 'Queued' -and `
        $orphanCanonicalProcessCount -eq 0 -and `
        $orphanRunningInstanceCount -eq 0 -and `
        [string]$orphanGeneration.statusReadState -eq 'OK' -and `
        [string]$orphanGeneration.heartbeatReadState -eq 'OK' -and `
        [bool]$orphanGeneration.brokerStatusPidMatch -and `
        -not [bool]$orphanGeneration.brokerProcessAlive -and `
        -not [bool]$orphanGeneration.brokerHeartbeatFresh -and `
        [string]$orphanGeneration.startupRunnerLockState -in @('MISSING','RELEASED')
    if (-not $eligible) {
        throw "$Stage ORPHAN_QUEUED state mismatch. taskState=$($orphanTask.State) canonicalProcesses=$orphanCanonicalProcessCount runningInstances=$orphanRunningInstanceCount brokerAlive=$($orphanGeneration.brokerProcessAlive) heartbeatFresh=$($orphanGeneration.brokerHeartbeatFresh) lock=$($orphanGeneration.startupRunnerLockState)"
    }
    return [pscustomobject]@{
        task = $orphanTask
        previousBrokerPid = [int]$orphanGeneration.heartbeatBrokerPid
    }
}
function Get-AttestationComponent($Snapshot, [string]$Name) {
    return @($Snapshot.components | Where-Object { [string]$_.component -eq $Name }) | Select-Object -First 1
}
function Assert-StoppedLifecycleAttestationShape($Snapshot, [string]$ExpectedCommit, [string]$ExpectedDeploymentId, [string]$Stage) {
    $components = @($Snapshot.components)
    if ($components.Count -ne 8) { throw "$Stage STOPPED_LIFECYCLE requires exactly 8 runtime-source components. actual=$($components.Count)" }

    $brokerComponent = Get-AttestationComponent -Snapshot $Snapshot -Name 'lifecycle-broker'
    if ($null -eq $brokerComponent -or [string]$brokerComponent.verdict -ne 'EXACT_MATCH') {
        throw "$Stage STOPPED_LIFECYCLE requires lifecycle-broker EXACT_MATCH."
    }
    if ([string]$brokerComponent.sourceCommit -ne $ExpectedCommit -or [string]$brokerComponent.deploymentId -ne $ExpectedDeploymentId) {
        throw "$Stage STOPPED_LIFECYCLE lifecycle-broker deployment identity mismatch. commit=$($brokerComponent.sourceCommit) deployment=$($brokerComponent.deploymentId)"
    }

    $oldCommits = @()
    $oldDeployments = @()
    foreach ($name in $StoppedLifecycleMismatchComponents) {
        $component = Get-AttestationComponent -Snapshot $Snapshot -Name $name
        if ($null -eq $component -or [string]$component.verdict -ne 'MISMATCH') {
            throw "$Stage STOPPED_LIFECYCLE requires generation MISMATCH for $name. actual=$([string]$component.verdict)"
        }
        $reasons = @($component.reasonCodes | ForEach-Object { [string]$_ })
        foreach ($requiredReason in $ExpectedGenerationMismatchReasons) {
            if ($requiredReason -notin $reasons) {
                throw "$Stage STOPPED_LIFECYCLE $name mismatch is missing $requiredReason. reasons=$($reasons -join ',')"
            }
        }
        $unexpectedReasons = @($reasons | Where-Object { $_ -notin $ExpectedGenerationMismatchReasons })
        if ($unexpectedReasons.Count -ne 0) {
            throw "$Stage STOPPED_LIFECYCLE refuses non-generation mismatch for $name. unexpected=$($unexpectedReasons -join ',')"
        }
        if ([string]::IsNullOrWhiteSpace([string]$component.sourceCommit) -or [string]::IsNullOrWhiteSpace([string]$component.deploymentId)) {
            throw "$Stage STOPPED_LIFECYCLE requires complete previous generation identity for $name."
        }
        $oldCommits += [string]$component.sourceCommit
        $oldDeployments += [string]$component.deploymentId
    }
    $uniqueOldCommits = @($oldCommits | Sort-Object -Unique)
    $uniqueOldDeployments = @($oldDeployments | Sort-Object -Unique)
    if ($uniqueOldCommits.Count -ne 1 -or $uniqueOldDeployments.Count -ne 1) {
        throw "$Stage STOPPED_LIFECYCLE requires all seven non-broker components on one previous generation."
    }
    if ($uniqueOldCommits[0] -eq $ExpectedCommit -or $uniqueOldDeployments[0] -eq $ExpectedDeploymentId) {
        throw "$Stage STOPPED_LIFECYCLE previous generation must differ from the accepted lifecycle-broker generation."
    }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_STOPPED_LIFECYCLE_ATTESTATION=PASS|PREVIOUS_COMMIT=$($uniqueOldCommits[0])|PREVIOUS_DEPLOYMENT_ID=$($uniqueOldDeployments[0])"
    return [pscustomobject]@{ previousCommit = $uniqueOldCommits[0]; previousDeploymentId = $uniqueOldDeployments[0] }
}
function Assert-StoppedLifecycleRuntimeState([string]$ExpectedCommit, [string]$ExpectedTree, [string]$Stage) {
    Import-Module ScheduledTasks -ErrorAction Stop
    if ($ExpectedInitialArm -ne 'DISARMED') { throw 'STOPPED_LIFECYCLE requires initial DISARMED ARM state.' }

    $lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
    if ([bool]$lifecycle.running -or (Test-LifecycleHasAliveProcess -State $lifecycle)) {
        throw "$Stage STOPPED_LIFECYCLE lifecycle must already be stopped with no executor process alive."
    }
    if (-not [bool]$lifecycle.broker.ready -or $null -eq $lifecycle.broker.heartbeat) {
        throw "$Stage STOPPED_LIFECYCLE requires a ready lifecycle broker with heartbeat evidence."
    }
    if ([string]$lifecycle.broker.heartbeat.state -ne 'IDLE' -or [string]$lifecycle.broker.heartbeat.desiredExecutorState -ne 'STOPPED') {
        throw "$Stage STOPPED_LIFECYCLE broker must be IDLE with desiredExecutorState=STOPPED. state=$($lifecycle.broker.heartbeat.state) desired=$($lifecycle.broker.heartbeat.desiredExecutorState)"
    }
    if ([string]$lifecycle.mode.mode -ne 'PAUSE' -or [string]$lifecycle.accountMode.accountMode -ne 'LIVE' -or -not [bool]$lifecycle.accountMode.valid) {
        throw "$Stage STOPPED_LIFECYCLE requires PAUSE + valid LIVE account state."
    }

    $stoppedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Assert-CanonicalTaskDefinition -Task $stoppedTask -Stage $Stage
    $stoppedCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $stoppedTask
    $stoppedRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
    $stoppedGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $lifecycleBrokerPid = [int]$lifecycle.broker.heartbeat.brokerPid
    $eligible = `
        [string]$stoppedTask.State -eq 'Running' -and `
        $stoppedCanonicalProcessCount -eq 1 -and `
        $stoppedRunningInstanceCount -eq 1 -and `
        [string]$stoppedGeneration.statusReadState -eq 'OK' -and `
        [string]$stoppedGeneration.heartbeatReadState -eq 'OK' -and `
        [bool]$stoppedGeneration.brokerStatusPidMatch -and `
        [bool]$stoppedGeneration.brokerProcessAlive -and `
        [bool]$stoppedGeneration.brokerHeartbeatFresh -and `
        [string]$stoppedGeneration.startupRunnerLockState -eq 'HELD' -and `
        $lifecycleBrokerPid -gt 0 -and `
        $lifecycleBrokerPid -eq [int]$stoppedGeneration.heartbeatBrokerPid
    if (-not $eligible) {
        throw "$Stage STOPPED_LIFECYCLE state mismatch. taskState=$($stoppedTask.State) canonicalProcesses=$stoppedCanonicalProcessCount runningInstances=$stoppedRunningInstanceCount brokerAlive=$($stoppedGeneration.brokerProcessAlive) heartbeatFresh=$($stoppedGeneration.brokerHeartbeatFresh) lock=$($stoppedGeneration.startupRunnerLockState) lifecycleBrokerPid=$lifecycleBrokerPid generationBrokerPid=$($stoppedGeneration.heartbeatBrokerPid)"
    }

    $snapshot = Invoke-ApiGet '/api/v1/phase7c/runtime-source-attestation'
    if ($null -eq $snapshot.deployment) { throw "$Stage STOPPED_LIFECYCLE runtime-source deployment is missing." }
    if ([string]$snapshot.deployment.sourceCommit -ne $ExpectedCommit -or [string]$snapshot.deployment.sourceTree -ne $ExpectedTree) {
        throw "$Stage STOPPED_LIFECYCLE deployment identity mismatch. commit=$($snapshot.deployment.sourceCommit) tree=$($snapshot.deployment.sourceTree)"
    }
    $deploymentId = [string]$snapshot.deployment.deploymentId
    if ([string]::IsNullOrWhiteSpace($deploymentId)) { throw "$Stage STOPPED_LIFECYCLE deploymentId is missing." }
    $attestationEvidence = Assert-StoppedLifecycleAttestationShape -Snapshot $snapshot -ExpectedCommit $ExpectedCommit -ExpectedDeploymentId $deploymentId -Stage $Stage
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_STOPPED_LIFECYCLE=PASS|BROKER_PID=$lifecycleBrokerPid|DEPLOYMENT_ID=$deploymentId"
    return [pscustomobject]@{
        deploymentId = $deploymentId
        brokerPid = $lifecycleBrokerPid
        previousCommit = [string]$attestationEvidence.previousCommit
        previousDeploymentId = [string]$attestationEvidence.previousDeploymentId
    }
}
function Assert-RuntimeSourceDeploymentIdentity([string]$ExpectedCommit, [string]$ExpectedTree, [string]$Stage) {
    $snapshot = Invoke-ApiGet '/api/v1/phase7c/runtime-source-attestation'
    if ($null -eq $snapshot.deployment) { throw "$Stage runtime-source deployment is missing." }
    if ([string]$snapshot.deployment.sourceCommit -ne $ExpectedCommit -or [string]$snapshot.deployment.sourceTree -ne $ExpectedTree) {
        throw "$Stage runtime-source deployment identity mismatch. commit=$($snapshot.deployment.sourceCommit) tree=$($snapshot.deployment.sourceTree)"
    }
    $deploymentId = [string]$snapshot.deployment.deploymentId
    if ([string]::IsNullOrWhiteSpace($deploymentId)) { throw "$Stage runtime-source deploymentId is missing." }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_${Stage}_DEPLOYMENT_IDENTITY=PASS|DEPLOYMENT_ID=$deploymentId"
    return $deploymentId
}
function Clear-OrphanQueueAndBootBroker([int]$PreviousBrokerPid, [string]$ExpectedBridgeSession) {
    $orphanEvidence = Assert-OrphanQueuedRuntimeState -Stage 'ORPHAN_QUEUED_PRE_CLEAR'
    Assert-Pause -Stage 'ORPHAN_QUEUED_PRE_CLEAR'
    Assert-Arm -Expected 'DISARMED' -Stage 'ORPHAN_QUEUED_PRE_CLEAR'
    Assert-BridgeSession -ExpectedSession $ExpectedBridgeSession -Stage 'ORPHAN_QUEUED_PRE_CLEAR'
    Assert-FlatBroker -Stage 'ORPHAN_QUEUED_PRE_CLEAR'
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $clearDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    $cleared = $false
    do {
        Start-Sleep -Milliseconds 250
        $taskNow = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $processCount = Get-Phase7CCanonicalTaskProcessCount -Task $taskNow
        $instanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
        $generationNow = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
        if ([string]$taskNow.State -notin @('Running','Queued') -and $processCount -eq 0 -and $instanceCount -eq 0 -and -not [bool]$generationNow.brokerProcessAlive -and [string]$generationNow.startupRunnerLockState -in @('MISSING','RELEASED')) {
            $cleared = $true
            break
        }
    } while ([DateTime]::UtcNow -lt $clearDeadline)
    if (-not $cleared) { throw 'ORPHAN_QUEUED request did not clear to an inactive, process-free, released-lock state.' }
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORPHAN_QUEUED_CLEAR=PASS'

    $taskBeforeStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Assert-CanonicalTaskDefinition -Task $taskBeforeStart -Stage 'ORPHAN_QUEUED_PRE_BROKER_BOOT'
    Assert-Pause -Stage 'ORPHAN_QUEUED_PRE_BROKER_BOOT'
    Assert-Arm -Expected 'DISARMED' -Stage 'ORPHAN_QUEUED_PRE_BROKER_BOOT'
    Assert-BridgeSession -ExpectedSession $ExpectedBridgeSession -Stage 'ORPHAN_QUEUED_PRE_BROKER_BOOT'
    Assert-FlatBroker -Stage 'ORPHAN_QUEUED_PRE_BROKER_BOOT'
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $bootDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 60))
    $brokerPid = 0
    do {
        Start-Sleep -Milliseconds 250
        $taskNow = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $generationNow = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
        $processCount = Get-Phase7CCanonicalTaskProcessCount -Task $taskNow
        $instanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
        if ([string]$taskNow.State -eq 'Running' -and [bool]$generationNow.brokerProcessAlive -and [bool]$generationNow.brokerHeartbeatFresh -and [bool]$generationNow.brokerStatusPidMatch -and [string]$generationNow.startupRunnerLockState -eq 'HELD' -and $processCount -eq 1 -and $instanceCount -eq 1) {
            $brokerPid = [int]$generationNow.heartbeatBrokerPid
            if ($brokerPid -gt 0 -and $brokerPid -ne $PreviousBrokerPid) { break }
        }
        $brokerPid = 0
    } while ([DateTime]::UtcNow -lt $bootDeadline)
    if ($brokerPid -le 0) { throw "ORPHAN_QUEUED broker boot did not produce one fresh canonical task instance. previousPid=$PreviousBrokerPid" }
    Assert-CanonicalTask -Stage 'ORPHAN_QUEUED_POST_BROKER_BOOT'
    Assert-Pause -Stage 'ORPHAN_QUEUED_POST_BROKER_BOOT'
    Assert-Arm -Expected 'DISARMED' -Stage 'ORPHAN_QUEUED_POST_BROKER_BOOT'
    Assert-BridgeSession -ExpectedSession $ExpectedBridgeSession -Stage 'ORPHAN_QUEUED_POST_BROKER_BOOT'
    Assert-FlatBroker -Stage 'ORPHAN_QUEUED_POST_BROKER_BOOT'
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORPHAN_QUEUED_BROKER_BOOT=PASS|BROKER_PID=$brokerPid"
}

# Git/remote provenance and target-object staging happen before any LIVE runtime mutation.
Push-Location $ProjectRoot
try {
    $branch = ([string](& $gitExe branch --show-current)).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Production checkout must be branch main. actual=$branch" }
    $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Production worktree must be clean.' }
    $head = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedCurrentCommit) { throw "Current HEAD mismatch. expected=$ExpectedCurrentCommit actual=$head" }
    $currentTree = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`^{tree}")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $currentTree -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve current source tree.' }

    $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
    if ($LASTEXITCODE -ne 0 -or $ExpectedOriginUrls -notcontains $originUrl) { throw "Unexpected origin remote. actual=$originUrl" }
    $remoteMainRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
    if ($LASTEXITCODE -ne 0 -or $remoteMainRaw.Count -ne 1) { throw 'Could not prove canonical origin/main.' }
    $remoteMain = ([string]$remoteMainRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
    if ($remoteMain -ne $ExpectedRemoteMainCommit) { throw "origin/main pin mismatch. expected=$ExpectedRemoteMainCommit actual=$remoteMain" }

    & $gitExe fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) { throw 'Could not pre-stage canonical origin/main.' }
    $originMain = ([string](& $gitExe rev-parse refs/remotes/origin/main)).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $originMain -ne $ExpectedRemoteMainCommit) { throw "Pre-staged origin/main mismatch. expected=$ExpectedRemoteMainCommit actual=$originMain" }

    $remoteHelperLine = @(& $gitExe ls-tree $ExpectedRemoteMainCommit -- $HelperRepoPath)
    if ($LASTEXITCODE -ne 0 -or $remoteHelperLine.Count -ne 1) { throw 'Pinned remote main does not contain the rollout helper.' }
    $remoteHelperParts = @(([string]$remoteHelperLine[0]) -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($remoteHelperParts.Count -lt 4 -or [string]$remoteHelperParts[1] -ne 'blob' -or ([string]$remoteHelperParts[2]).ToLowerInvariant() -ne $ExpectedHelperBlobSha1) {
        throw "Pinned remote-main helper blob mismatch. expected=$ExpectedHelperBlobSha1 actual=$([string]$remoteHelperParts[2])"
    }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_HELPER_REMOTE_PROVENANCE=PASS|REMOTE_MAIN=$ExpectedRemoteMainCommit|BLOB=$ExpectedHelperBlobSha1"

    & $gitExe cat-file -e "$TargetCommit`^{commit}"
    if ($LASTEXITCODE -ne 0) { throw 'Target commit object is unavailable after pre-stage.' }
    $targetTree = ([string](& $gitExe rev-parse "$TargetCommit`^{tree}")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $targetTree -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve target source tree.' }
    & $gitExe merge-base --is-ancestor $ExpectedCurrentCommit $TargetCommit
    if ($LASTEXITCODE -ne 0) { throw 'Target commit is not a fast-forward descendant of ExpectedCurrentCommit.' }
    & $gitExe merge-base --is-ancestor $TargetCommit $ExpectedRemoteMainCommit
    if ($LASTEXITCODE -ne 0) { throw 'Target commit is not reachable from pinned remote main.' }
    if ($ExpectedInitialRuntimeState -eq 'ORPHAN_QUEUED') {
        $currentRunnerBlob = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $currentRunnerBlob -notmatch '^[0-9a-f]{40}$') { throw 'ORPHAN_QUEUED could not resolve current runner blob.' }
        $targetRunnerBlob = ([string](& $gitExe rev-parse "$TargetCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $targetRunnerBlob -notmatch '^[0-9a-f]{40}$') { throw 'ORPHAN_QUEUED could not resolve target runner blob.' }
        if ($currentRunnerBlob -ne $targetRunnerBlob) { throw "ORPHAN_QUEUED guarded runner blob must remain unchanged across source transition. current=$currentRunnerBlob target=$targetRunnerBlob" }
        Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORPHAN_QUEUED_RUNNER_BLOB_UNCHANGED=PASS|BLOB=$currentRunnerBlob"
    }    elseif ($ExpectedInitialRuntimeState -eq 'STOPPED_LIFECYCLE') {
        $currentRunnerBlob = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $currentRunnerBlob -notmatch '^[0-9a-f]{40}$') { throw 'STOPPED_LIFECYCLE could not resolve current runner blob.' }
        $targetRunnerBlob = ([string](& $gitExe rev-parse "$TargetCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $targetRunnerBlob -notmatch '^[0-9a-f]{40}$') { throw 'STOPPED_LIFECYCLE could not resolve target runner blob.' }
        if ($currentRunnerBlob -ne $targetRunnerBlob) { throw "STOPPED_LIFECYCLE guarded runner blob must remain unchanged across source transition. current=$currentRunnerBlob target=$targetRunnerBlob" }
        Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_STOPPED_LIFECYCLE_RUNNER_BLOB_UNCHANGED=PASS|BLOB=$currentRunnerBlob"
    }

    $targetPaths = @(& $gitExe ls-tree -r --name-only $TargetCommit)
    foreach ($requiredTargetPath in @(
        'scripts/recover-phase7c-runtime-ready-stable-deploy-local.ps1',
        'scripts/verify-phase7c-p3-production-acceptance-local.ps1',
        'scripts/verify-phase7c-p4-production-acceptance-local.ps1'
    )) {
        if ($targetPaths -notcontains $requiredTargetPath) { throw "Target commit lacks required canonical rollout dependency: $requiredTargetPath" }
    }
    $dirtyAfterFetch = @(& $gitExe status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or $dirtyAfterFetch.Count -ne 0) { throw 'Pre-stage fetch changed the production worktree.' }
} finally { Pop-Location }
Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_GIT_PREFLIGHT=PASS|CURRENT=$ExpectedCurrentCommit|TARGET=$TargetCommit|REMOTE_MAIN=$ExpectedRemoteMainCommit"
Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_GIT_MODE=EXACT_FF_ONLY'

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
if ([int]$config.version -ne 2) { throw 'Production rollout requires executor task config version 2.' }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE' -or -not [bool]$config.liveExecutionEnabled -or -not [bool]$config.armed) {
    throw 'Production rollout requires canonical LIVE task config with liveExecutionEnabled=true and armed=true.'
}
$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') { throw "Control API must be explicit loopback URL with port. actual=$ControlApiUrl" }
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

Assert-Pause -Stage 'PREFLIGHT'
Assert-Arm -Expected $ExpectedInitialArm -Stage 'PREFLIGHT'
$healthBefore = Get-BridgeHealth
if (-not [bool]$healthBefore.connected -or [string]$healthBefore.status -ne 'ok' -or [string]$healthBefore.configuredAccountMode -ne 'LIVE' -or [string]$healthBefore.accountMode -ne 'real') {
    throw 'PREFLIGHT Bridge must be healthy LIVE/real.'
}
$bridgeSessionId = [string]$healthBefore.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw 'PREFLIGHT bridgeSessionId is missing.' }
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'PREFLIGHT'
Assert-FlatBroker -Stage 'PREFLIGHT'
$orphanPreviousBrokerPid = 0
if ($ExpectedInitialRuntimeState -eq 'HEALTHY') {
    Assert-CanonicalTask -Stage 'PREFLIGHT'
    Wait-LifecycleReadyStable -Stage 'PREFLIGHT'
    $oldDeploymentId = Assert-RuntimeSourceExact -ExpectedCommit $ExpectedCurrentCommit -ExpectedTree $currentTree -Stage 'PREFLIGHT'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_RUNTIME_STATE=HEALTHY'
} elseif ($ExpectedInitialRuntimeState -eq 'ORPHAN_QUEUED') {
    $orphanEvidence = Assert-OrphanQueuedRuntimeState -Stage 'PREFLIGHT'
    $orphanPreviousBrokerPid = [int]$orphanEvidence.previousBrokerPid
    $oldDeploymentId = Assert-RuntimeSourceDeploymentIdentity -ExpectedCommit $ExpectedCurrentCommit -ExpectedTree $currentTree -Stage 'PREFLIGHT'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_RUNTIME_STATE=ORPHAN_QUEUED'
} elseif ($ExpectedInitialRuntimeState -eq 'STOPPED_LIFECYCLE') {
    $stoppedEvidence = Assert-StoppedLifecycleRuntimeState -ExpectedCommit $ExpectedCurrentCommit -ExpectedTree $currentTree -Stage 'PREFLIGHT'
    $oldDeploymentId = [string]$stoppedEvidence.deploymentId
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_RUNTIME_STATE=STOPPED_LIFECYCLE'
}
Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREVIOUS_DEPLOYMENT_ID=$oldDeploymentId"
Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_MODE=PAUSE'
Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_PREFLIGHT_ARM=$ExpectedInitialArm"
Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORDER_MUTATION=NONE'
Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_POSITION_MUTATION=NONE'
Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIVE_TEST_ORDER=NONE'
Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_MUTATION_ORDER=STOP_THEN_DISARM'

$mutationStarted = $false
try {
    $mutationStarted = $true

    if ($ExpectedInitialRuntimeState -eq 'HEALTHY') {
        [void](Invoke-ApiPost '/api/v1/phase7c/lifecycle/stop' @{})
        Wait-LifecycleStopped
        Assert-Pause -Stage 'POST_LIFECYCLE_STOP_PRE_DISARM'
        Assert-Arm -Expected $ExpectedInitialArm -Stage 'POST_LIFECYCLE_STOP_PRE_DISARM'
        Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_LIFECYCLE_STOP_PRE_DISARM'
        Assert-FlatBroker -Stage 'POST_LIFECYCLE_STOP_PRE_DISARM'
        Assert-CanonicalTask -Stage 'POST_LIFECYCLE_STOP_PRE_DISARM'
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIFECYCLE_STOP=PASS'
    } elseif ($ExpectedInitialRuntimeState -eq 'ORPHAN_QUEUED') {
        [void](Assert-OrphanQueuedRuntimeState -Stage 'PRE_DISARM')
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIFECYCLE_STOP=SKIPPED_ALREADY_STOPPED'
    } elseif ($ExpectedInitialRuntimeState -eq 'STOPPED_LIFECYCLE') {
        [void](Assert-StoppedLifecycleRuntimeState -ExpectedCommit $ExpectedCurrentCommit -ExpectedTree $currentTree -Stage 'PRE_DISARM')
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STOPPED_LIFECYCLE_LIFECYCLE_STOP=SKIPPED_ALREADY_STOPPED'
    }

    if ($ExpectedInitialArm -eq 'ARMED') {
        Invoke-LiveArmAction -Action 'DISARM_LIVE'
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_DISARM=PASS'
    } elseif ($ExpectedInitialArm -eq 'DISARMED') {
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_DISARM=SKIPPED_ALREADY_DISARMED'
    }
    Assert-Arm -Expected 'DISARMED' -Stage 'POST_DISARM'
    Assert-Pause -Stage 'POST_DISARM'
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_DISARM'
    Assert-FlatBroker -Stage 'POST_DISARM'
    if ($ExpectedInitialRuntimeState -eq 'HEALTHY') {
        Wait-LifecycleStopped
        Assert-CanonicalTask -Stage 'POST_DISARM'
    } elseif ($ExpectedInitialRuntimeState -eq 'ORPHAN_QUEUED') {
        [void](Assert-OrphanQueuedRuntimeState -Stage 'POST_DISARM')
    } elseif ($ExpectedInitialRuntimeState -eq 'STOPPED_LIFECYCLE') {
        [void](Assert-StoppedLifecycleRuntimeState -ExpectedCommit $ExpectedCurrentCommit -ExpectedTree $currentTree -Stage 'POST_DISARM')
    }

    Push-Location $ProjectRoot
    try {
        $headBeforeMerge = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
        $branchBeforeMerge = ([string](& $gitExe branch --show-current)).Trim()
        $dirtyBeforeMerge = @(& $gitExe status --porcelain --untracked-files=normal)
        if ($headBeforeMerge -ne $ExpectedCurrentCommit -or $branchBeforeMerge -ne 'main' -or $dirtyBeforeMerge.Count -ne 0) {
            throw 'Production source changed after preflight and before fast-forward mutation.'
        }
        & $gitExe merge --ff-only $TargetCommit
        if ($LASTEXITCODE -ne 0) { throw 'Exact fast-forward source transition failed.' }
        $headAfterMerge = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
        $branchAfterMerge = ([string](& $gitExe branch --show-current)).Trim()
        $dirtyAfterMerge = @(& $gitExe status --porcelain --untracked-files=normal)
        if ($headAfterMerge -ne $TargetCommit -or $branchAfterMerge -ne 'main' -or $dirtyAfterMerge.Count -ne 0) {
            throw "Fast-forward postcondition failed. head=$headAfterMerge branch=$branchAfterMerge dirty=$($dirtyAfterMerge.Count)"
        }
    } finally { Pop-Location }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_GIT_FAST_FORWARD=PASS|HEAD=$TargetCommit"

    if ($ExpectedInitialRuntimeState -eq 'ORPHAN_QUEUED') {
        [void](Assert-OrphanQueuedRuntimeState -Stage 'POST_FAST_FORWARD')
        Clear-OrphanQueueAndBootBroker -PreviousBrokerPid $orphanPreviousBrokerPid -ExpectedBridgeSession $bridgeSessionId
    } elseif ($ExpectedInitialRuntimeState -eq 'STOPPED_LIFECYCLE') {
        [void](Assert-StoppedLifecycleRuntimeState -ExpectedCommit $ExpectedCurrentCommit -ExpectedTree $currentTree -Stage 'POST_FAST_FORWARD')
        Assert-Pause -Stage 'STOPPED_LIFECYCLE_POST_FAST_FORWARD'
        Assert-Arm -Expected 'DISARMED' -Stage 'STOPPED_LIFECYCLE_POST_FAST_FORWARD'
        Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'STOPPED_LIFECYCLE_POST_FAST_FORWARD'
        Assert-FlatBroker -Stage 'STOPPED_LIFECYCLE_POST_FAST_FORWARD'
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STOPPED_LIFECYCLE_POST_FAST_FORWARD=PASS'
    }

    foreach ($targetFile in @($RecoveryPath, $P3VerifierPath, $P4VerifierPath)) {
        if (-not (Test-Path -LiteralPath $targetFile -PathType Leaf)) { throw "Target rollout dependency missing after fast-forward: $targetFile" }
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RecoveryPath -ExpectedCommit $TargetCommit -TimeoutSeconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw "Canonical runtime-ready recovery deploy failed with exit code $LASTEXITCODE." }
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_CANONICAL_RECOVERY_DEPLOY=PASS'

    Assert-Pause -Stage 'POST_DEPLOY'
    Assert-Arm -Expected 'DISARMED' -Stage 'POST_DEPLOY'
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_DEPLOY'
    Assert-FlatBroker -Stage 'POST_DEPLOY'
    Wait-LifecycleReadyStable -Stage 'POST_DEPLOY'
    $newDeploymentId = Assert-RuntimeSourceExact -ExpectedCommit $TargetCommit -ExpectedTree $targetTree -Stage 'POST_DEPLOY'
    if ($newDeploymentId -eq $oldDeploymentId) { throw 'Target rollout did not create a new deployment identity.' }
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_NEW_DEPLOYMENT_ID=$newDeploymentId"

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $P3VerifierPath -ProjectRoot $ProjectRoot -ExpectedCommit $TargetCommit -ApiBaseUrl $ControlApiUrl
    if ($LASTEXITCODE -ne 0) { throw "P3 production acceptance failed with exit code $LASTEXITCODE." }
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_P3_ACCEPTANCE=PASS'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $P4VerifierPath -ProjectRoot $ProjectRoot -ExpectedCommit $TargetCommit -ApiBaseUrl $ControlApiUrl
    if ($LASTEXITCODE -ne 0) { throw "P4 production acceptance failed with exit code $LASTEXITCODE." }
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_P4_ACCEPTANCE=PASS'

    Assert-Pause -Stage 'PRE_ARM_RESTORE'
    Assert-Arm -Expected 'DISARMED' -Stage 'PRE_ARM_RESTORE'
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'PRE_ARM_RESTORE'
    Assert-FlatBroker -Stage 'PRE_ARM_RESTORE'
    Wait-LifecycleReadyStable -Stage 'PRE_ARM_RESTORE'
    [void](Assert-RuntimeSourceExact -ExpectedCommit $TargetCommit -ExpectedTree $targetTree -Stage 'PRE_ARM_RESTORE')

    if ($ExpectedInitialArm -eq 'ARMED') {
        Invoke-LiveArmAction -Action 'ARM_LIVE'
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ARM_RESTORE=PERFORMED'
    } else {
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ARM_RESTORE=SKIPPED_INITIAL_DISARMED'
    }
    Assert-Pause -Stage 'FINAL'
    Assert-Arm -Expected $ExpectedInitialArm -Stage 'FINAL'
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'FINAL'
    Assert-FlatBroker -Stage 'FINAL'
    Wait-LifecycleReadyStable -Stage 'FINAL'
    $finalDeploymentId = Assert-RuntimeSourceExact -ExpectedCommit $TargetCommit -ExpectedTree $targetTree -Stage 'FINAL'
    if ($finalDeploymentId -ne $newDeploymentId) { throw 'Deployment identity changed after production acceptance/ARM-state preservation.' }

    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_FINAL_MODE=PAUSE'
    Write-Host "PHASE7C_PRODUCTION_SOURCE_TRANSITION_FINAL_ARM=$ExpectedInitialArm"
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_BRIDGE_SESSION_UNCHANGED=PASS'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_ORDER_MUTATION=NONE'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_POSITION_MUTATION=NONE'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_LIVE_TEST_ORDER=NONE'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_MUTATION_ORDER=STOP_THEN_DISARM'
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STATUS=PASS'
} catch {
    $failure = $_
    if ($mutationStarted) {
        Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_FAIL_CLOSED=PAUSE_STOP_DISARMED_BEST_EFFORT'
        try {
            $mode = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
            if ([string]$mode.state.mode -ne 'PAUSE') {
                [void](Invoke-ApiPost '/api/v1/phase7c/bot-mode' @{ mode = 'PAUSE'; source = 'production-source-transition-failclosed' })
            }
        } catch { Write-Warning "Fail-closed PAUSE best effort failed: $($_.Exception.Message)" }
        try {
            $lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
            if ([bool]$lifecycle.running -or (Test-LifecycleHasAliveProcess -State $lifecycle)) {
                [void](Invoke-ApiPost '/api/v1/phase7c/lifecycle/stop' @{})
                Wait-LifecycleStopped
            }
        } catch { Write-Warning "Fail-closed STOP best effort failed: $($_.Exception.Message)" }
        try {
            $arm = Get-ArmCapability
            if ([string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) { Invoke-LiveArmAction -Action 'DISARM_LIVE' }
        } catch { Write-Warning "Fail-closed DISARM best effort failed: $($_.Exception.Message)" }
    }
    Write-Host 'PHASE7C_PRODUCTION_SOURCE_TRANSITION_STATUS=FAIL'
    throw $failure
}