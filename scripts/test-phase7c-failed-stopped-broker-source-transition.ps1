$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HelperPath = Join-Path $PSScriptRoot 'transition-phase7c-failed-stopped-broker-source-local.ps1'

if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    throw "FAILED_STOPPED_BROKER source-transition helper is missing: $HelperPath"
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -ne $Expected) {
        throw "$Label mismatch. expected=$Expected actual=$Actual"
    }
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
    $HelperPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -ne 0) {
    $errors | ForEach-Object { Write-Error $_ }
    throw 'FAILED_STOPPED_BROKER source-transition helper must parse cleanly.'
}

$helperSource = [string]$ast.Extent.Text

# Hard mutation boundary: this helper may transition source only. Runtime boot,
# ARM/AUTO, order/position mutation, and task start/stop belong to later explicit paths.
foreach ($forbidden in @(
    'Start-ScheduledTask',
    'Stop-ScheduledTask',
    'ARM_LIVE',
    'DISARM_LIVE',
    'Invoke-ApiPost',
    '-Method Post',
    '/lifecycle/start',
    '/lifecycle/stop',
    'recover-phase7c-runtime-ready-stable-deploy-local.ps1'
)) {
    Assert-False ($helperSource -match [regex]::Escape($forbidden)) "Source-transition helper must not contain forbidden runtime mutation token: $forbidden"
}
Assert-True ($helperSource -match [regex]::Escape('/v1/orders?symbol=XAUUSD')) 'Source-transition helper must verify pending XAUUSD orders read-only.'
Assert-True ($helperSource -match [regex]::Escape('/v1/positions?symbol=XAUUSD')) 'Source-transition helper must verify XAUUSD positions read-only.'
Assert-True ($helperSource -match 'HTTP_METHODS=GET_ONLY') 'Source-transition helper must attest GET-only HTTP behavior.'
Assert-True ($helperSource -match 'merge\s+--ff-only') 'Source-transition helper must use exact git merge --ff-only.'
Assert-True ($helperSource -match 'FAILED_STOPPED_BROKER') 'Helper must explicitly identify FAILED_STOPPED_BROKER state.'
Assert-True ($helperSource -match 'FINAL_MODE=PAUSE') 'Helper must attest final PAUSE mode.'
Assert-True ($helperSource -match 'FINAL_ARM=DISARMED') 'Helper must attest final DISARMED ARM state.'
Assert-True ($helperSource -match 'RUNTIME_READY=FALSE') 'Helper must attest runtime-ready remains false.'

$eligibilityFunction = $ast.Find({
    param($node)
    return $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$node.Name -eq 'Test-Phase7CFailedStoppedBrokerEligibility'
}, $true)
if ($null -eq $eligibilityFunction) {
    throw 'Test-Phase7CFailedStoppedBrokerEligibility function is missing.'
}

# Load only the pure eligibility function; never execute helper top-level code in regression tests.
Invoke-Expression ([string]$eligibilityFunction.Extent.Text)

$base = @{
    ExpectedInitialArm = 'DISARMED'
    LifecycleRunning = $false
    LifecycleReady = $false
    LifecycleHasAliveProcess = $false
    LifecycleMode = 'PAUSE'
    AccountMode = 'LIVE'
    AccountModeValid = $true
    TaskDefinitionCanonical = $true
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

function Invoke-Eligibility([hashtable]$Overrides) {
    $args = @{}
    foreach ($key in $base.Keys) { $args[$key] = $base[$key] }
    foreach ($key in $Overrides.Keys) { $args[$key] = $Overrides[$key] }
    return Test-Phase7CFailedStoppedBrokerEligibility @args
}

Assert-True ([bool](Invoke-Eligibility @{})) 'Canonical FAILED_STOPPED_BROKER evidence must be eligible.'
Assert-True ([bool](Invoke-Eligibility @{ StartupRunnerLockState = 'MISSING' })) 'Missing startup lock is an allowed released/absent state.'

$negativeCases = @(
    @{ Label = 'ARM must be DISARMED'; Override = @{ ExpectedInitialArm = 'ARMED' } },
    @{ Label = 'Lifecycle must not be running'; Override = @{ LifecycleRunning = $true } },
    @{ Label = 'Runtime must not be ready'; Override = @{ LifecycleReady = $true } },
    @{ Label = 'No executor process may be alive'; Override = @{ LifecycleHasAliveProcess = $true } },
    @{ Label = 'Mode must remain PAUSE'; Override = @{ LifecycleMode = 'AUTO' } },
    @{ Label = 'Account mode must remain LIVE'; Override = @{ AccountMode = 'DEMO' } },
    @{ Label = 'Account mode must remain valid'; Override = @{ AccountModeValid = $false } },
    @{ Label = 'Task definition must be canonical SYSTEM'; Override = @{ TaskDefinitionCanonical = $false } },
    @{ Label = 'Task state must be Ready'; Override = @{ TaskState = 'Running' } },
    @{ Label = 'LastTaskResult must be nonzero'; Override = @{ LastTaskResult = 0L } },
    @{ Label = 'Canonical task process count must be zero'; Override = @{ CanonicalTaskProcessCount = 1 } },
    @{ Label = 'Running task instance count must be zero'; Override = @{ RunningTaskInstanceCount = 1 } },
    @{ Label = 'Broker status evidence must be readable'; Override = @{ StatusReadState = 'MISSING' } },
    @{ Label = 'Broker heartbeat evidence must be readable'; Override = @{ HeartbeatReadState = 'MISSING' } },
    @{ Label = 'Broker status/heartbeat PID must match'; Override = @{ BrokerStatusPidMatch = $false } },
    @{ Label = 'Broker process must be dead'; Override = @{ BrokerProcessAlive = $true } },
    @{ Label = 'Broker heartbeat must be stale'; Override = @{ BrokerHeartbeatFresh = $true } },
    @{ Label = 'Startup lock must be released or missing'; Override = @{ StartupRunnerLockState = 'HELD' } }
)

foreach ($case in $negativeCases) {
    Assert-False ([bool](Invoke-Eligibility $case.Override)) ([string]$case.Label)
}

# Provenance contract must be explicit in the helper source.
foreach ($requiredToken in @(
    'ExpectedCurrentCommit',
    'TargetCommit',
    'ExpectedRemoteMainCommit',
    'ExpectedHelperBlobSha1',
    'status --porcelain',
    'ls-remote --heads origin refs/heads/main',
    'merge-base --is-ancestor',
    'hash-object',
    'rev-parse HEAD',
    'rev-parse "HEAD^{tree}"'
)) {
    Assert-True ($helperSource -match [regex]::Escape($requiredToken)) "Missing provenance contract token: $requiredToken"
}

Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_ELIGIBILITY_CONTRACT=PASS'
Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_SOURCE_ONLY_BOUNDARY=PASS'
Write-Host 'PHASE7C_FAILED_STOPPED_BROKER_PROVENANCE_CONTRACT=PASS'
