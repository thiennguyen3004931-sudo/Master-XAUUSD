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
$HelperRepoPath = 'scripts/transition-phase7c-failed-stopped-broker-source-local.ps1'
$RunnerRepoPath = 'scripts/run-phase7c-executor-task-runner-local.ps1'
$ExpectedOriginUrls = @(
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master',
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git',
    'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master.git'
)

Write-Host '============================================================'
Write-Host '=== PHASE7C FAILED_STOPPED_BROKER — SOURCE TRANSITION ONLY ==='
Write-Host '============================================================'
Write-Host 'RECOVERY_STATE=FAILED_STOPPED_BROKER'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'LIFECYCLE_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'
Write-Host 'RUNTIME_READY_BYPASS=NONE'
Write-Host 'GIT_MUTATION=EXACT_FF_ONLY_AFTER_ALL_GATES'

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "ProjectRoot does not exist: $ProjectRoot"
}
foreach ($value in @($ExpectedCurrentCommit, $TargetCommit, $ExpectedRemoteMainCommit, $ExpectedHelperBlobSha1)) {
    if ($value -notmatch '^[0-9a-f]{40}$') {
        throw 'All commit/blob provenance inputs must be exact 40-character hex identifiers.'
    }
}
if ($ExpectedCurrentCommit -eq $TargetCommit) {
    throw 'FAILED_STOPPED_BROKER source transition requires a distinct target commit.'
}
if ($TargetCommit -ne $ExpectedRemoteMainCommit) {
    throw 'FAILED_STOPPED_BROKER requires TargetCommit to equal the pinned canonical origin/main commit exactly.'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
    throw 'FAILED_STOPPED_BROKER helper must execute from a real external file.'
}

$ScriptsRoot = Join-Path $ProjectRoot 'scripts'
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ScriptsRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeOwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$gitExe = (Get-Command git -ErrorAction Stop).Source

foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required current-generation dependency is missing: $required"
    }
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

function Test-LifecycleHasAliveProcess($State) {
    if ($null -eq $State -or $null -eq $State.processes) { return $true }
    foreach ($property in @($State.processes.PSObject.Properties)) {
        if ($null -ne $property.Value -and [bool]$property.Value.alive) { return $true }
    }
    return $false
}

function Test-SystemTaskPrincipal($Principal) {
    if ($null -eq $Principal) { return $false }
    $user = ([string]$Principal.UserId).Trim()
    $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
    return $systemUser -and [string]$Principal.LogonType -eq 'ServiceAccount' -and [string]$Principal.RunLevel -eq 'Highest'
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

function Test-Phase7CCanonicalTaskDefinition($Task) {
    try {
        $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
        $runnerSha = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
        $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $Task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $runnerSha
        $drift = @(Get-Phase7CExecutorTaskDrift -Task $Task)
        if (-not [bool]$ownership.owned -or -not [bool]$ownership.canonical -or [bool]$ownership.repairRequired -or $drift.Count -ne 0) {
            return $false
        }
        return (Test-SystemTaskPrincipal $Task.Principal)
    } catch {
        return $false
    }
}

function Test-Phase7CFailedStoppedBrokerEligibility {
    param(
        [Parameter(Mandatory = $true)] [string]$ExpectedInitialArm,
        [Parameter(Mandatory = $true)] [bool]$LifecycleRunning,
        [Parameter(Mandatory = $true)] [bool]$LifecycleReady,
        [Parameter(Mandatory = $true)] [bool]$LifecycleHasAliveProcess,
        [Parameter(Mandatory = $true)] [string]$LifecycleMode,
        [Parameter(Mandatory = $true)] [string]$AccountMode,
        [Parameter(Mandatory = $true)] [bool]$AccountModeValid,
        [Parameter(Mandatory = $true)] [bool]$TaskDefinitionCanonical,
        [Parameter(Mandatory = $true)] [string]$TaskState,
        [Parameter(Mandatory = $true)] [int64]$LastTaskResult,
        [Parameter(Mandatory = $true)] [int]$CanonicalTaskProcessCount,
        [Parameter(Mandatory = $true)] [int]$RunningTaskInstanceCount,
        [Parameter(Mandatory = $true)] [string]$StatusReadState,
        [Parameter(Mandatory = $true)] [string]$HeartbeatReadState,
        [Parameter(Mandatory = $true)] [bool]$BrokerStatusPidMatch,
        [Parameter(Mandatory = $true)] [bool]$BrokerProcessAlive,
        [Parameter(Mandatory = $true)] [bool]$BrokerHeartbeatFresh,
        [Parameter(Mandatory = $true)] [string]$StartupRunnerLockState
    )

    return (
        $ExpectedInitialArm -eq 'DISARMED' -and
        -not $LifecycleRunning -and
        -not $LifecycleReady -and
        -not $LifecycleHasAliveProcess -and
        $LifecycleMode -eq 'PAUSE' -and
        $AccountMode -eq 'LIVE' -and
        $AccountModeValid -and
        $TaskDefinitionCanonical -and
        $TaskState -eq 'Ready' -and
        $LastTaskResult -ne 0 -and
        $CanonicalTaskProcessCount -eq 0 -and
        $RunningTaskInstanceCount -eq 0 -and
        $StatusReadState -eq 'OK' -and
        $HeartbeatReadState -eq 'OK' -and
        $BrokerStatusPidMatch -and
        -not $BrokerProcessAlive -and
        -not $BrokerHeartbeatFresh -and
        $StartupRunnerLockState -in @('MISSING','RELEASED')
    )
}

function Assert-Pause([string]$Stage) {
    $mode = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
    if ([string]$mode.state.mode -ne 'PAUSE') {
        throw "$Stage requires bot mode PAUSE. actual=$($mode.state.mode)"
    }
}

function Assert-Disarmed([string]$Stage) {
    $arm = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
    if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) {
        throw "$Stage requires LIVE + DISARMED. status=$($arm.liveArmStatus) liveExecutionArmed=$($arm.liveExecutionArmed)"
    }
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
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_POSITIONS=0"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_PENDING_ORDERS=0"
}

function Assert-FailedStoppedBrokerRuntimeState([string]$Stage) {
    Import-Module ScheduledTasks -ErrorAction Stop

    $lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    $taskDefinitionCanonical = Test-Phase7CCanonicalTaskDefinition -Task $task
    $canonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $task
    $runningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
    $generation = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $lastTaskResult = [int64]$taskInfo.LastTaskResult
    $lifecycleHasAliveProcess = Test-LifecycleHasAliveProcess -State $lifecycle

    $eligible = Test-Phase7CFailedStoppedBrokerEligibility `
        -ExpectedInitialArm 'DISARMED' `
        -LifecycleRunning ([bool]$lifecycle.running) `
        -LifecycleReady ([bool]$lifecycle.ready) `
        -LifecycleHasAliveProcess $lifecycleHasAliveProcess `
        -LifecycleMode ([string]$lifecycle.mode.mode) `
        -AccountMode ([string]$lifecycle.accountMode.accountMode) `
        -AccountModeValid ([bool]$lifecycle.accountMode.valid) `
        -TaskDefinitionCanonical $taskDefinitionCanonical `
        -TaskState ([string]$task.State) `
        -LastTaskResult $lastTaskResult `
        -CanonicalTaskProcessCount $canonicalProcessCount `
        -RunningTaskInstanceCount $runningInstanceCount `
        -StatusReadState ([string]$generation.statusReadState) `
        -HeartbeatReadState ([string]$generation.heartbeatReadState) `
        -BrokerStatusPidMatch ([bool]$generation.brokerStatusPidMatch) `
        -BrokerProcessAlive ([bool]$generation.brokerProcessAlive) `
        -BrokerHeartbeatFresh ([bool]$generation.brokerHeartbeatFresh) `
        -StartupRunnerLockState ([string]$generation.startupRunnerLockState)

    if (-not $eligible) {
        throw "$Stage FAILED_STOPPED_BROKER state mismatch. mode=$($lifecycle.mode.mode) lifecycleRunning=$($lifecycle.running) lifecycleReady=$($lifecycle.ready) aliveExecutors=$lifecycleHasAliveProcess taskCanonical=$taskDefinitionCanonical taskState=$($task.State) lastTaskResult=$lastTaskResult canonicalProcesses=$canonicalProcessCount runningInstances=$runningInstanceCount statusRead=$($generation.statusReadState) heartbeatRead=$($generation.heartbeatReadState) pidMatch=$($generation.brokerStatusPidMatch) brokerAlive=$($generation.brokerProcessAlive) heartbeatFresh=$($generation.brokerHeartbeatFresh) lock=$($generation.startupRunnerLockState)"
    }

    $brokerReady = $false
    $brokerPid = [int64]$generation.heartbeatBrokerPid
    if ($null -ne $lifecycle.broker) {
        try { $brokerReady = [bool]$lifecycle.broker.ready } catch { $brokerReady = $false }
    }

    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_TASK_OWNERSHIP=CANONICAL_SYSTEM"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_TASK_STATE=$($task.State)"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_TASK_LAST_RESULT=$lastTaskResult"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_CANONICAL_TASK_PROCESS_COUNT=$canonicalProcessCount"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_RUNNING_TASK_INSTANCE_COUNT=$runningInstanceCount"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_BROKER_READY=$brokerReady"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_BROKER_PID=$brokerPid"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_BROKER_PROCESS_ALIVE=$($generation.brokerProcessAlive)"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_BROKER_HEARTBEAT_FRESH=$($generation.brokerHeartbeatFresh)"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_${Stage}_STARTUP_LOCK=$($generation.startupRunnerLockState)"

    return [pscustomobject]@{
        task = $task
        lastTaskResult = $lastTaskResult
        brokerPid = $brokerPid
    }
}

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
if ([int]$config.version -ne 2) { throw 'FAILED_STOPPED_BROKER requires executor task config version 2.' }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE' -or -not [bool]$config.liveExecutionEnabled -or -not [bool]$config.armed) {
    throw 'FAILED_STOPPED_BROKER requires canonical LIVE task config with liveExecutionEnabled=true and armed=true.'
}

$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    throw "Control API must be explicit loopback URL with port. actual=$ControlApiUrl"
}
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$actualExternalHelperBlob = ([string](& $gitExe hash-object -- $PSCommandPath)).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actualExternalHelperBlob -ne $ExpectedHelperBlobSha1) {
    throw "External helper provenance mismatch. expectedBlob=$ExpectedHelperBlobSha1 actualBlob=$actualExternalHelperBlob"
}
Write-Host "PHASE7C_FAILED_STOPPED_BROKER_HELPER_FILE_PROVENANCE=PASS|BLOB=$actualExternalHelperBlob"

$currentTree = ''
$targetTree = ''
$currentRunnerBlob = ''
$targetRunnerBlob = ''

# Provenance discovery/staging is allowed before the exact source transition;
# it must not alter the production worktree.
Push-Location $ProjectRoot
try {
    $branch = ([string](& $gitExe branch --show-current)).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Production checkout must be branch main. actual=$branch" }

    $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Production worktree must be clean.' }

    $head = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedCurrentCommit) {
        throw "Current HEAD mismatch. expected=$ExpectedCurrentCommit actual=$head"
    }

    $currentTree = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`^{tree}")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $currentTree -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve current source tree.' }

    $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
    if ($LASTEXITCODE -ne 0 -or $ExpectedOriginUrls -notcontains $originUrl) {
        throw "Unexpected origin remote. actual=$originUrl"
    }

    $remoteMainRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
    if ($LASTEXITCODE -ne 0 -or $remoteMainRaw.Count -ne 1) { throw 'Could not prove canonical origin/main.' }
    $remoteMain = ([string]$remoteMainRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
    if ($remoteMain -ne $ExpectedRemoteMainCommit) {
        throw "origin/main pin mismatch. expected=$ExpectedRemoteMainCommit actual=$remoteMain"
    }

    & $gitExe fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) { throw 'Could not pre-stage canonical origin/main.' }
    $originMain = ([string](& $gitExe rev-parse refs/remotes/origin/main)).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $originMain -ne $ExpectedRemoteMainCommit) {
        throw "Pre-staged origin/main mismatch. expected=$ExpectedRemoteMainCommit actual=$originMain"
    }

    & $gitExe cat-file -e "$TargetCommit`^{commit}"
    if ($LASTEXITCODE -ne 0) { throw 'Target commit object is unavailable after pre-stage.' }
    $targetTree = ([string](& $gitExe rev-parse "$TargetCommit`^{tree}")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $targetTree -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve target source tree.' }

    & $gitExe merge-base --is-ancestor $ExpectedCurrentCommit $TargetCommit
    if ($LASTEXITCODE -ne 0) {
        throw 'Target commit is not a fast-forward descendant of ExpectedCurrentCommit.'
    }

    $targetHelperBlob = ([string](& $gitExe rev-parse "$TargetCommit`:$HelperRepoPath")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $targetHelperBlob -ne $ExpectedHelperBlobSha1) {
        throw "Target helper blob mismatch. expected=$ExpectedHelperBlobSha1 actual=$targetHelperBlob"
    }

    $currentRunnerBlob = ([string](& $gitExe rev-parse "$ExpectedCurrentCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $currentRunnerBlob -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not resolve current scheduled-task runner blob.'
    }
    $targetRunnerBlob = ([string](& $gitExe rev-parse "$TargetCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $targetRunnerBlob -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not resolve target scheduled-task runner blob.'
    }
    if ($currentRunnerBlob -ne $targetRunnerBlob) {
        throw "FAILED_STOPPED_BROKER requires scheduled-task runner blob unchanged across source-only transition. current=$currentRunnerBlob target=$targetRunnerBlob"
    }

    $dirtyAfterFetch = @(& $gitExe status --porcelain --untracked-files=normal)
    if ($LASTEXITCODE -ne 0 -or $dirtyAfterFetch.Count -ne 0) {
        throw 'Pre-stage fetch changed the production worktree.'
    }
} finally {
    Pop-Location
}

Write-Host "PHASE7C_FAILED_STOPPED_BROKER_LOCAL_HEAD=$ExpectedCurrentCommit"
Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_LOCAL_DIRTY_COUNT=0'
Write-Host "PHASE7C_FAILED_STOPPED_BROKER_REMOTE_MAIN=$ExpectedRemoteMainCommit"
Write-Host "PHASE7C_FAILED_STOPPED_BROKER_LOCAL_HELPER_BLOB=$actualExternalHelperBlob"
Write-Host "PHASE7C_FAILED_STOPPED_BROKER_RUNNER_BLOB_UNCHANGED=PASS|BLOB=$currentRunnerBlob"

Assert-Pause -Stage 'PREFLIGHT'
Assert-Disarmed -Stage 'PREFLIGHT'
$healthBefore = Get-BridgeHealth
if (-not [bool]$healthBefore.connected -or [string]$healthBefore.status -ne 'ok' -or [string]$healthBefore.configuredAccountMode -ne 'LIVE' -or [string]$healthBefore.accountMode -ne 'real') {
    throw 'PREFLIGHT bridge must be healthy LIVE/real.'
}
$bridgeSessionId = [string]$healthBefore.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw 'PREFLIGHT bridgeSessionId is missing.' }
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'PREFLIGHT'
Assert-FlatBroker -Stage 'PREFLIGHT'
[void](Assert-FailedStoppedBrokerRuntimeState -Stage 'PREFLIGHT')
Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_PREFLIGHT_STATE=PASS'

$sourceMutationStarted = $false
try {
    # Re-prove every runtime safety gate immediately before the sole mutation.
    Assert-Pause -Stage 'PRE_FAST_FORWARD'
    Assert-Disarmed -Stage 'PRE_FAST_FORWARD'
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'PRE_FAST_FORWARD'
    Assert-FlatBroker -Stage 'PRE_FAST_FORWARD'
    [void](Assert-FailedStoppedBrokerRuntimeState -Stage 'PRE_FAST_FORWARD')

    Push-Location $ProjectRoot
    try {
        $headBeforeMerge = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
        $branchBeforeMerge = ([string](& $gitExe branch --show-current)).Trim()
        $dirtyBeforeMerge = @(& $gitExe status --porcelain --untracked-files=normal)
        if ($headBeforeMerge -ne $ExpectedCurrentCommit -or $branchBeforeMerge -ne 'main' -or $dirtyBeforeMerge.Count -ne 0) {
            throw 'Production source changed after preflight and before fast-forward mutation.'
        }

        $sourceMutationStarted = $true
        & $gitExe merge --ff-only $TargetCommit
        if ($LASTEXITCODE -ne 0) { throw 'Exact fast-forward source transition failed.' }

        $headAfterMerge = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
        $treeAfterMerge = ([string](& $gitExe rev-parse "HEAD^{tree}")).Trim().ToLowerInvariant()
        $branchAfterMerge = ([string](& $gitExe branch --show-current)).Trim()
        $dirtyAfterMerge = @(& $gitExe status --porcelain --untracked-files=normal)
        if ($headAfterMerge -ne $TargetCommit -or $treeAfterMerge -ne $targetTree -or $branchAfterMerge -ne 'main' -or $dirtyAfterMerge.Count -ne 0) {
            throw "Fast-forward postcondition failed. head=$headAfterMerge tree=$treeAfterMerge branch=$branchAfterMerge dirty=$($dirtyAfterMerge.Count)"
        }

        $deployedHelperPath = Join-Path $ProjectRoot ($HelperRepoPath -replace '/', '\')
        if (-not (Test-Path -LiteralPath $deployedHelperPath -PathType Leaf)) {
            throw "Target helper is missing after source transition: $deployedHelperPath"
        }
        $deployedHelperBlob = ([string](& $gitExe hash-object -- $deployedHelperPath)).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $deployedHelperBlob -ne $ExpectedHelperBlobSha1) {
            throw "Post-transition helper blob mismatch. expected=$ExpectedHelperBlobSha1 actual=$deployedHelperBlob"
        }
    } finally {
        Pop-Location
    }

    # Source moved; runtime must still be the same stopped, disarmed incident state.
    Assert-Pause -Stage 'POST_FAST_FORWARD'
    Assert-Disarmed -Stage 'POST_FAST_FORWARD'
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage 'POST_FAST_FORWARD'
    Assert-FlatBroker -Stage 'POST_FAST_FORWARD'
    [void](Assert-FailedStoppedBrokerRuntimeState -Stage 'POST_FAST_FORWARD')

    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_SOURCE_COMMIT=$TargetCommit"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_SOURCE_TREE=$targetTree"
    Write-Host "PHASE7C_FAILED_STOPPED_BROKER_HELPER_BLOB=$ExpectedHelperBlobSha1"
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_SOURCE_TRANSITION=PASS'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_FINAL_MODE=PAUSE'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_FINAL_ARM=DISARMED'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_RUNTIME_READY=FALSE'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_TASK_MUTATION=NONE'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_LIFECYCLE_MUTATION=NONE'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_ORDER_MUTATION=NONE'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_POSITION_MUTATION=NONE'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_NEXT_STEP=CANONICAL_STABLE_RECOVERY_SEPARATE_ACTION'
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_STATUS=PASS'
} catch {
    $failure = $_
    Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_STATUS=FAIL'
    if ($sourceMutationStarted) {
        Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_FAIL_CLOSED=NO_RUNTIME_MUTATION_SOURCE_STATE_REQUIRES_REATTESTATION'
    } else {
        Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_FAIL_CLOSED=NO_SOURCE_OR_RUNTIME_MUTATION'
    }
    throw $failure
}
