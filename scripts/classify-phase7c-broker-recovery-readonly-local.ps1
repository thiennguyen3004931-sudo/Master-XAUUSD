param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$ExternalSourceTransitionHelperPath,
    [Parameter(Mandatory = $true)] [string]$ExpectedRemoteMainCommit,
    [Parameter(Mandatory = $true)] [string]$ExpectedHelperBlobSha1,
    [Parameter(Mandatory = $true)] [string]$ExpectedClassifierBlobSha1
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExternalSourceTransitionHelperPath = [System.IO.Path]::GetFullPath($ExternalSourceTransitionHelperPath)
$ExpectedRemoteMainCommit = $ExpectedRemoteMainCommit.Trim().ToLowerInvariant()
$ExpectedHelperBlobSha1 = $ExpectedHelperBlobSha1.Trim().ToLowerInvariant()
$ExpectedClassifierBlobSha1 = $ExpectedClassifierBlobSha1.Trim().ToLowerInvariant()

$TaskName = 'XAUUSD-Phase7C-Executors'
$ExpectedOriginUrls = @(
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master',
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git',
    'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master.git'
)

Write-Host '============================================================'
Write-Host '=== PHASE7C BROKER RECOVERY — READ-ONLY CLASSIFIER ==='
Write-Host '============================================================'
Write-Host 'READ_ONLY=TRUE'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'GIT_MUTATION=NONE'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'LIFECYCLE_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'

function Test-Phase7CFailedStoppedBrokerClassification {
    param(
        [Parameter(Mandatory = $true)] [bool]$ClassifierProvenanceExact,
        [Parameter(Mandatory = $true)] [bool]$RemoteMainExact,
        [Parameter(Mandatory = $true)] [bool]$HelperProvenanceExact,
        [Parameter(Mandatory = $true)] [bool]$LocalBranchMain,
        [Parameter(Mandatory = $true)] [int]$LocalDirtyCount,
        [Parameter(Mandatory = $true)] [bool]$LocalHeadDiffersFromTarget,
        [Parameter(Mandatory = $true)] [string]$Mode,
        [Parameter(Mandatory = $true)] [string]$Arm,
        [Parameter(Mandatory = $true)] [string]$AccountMode,
        [Parameter(Mandatory = $true)] [bool]$AccountModeValid,
        [Parameter(Mandatory = $true)] [bool]$BridgeHealthy,
        [Parameter(Mandatory = $true)] [bool]$BridgeLiveReal,
        [Parameter(Mandatory = $true)] [bool]$LifecycleRunning,
        [Parameter(Mandatory = $true)] [bool]$LifecycleReady,
        [Parameter(Mandatory = $true)] [bool]$BrokerReady,
        [Parameter(Mandatory = $true)] [int]$AliveExecutorCount,
        [Parameter(Mandatory = $true)] [int]$Positions,
        [Parameter(Mandatory = $true)] [int]$PendingOrders,
        [Parameter(Mandatory = $true)] [bool]$TaskOwnershipCanonical,
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
        $ClassifierProvenanceExact -and
        $RemoteMainExact -and
        $HelperProvenanceExact -and
        $LocalBranchMain -and
        $LocalDirtyCount -eq 0 -and
        $LocalHeadDiffersFromTarget -and
        $Mode -eq 'PAUSE' -and
        $Arm -eq 'DISARMED' -and
        $AccountMode -eq 'LIVE' -and
        $AccountModeValid -and
        $BridgeHealthy -and
        $BridgeLiveReal -and
        -not $LifecycleRunning -and
        -not $LifecycleReady -and
        -not $BrokerReady -and
        $AliveExecutorCount -eq 0 -and
        $Positions -eq 0 -and
        $PendingOrders -eq 0 -and
        $TaskOwnershipCanonical -and
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

function Read-JsonFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "$Label is invalid: $($_.Exception.Message)"
    }
}

function Resolve-ConfigPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Test-SystemTaskPrincipal($Principal) {
    if ($null -eq $Principal) { return $false }
    $user = ([string]$Principal.UserId).Trim()
    $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
    return $systemUser -and [string]$Principal.LogonType -eq 'ServiceAccount' -and [string]$Principal.RunLevel -eq 'Highest'
}

function Get-CanonicalTaskProcessCount($Task) {
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

function Get-RunningTaskInstanceCount([string]$Name) {
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

$blocked = New-Object 'System.Collections.Generic.List[string]'
function Add-Blocked([string]$Reason) {
    if (-not [string]::IsNullOrWhiteSpace($Reason) -and -not $blocked.Contains($Reason)) {
        [void]$blocked.Add($Reason)
    }
}

$gitExe = $null
$classifierBlob = 'UNAVAILABLE'
$classifierProvenanceExact = $false
$helperBlob = 'UNAVAILABLE'
$helperProvenanceExact = $false
$localBranch = 'UNAVAILABLE'
$localHead = 'UNAVAILABLE'
$localDirtyCount = -1
$originCanonical = $false
$remoteMain = 'UNAVAILABLE'
$remoteMainExact = $false
$mode = 'UNAVAILABLE'
$arm = 'UNAVAILABLE'
$accountMode = 'UNAVAILABLE'
$accountModeValid = $false
$bridgeHealthy = $false
$bridgeLiveReal = $false
$lifecycleRunning = $true
$lifecycleReady = $true
$brokerReady = $true
$aliveExecutorCount = -1
$positions = -1
$pendingOrders = -1
$taskOwnershipCanonical = $false
$taskState = 'UNAVAILABLE'
$lastTaskResult = 0L
$canonicalTaskProcessCount = -1
$runningTaskInstanceCount = -1
$statusReadState = 'UNAVAILABLE'
$heartbeatReadState = 'UNAVAILABLE'
$brokerStatusPidMatch = $false
$brokerProcessAlive = $true
$brokerHeartbeatFresh = $true
$startupRunnerLockState = 'UNAVAILABLE'
$brokerPid = 0L

foreach ($value in @($ExpectedRemoteMainCommit, $ExpectedHelperBlobSha1, $ExpectedClassifierBlobSha1)) {
    if ($value -notmatch '^[0-9a-f]{40}$') {
        Add-Blocked 'INVALID_EXPECTED_PROVENANCE_INPUT'
    }
}

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Add-Blocked 'PROJECT_ROOT_MISSING'
}
if (-not (Test-Path -LiteralPath $ExternalSourceTransitionHelperPath -PathType Leaf)) {
    Add-Blocked 'EXTERNAL_HELPER_MISSING'
}
if ([string]::IsNullOrWhiteSpace([string]$PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
    Add-Blocked 'CLASSIFIER_EXTERNAL_FILE_REQUIRED'
}

try {
    $gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
} catch {
    Add-Blocked 'GIT_UNAVAILABLE'
}

if ($null -ne $gitExe -and -not [string]::IsNullOrWhiteSpace([string]$PSCommandPath)) {
    try {
        $classifierBlob = ([string](& $gitExe hash-object -- $PSCommandPath)).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $classifierBlob -notmatch '^[0-9a-f]{40}$') {
            $classifierBlob = 'UNAVAILABLE'
            Add-Blocked 'CLASSIFIER_HASH_FAILED'
        } else {
            $classifierProvenanceExact = $classifierBlob -eq $ExpectedClassifierBlobSha1
            if (-not $classifierProvenanceExact) { Add-Blocked 'CLASSIFIER_BLOB_MISMATCH' }
        }
    } catch {
        Add-Blocked 'CLASSIFIER_HASH_FAILED'
    }
}

if ($null -ne $gitExe -and (Test-Path -LiteralPath $ExternalSourceTransitionHelperPath -PathType Leaf)) {
    try {
        $helperBlob = ([string](& $gitExe hash-object -- $ExternalSourceTransitionHelperPath)).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $helperBlob -notmatch '^[0-9a-f]{40}$') {
            $helperBlob = 'UNAVAILABLE'
            Add-Blocked 'HELPER_HASH_FAILED'
        } else {
            $helperProvenanceExact = $helperBlob -eq $ExpectedHelperBlobSha1
            if (-not $helperProvenanceExact) { Add-Blocked 'HELPER_BLOB_MISMATCH' }
        }
    } catch {
        Add-Blocked 'HELPER_HASH_FAILED'
    }
}

# Canonical Git reads only: git status --porcelain --untracked-files=normal
# and git ls-remote --heads origin refs/heads/main. No remote-tracking ref is written.
if ($null -ne $gitExe -and (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Push-Location $ProjectRoot
    try {
        try {
            $localBranch = ([string](& $gitExe branch --show-current)).Trim()
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($localBranch)) {
                $localBranch = 'UNAVAILABLE'
                Add-Blocked 'LOCAL_BRANCH_UNAVAILABLE'
            } elseif ($localBranch -ne 'main') {
                Add-Blocked 'LOCAL_BRANCH_NOT_MAIN'
            }
        } catch { Add-Blocked 'LOCAL_BRANCH_UNAVAILABLE' }

        try {
            $localHead = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
            if ($LASTEXITCODE -ne 0 -or $localHead -notmatch '^[0-9a-f]{40}$') {
                $localHead = 'UNAVAILABLE'
                Add-Blocked 'LOCAL_HEAD_UNAVAILABLE'
            } elseif ($localHead -eq $ExpectedRemoteMainCommit) {
                Add-Blocked 'LOCAL_HEAD_ALREADY_TARGET'
            }
        } catch { Add-Blocked 'LOCAL_HEAD_UNAVAILABLE' }

        try {
            $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
            if ($LASTEXITCODE -ne 0) {
                Add-Blocked 'LOCAL_DIRTY_STATE_UNAVAILABLE'
            } else {
                $localDirtyCount = @($dirty | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
                if ($localDirtyCount -ne 0) { Add-Blocked 'LOCAL_WORKTREE_DIRTY' }
            }
        } catch { Add-Blocked 'LOCAL_DIRTY_STATE_UNAVAILABLE' }

        try {
            $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
            if ($LASTEXITCODE -eq 0 -and $ExpectedOriginUrls -contains $originUrl) {
                $originCanonical = $true
            } else {
                Add-Blocked 'ORIGIN_REMOTE_MISMATCH'
            }
        } catch { Add-Blocked 'ORIGIN_REMOTE_MISMATCH' }

        try {
            $remoteRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
            if ($LASTEXITCODE -ne 0 -or $remoteRaw.Count -ne 1) {
                Add-Blocked 'REMOTE_MAIN_UNAVAILABLE'
            } else {
                $remoteMain = ([string]$remoteRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
                $remoteMainExact = $remoteMain -eq $ExpectedRemoteMainCommit
                if (-not $remoteMainExact) { Add-Blocked 'REMOTE_MAIN_MISMATCH' }
            }
        } catch { Add-Blocked 'REMOTE_MAIN_UNAVAILABLE' }
    } finally {
        Pop-Location
    }
}

$ScriptsRoot = Join-Path $ProjectRoot 'scripts'
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ScriptsRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$RuntimeOwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$dependenciesReady = $true
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        $dependenciesReady = $false
        Add-Blocked 'CURRENT_SOURCE_DEPENDENCY_MISSING'
    }
}

if ($dependenciesReady) {
    try {
        . $AccountLibrary
        . $OwnershipLibrary
        . $RuntimeOwnershipLibrary

        $config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
        $configCanonical = $true
        if ([int]$config.version -ne 2) { $configCanonical = $false }
        if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne 'LIVE') { $configCanonical = $false }
        if (-not [bool]$config.liveExecutionEnabled) { $configCanonical = $false }
        if (-not [bool]$config.armed) { $configCanonical = $false }
        if (-not $configCanonical) { Add-Blocked 'TASK_CONFIG_NOT_CANONICAL_LIVE' }

        $WorkDir = Resolve-ConfigPath ([string]$config.workDir)
        $EnvFile = Resolve-ConfigPath ([string]$config.envFile)
        $ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
        if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
            Add-Blocked 'CONTROL_API_NOT_LOOPBACK'
        } else {
            try {
                $modeSnapshot = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
                $mode = [string]$modeSnapshot.state.mode
                if ($mode -ne 'PAUSE') { Add-Blocked 'MODE_NOT_PAUSE' }
            } catch { Add-Blocked 'MODE_READ_FAILED' }

            try {
                $armSnapshot = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
                $arm = [string]$armSnapshot.liveArmStatus
                if ([string]$armSnapshot.accountMode -ne 'LIVE' -or $arm -ne 'DISARMED' -or [bool]$armSnapshot.liveExecutionArmed) {
                    Add-Blocked 'ARM_NOT_DISARMED'
                }
            } catch { Add-Blocked 'ARM_READ_FAILED' }

            $lifecycle = $null
            try {
                $lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
                $lifecycleRunning = [bool]$lifecycle.running
                $lifecycleReady = [bool]$lifecycle.ready
                $accountMode = [string]$lifecycle.accountMode.accountMode
                $accountModeValid = [bool]$lifecycle.accountMode.valid
                $aliveExecutorCount = Get-LifecycleAliveExecutorCount -State $lifecycle
                if ($null -ne $lifecycle.broker) {
                    try { $brokerReady = [bool]$lifecycle.broker.ready } catch { $brokerReady = $true }
                }
                if ($lifecycleRunning) { Add-Blocked 'LIFECYCLE_RUNNING' }
                if ($lifecycleReady) { Add-Blocked 'RUNTIME_READY_TRUE' }
                if ($brokerReady) { Add-Blocked 'BROKER_READY_TRUE' }
                if ($aliveExecutorCount -ne 0) { Add-Blocked 'ALIVE_EXECUTORS_PRESENT_OR_UNKNOWN' }
                if ($accountMode -ne 'LIVE' -or -not $accountModeValid) { Add-Blocked 'LIFECYCLE_ACCOUNT_MODE_INVALID' }
            } catch { Add-Blocked 'LIFECYCLE_READ_FAILED' }

            try {
                $envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode 'LIVE' -RequireTrading
                $BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
                $BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }
                $bridgeHealth = Get-BridgeHealth
                $bridgeHealthy = [bool]$bridgeHealth.connected -and [string]$bridgeHealth.status -eq 'ok'
                $bridgeLiveReal = [string]$bridgeHealth.configuredAccountMode -eq 'LIVE' -and [string]$bridgeHealth.accountMode -eq 'real'
                if (-not $bridgeHealthy) { Add-Blocked 'BRIDGE_NOT_HEALTHY' }
                if (-not $bridgeLiveReal) { Add-Blocked 'BRIDGE_NOT_LIVE_REAL' }
                $positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD').Count
                $pendingOrders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD').Count
                if ($positions -ne 0) { Add-Blocked 'XAUUSD_POSITIONS_NONZERO' }
                if ($pendingOrders -ne 0) { Add-Blocked 'XAUUSD_PENDING_ORDERS_NONZERO' }
            } catch { Add-Blocked 'BRIDGE_READ_FAILED' }
        }

        try {
            Import-Module ScheduledTasks -ErrorAction Stop
            $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
            $taskState = [string]$task.State
            $lastTaskResult = [int64]$taskInfo.LastTaskResult

            $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
            $runnerSha = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
            $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $runnerSha
            $drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
            $taskOwnershipCanonical = [bool]$ownership.owned -and [bool]$ownership.canonical -and -not [bool]$ownership.repairRequired -and $drift.Count -eq 0 -and (Test-SystemTaskPrincipal $task.Principal)
            if (-not $taskOwnershipCanonical) { Add-Blocked 'TASK_OWNERSHIP_NOT_CANONICAL_SYSTEM' }
            if ($taskState -ne 'Ready') { Add-Blocked 'TASK_STATE_NOT_READY' }
            if ($lastTaskResult -eq 0) { Add-Blocked 'TASK_LAST_RESULT_ZERO' }

            $canonicalTaskProcessCount = Get-CanonicalTaskProcessCount -Task $task
            $runningTaskInstanceCount = Get-RunningTaskInstanceCount -Name $TaskName
            if ($canonicalTaskProcessCount -ne 0) { Add-Blocked 'CANONICAL_TASK_PROCESS_COUNT_NOT_ZERO' }
            if ($runningTaskInstanceCount -ne 0) { Add-Blocked 'RUNNING_TASK_INSTANCE_COUNT_NOT_ZERO' }

            $generation = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
            $statusReadState = [string]$generation.statusReadState
            $heartbeatReadState = [string]$generation.heartbeatReadState
            $brokerStatusPidMatch = [bool]$generation.brokerStatusPidMatch
            $brokerProcessAlive = [bool]$generation.brokerProcessAlive
            $brokerHeartbeatFresh = [bool]$generation.brokerHeartbeatFresh
            $startupRunnerLockState = [string]$generation.startupRunnerLockState
            $brokerPid = [int64]$generation.heartbeatBrokerPid

            if ($statusReadState -ne 'OK') { Add-Blocked 'BROKER_STATUS_NOT_READABLE' }
            if ($heartbeatReadState -ne 'OK') { Add-Blocked 'BROKER_HEARTBEAT_NOT_READABLE' }
            if (-not $brokerStatusPidMatch) { Add-Blocked 'BROKER_PID_EVIDENCE_MISMATCH' }
            if ($brokerProcessAlive) { Add-Blocked 'BROKER_PROCESS_ALIVE' }
            if ($brokerHeartbeatFresh) { Add-Blocked 'BROKER_HEARTBEAT_FRESH' }
            if ($startupRunnerLockState -notin @('MISSING','RELEASED')) { Add-Blocked 'STARTUP_LOCK_NOT_RELEASED' }
        } catch {
            Add-Blocked 'TASK_OR_BROKER_PROBE_FAILED'
        }
    } catch {
        Add-Blocked 'CURRENT_SOURCE_READONLY_PROBE_FAILED'
    }
}

$eligible = Test-Phase7CFailedStoppedBrokerClassification `
    -ClassifierProvenanceExact $classifierProvenanceExact `
    -RemoteMainExact $remoteMainExact `
    -HelperProvenanceExact $helperProvenanceExact `
    -LocalBranchMain ($localBranch -eq 'main') `
    -LocalDirtyCount $localDirtyCount `
    -LocalHeadDiffersFromTarget ($localHead -match '^[0-9a-f]{40}$' -and $localHead -ne $ExpectedRemoteMainCommit) `
    -Mode $mode `
    -Arm $arm `
    -AccountMode $accountMode `
    -AccountModeValid $accountModeValid `
    -BridgeHealthy $bridgeHealthy `
    -BridgeLiveReal $bridgeLiveReal `
    -LifecycleRunning $lifecycleRunning `
    -LifecycleReady $lifecycleReady `
    -BrokerReady $brokerReady `
    -AliveExecutorCount $aliveExecutorCount `
    -Positions $positions `
    -PendingOrders $pendingOrders `
    -TaskOwnershipCanonical $taskOwnershipCanonical `
    -TaskState $taskState `
    -LastTaskResult $lastTaskResult `
    -CanonicalTaskProcessCount $canonicalTaskProcessCount `
    -RunningTaskInstanceCount $runningTaskInstanceCount `
    -StatusReadState $statusReadState `
    -HeartbeatReadState $heartbeatReadState `
    -BrokerStatusPidMatch $brokerStatusPidMatch `
    -BrokerProcessAlive $brokerProcessAlive `
    -BrokerHeartbeatFresh $brokerHeartbeatFresh `
    -StartupRunnerLockState $startupRunnerLockState

if (-not $originCanonical) { Add-Blocked 'ORIGIN_NOT_CANONICAL' }
if (-not $eligible -and $blocked.Count -eq 0) { Add-Blocked 'FAILED_STOPPED_BROKER_CONTRACT_MISMATCH' }
$classification = if ($eligible -and $blocked.Count -eq 0) { 'FAILED_STOPPED_BROKER' } else { 'BLOCKED' }
$blockedBy = if ($blocked.Count -eq 0) { 'NONE' } else { (@($blocked) -join '|') }

Write-Host "CLASSIFIER_BLOB=$classifierBlob"
Write-Host "CLASSIFIER_PROVENANCE_EXACT=$classifierProvenanceExact"
Write-Host "LOCAL_BRANCH=$localBranch"
Write-Host "LOCAL_HEAD=$localHead"
Write-Host "LOCAL_DIRTY_COUNT=$localDirtyCount"
Write-Host "REMOTE_MAIN=$remoteMain"
Write-Host "REMOTE_MAIN_EXACT=$remoteMainExact"
Write-Host "LOCAL_HELPER_BLOB=$helperBlob"
Write-Host "HELPER_PROVENANCE_EXACT=$helperProvenanceExact"
Write-Host "MODE=$mode"
Write-Host "ARM=$arm"
Write-Host "ACCOUNT_MODE=$accountMode"
Write-Host "ACCOUNT_MODE_VALID=$accountModeValid"
Write-Host "BRIDGE_HEALTHY=$bridgeHealthy"
Write-Host "BRIDGE_LIVE_REAL=$bridgeLiveReal"
Write-Host "LIFECYCLE_RUNNING=$lifecycleRunning"
Write-Host "LIFECYCLE_READY=$lifecycleReady"
Write-Host "ALIVE_EXECUTOR_COUNT=$aliveExecutorCount"
Write-Host "POSITIONS=$positions"
Write-Host "PENDING_ORDERS=$pendingOrders"
Write-Host "TASK_OWNERSHIP=$(if ($taskOwnershipCanonical) { 'CANONICAL_SYSTEM' } else { 'NOT_CANONICAL' })"
Write-Host "TASK_STATE=$taskState"
Write-Host "TASK_LAST_RESULT=$lastTaskResult"
Write-Host "CANONICAL_TASK_PROCESS_COUNT=$canonicalTaskProcessCount"
Write-Host "RUNNING_TASK_INSTANCE_COUNT=$runningTaskInstanceCount"
Write-Host "BROKER_READY=$brokerReady"
Write-Host "BROKER_PID=$brokerPid"
Write-Host "BROKER_STATUS_READ_STATE=$statusReadState"
Write-Host "BROKER_HEARTBEAT_READ_STATE=$heartbeatReadState"
Write-Host "BROKER_STATUS_PID_MATCH=$brokerStatusPidMatch"
Write-Host "BROKER_PROCESS_ALIVE=$brokerProcessAlive"
Write-Host "BROKER_HEARTBEAT_FRESH=$brokerHeartbeatFresh"
Write-Host "STARTUP_LOCK_STATE=$startupRunnerLockState"
Write-Host "CLASSIFICATION=$classification"
Write-Host "BLOCKED_BY=$blockedBy"

if ($classification -eq 'FAILED_STOPPED_BROKER') {
    Write-Host 'PHASE7C_BROKER_RECOVERY_READONLY_CLASSIFIER=PASS'
    exit 0
}

Write-Host 'PHASE7C_BROKER_RECOVERY_READONLY_CLASSIFIER=BLOCKED'
exit 2
