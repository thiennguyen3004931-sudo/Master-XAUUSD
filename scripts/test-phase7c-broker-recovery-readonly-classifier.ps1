$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ClassifierPath = Join-Path $PSScriptRoot 'classify-phase7c-broker-recovery-readonly-local.ps1'

if (-not (Test-Path -LiteralPath $ClassifierPath -PathType Leaf)) {
    throw "Phase7C broker recovery read-only classifier is missing: $ClassifierPath"
}

function Assert-True([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw $Label }
}

function Assert-False([bool]$Condition, [string]$Label) {
    if ($Condition) { throw $Label }
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ClassifierPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -ne 0) {
    $errors | ForEach-Object { Write-Error $_ }
    throw 'Broker recovery read-only classifier must parse cleanly.'
}

$source = [string]$ast.Extent.Text

# The classifier is diagnostic only. It may perform GET requests and git reads,
# but must never mutate source, Scheduled Tasks, lifecycle, mode, ARM, orders, or positions.
foreach ($forbidden in @(
    'Start-ScheduledTask',
    'Stop-ScheduledTask',
    'Register-ScheduledTask',
    'Unregister-ScheduledTask',
    'Invoke-ApiPost',
    '-Method Post',
    'ARM_LIVE',
    'DISARM_LIVE',
    '/lifecycle/start',
    '/lifecycle/stop',
    'git fetch',
    'git pull',
    'merge --ff-only',
    'checkout',
    'reset --hard'
)) {
    Assert-False ($source -match [regex]::Escape($forbidden)) "Read-only classifier contains forbidden mutation token: $forbidden"
}

foreach ($required in @(
    'READ_ONLY=TRUE',
    'HTTP_METHODS=GET_ONLY',
    'GIT_MUTATION=NONE',
    'TASK_MUTATION=NONE',
    'LIFECYCLE_MUTATION=NONE',
    'MODE_MUTATION=NONE',
    'ARM_MUTATION=NONE',
    'ORDER_MUTATION=NONE',
    'POSITION_MUTATION=NONE',
    'LIVE_TEST_ORDER=NONE',
    'LOCAL_HEAD=',
    'LOCAL_DIRTY_COUNT=',
    'REMOTE_MAIN=',
    'LOCAL_HELPER_BLOB=',
    'TASK_STATE=',
    'TASK_LAST_RESULT=',
    'BROKER_READY=',
    'BROKER_PID=',
    'ACCOUNT_MODE=',
    'BRIDGE_HEALTHY=',
    'CLASSIFICATION=',
    'BLOCKED_BY='
)) {
    Assert-True ($source -match [regex]::Escape($required)) "Missing read-only classifier output contract token: $required"
}

foreach ($required in @(
    'ExpectedRemoteMainCommit',
    'ExpectedHelperBlobSha1',
    'ExpectedClassifierBlobSha1',
    'ExternalSourceTransitionHelperPath',
    'status --porcelain',
    'ls-remote --heads origin refs/heads/main',
    'hash-object',
    '/v1/positions?symbol=XAUUSD',
    '/v1/orders?symbol=XAUUSD'
)) {
    Assert-True ($source -match [regex]::Escape($required)) "Missing classifier provenance/read-only evidence token: $required"
}

$eligibilityFunction = $ast.Find({
    param($node)
    return $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$node.Name -eq 'Test-Phase7CFailedStoppedBrokerClassification'
}, $true)
if ($null -eq $eligibilityFunction) {
    throw 'Test-Phase7CFailedStoppedBrokerClassification function is missing.'
}

Invoke-Expression ([string]$eligibilityFunction.Extent.Text)

$base = @{
    ClassifierProvenanceExact = $true
    RemoteMainExact = $true
    HelperProvenanceExact = $true
    LocalBranchMain = $true
    LocalDirtyCount = 0
    LocalHeadDiffersFromTarget = $true
    Mode = 'PAUSE'
    Arm = 'DISARMED'
    AccountMode = 'LIVE'
    AccountModeValid = $true
    BridgeHealthy = $true
    BridgeLiveReal = $true
    LifecycleRunning = $false
    LifecycleReady = $false
    BrokerReady = $false
    AliveExecutorCount = 0
    Positions = 0
    PendingOrders = 0
    TaskOwnershipCanonical = $true
    TaskState = 'Ready'
    LastTaskResult = 1L
    CanonicalTaskProcessCount = 0
    RunningTaskInstanceCount = 0
    StatusReadState = 'OK'
    HeartbeatReadState = 'OK'
    BrokerStatusPidMatch = $true
    BrokerProcessAlive = $false
    BrokerHeartbeatFresh = $false
    StartupRunnerLockState = 'RELEASED'
}

function Invoke-Classification([hashtable]$Overrides) {
    $args = @{}
    foreach ($key in $base.Keys) { $args[$key] = $base[$key] }
    foreach ($key in $Overrides.Keys) { $args[$key] = $Overrides[$key] }
    return Test-Phase7CFailedStoppedBrokerClassification @args
}

Assert-True ([bool](Invoke-Classification @{})) 'Exact FAILED_STOPPED_BROKER evidence must classify PASS.'
Assert-True ([bool](Invoke-Classification @{ StartupRunnerLockState = 'MISSING'; LastTaskResult = 267009L })) 'Missing startup lock and any nonzero LastTaskResult must remain eligible.'

$negativeCases = @(
    @{ Label = 'classifier provenance'; Override = @{ ClassifierProvenanceExact = $false } },
    @{ Label = 'remote main provenance'; Override = @{ RemoteMainExact = $false } },
    @{ Label = 'helper provenance'; Override = @{ HelperProvenanceExact = $false } },
    @{ Label = 'branch main'; Override = @{ LocalBranchMain = $false } },
    @{ Label = 'clean worktree'; Override = @{ LocalDirtyCount = 1 } },
    @{ Label = 'source transition must still be needed'; Override = @{ LocalHeadDiffersFromTarget = $false } },
    @{ Label = 'mode PAUSE'; Override = @{ Mode = 'AUTO' } },
    @{ Label = 'ARM DISARMED'; Override = @{ Arm = 'ARMED' } },
    @{ Label = 'account LIVE'; Override = @{ AccountMode = 'DEMO' } },
    @{ Label = 'account valid'; Override = @{ AccountModeValid = $false } },
    @{ Label = 'bridge healthy'; Override = @{ BridgeHealthy = $false } },
    @{ Label = 'bridge LIVE real'; Override = @{ BridgeLiveReal = $false } },
    @{ Label = 'lifecycle stopped'; Override = @{ LifecycleRunning = $true } },
    @{ Label = 'runtime not ready'; Override = @{ LifecycleReady = $true } },
    @{ Label = 'broker not ready'; Override = @{ BrokerReady = $true } },
    @{ Label = 'zero executors'; Override = @{ AliveExecutorCount = 1 } },
    @{ Label = 'zero positions'; Override = @{ Positions = 1 } },
    @{ Label = 'zero orders'; Override = @{ PendingOrders = 1 } },
    @{ Label = 'canonical task'; Override = @{ TaskOwnershipCanonical = $false } },
    @{ Label = 'task Ready'; Override = @{ TaskState = 'Running' } },
    @{ Label = 'nonzero LastTaskResult'; Override = @{ LastTaskResult = 0L } },
    @{ Label = 'zero task processes'; Override = @{ CanonicalTaskProcessCount = 1 } },
    @{ Label = 'zero task instances'; Override = @{ RunningTaskInstanceCount = 1 } },
    @{ Label = 'status readable'; Override = @{ StatusReadState = 'MISSING' } },
    @{ Label = 'heartbeat readable'; Override = @{ HeartbeatReadState = 'MISSING' } },
    @{ Label = 'PID match'; Override = @{ BrokerStatusPidMatch = $false } },
    @{ Label = 'broker dead'; Override = @{ BrokerProcessAlive = $true } },
    @{ Label = 'heartbeat stale'; Override = @{ BrokerHeartbeatFresh = $true } },
    @{ Label = 'lock released'; Override = @{ StartupRunnerLockState = 'HELD' } }
)

foreach ($case in $negativeCases) {
    Assert-False ([bool](Invoke-Classification $case.Override)) "FAILED_STOPPED_BROKER must block on $($case.Label)."
}

Write-Host 'PHASE7C_BROKER_RECOVERY_READONLY_CLASSIFIER_BOUNDARY=PASS'
Write-Host 'PHASE7C_BROKER_RECOVERY_READONLY_CLASSIFIER_PROVENANCE=PASS'
Write-Host 'PHASE7C_BROKER_RECOVERY_FAILED_STOPPED_BROKER_CONTRACT=PASS'
