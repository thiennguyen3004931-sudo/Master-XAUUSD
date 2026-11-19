param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$ExpectedMainCommit,
    [ValidateRange(3, 30)] [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedMainCommit = $ExpectedMainCommit.Trim().ToLowerInvariant()
$TaskName = 'XAUUSD-Phase7C-Executors'
$ExpectedOriginUrls = @(
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core',
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core.git',
    'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master-core.git'
)
$RequiredComponents = @('api','web','supervisor','trend','sideway','telegram','regime-notifier','lifecycle-broker')

Write-Host '============================================================'
Write-Host '=== PHASE7C PRODUCTION — STRICT READ-ONLY PREFLIGHT V2 ==='
Write-Host '============================================================'
Write-Host 'READ_ONLY=TRUE'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'GIT_MUTATION=NONE'
Write-Host 'DEPLOYMENT_MANIFEST_MUTATION=NONE'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'PROCESS_MUTATION=NONE'
Write-Host 'LIFECYCLE_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'BRIDGE_RESTART=NONE'
Write-Host 'EXECUTOR_RESTART=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'
Write-Host 'SECRET_VALUES_PRINTED=FALSE'

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "ProjectRoot does not exist: $ProjectRoot"
}
if ($ExpectedMainCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'ExpectedMainCommit must be an exact 40-character Git SHA.'
}

$blocked = New-Object 'System.Collections.Generic.List[string]'
function Add-Blocked([string]$Reason) {
    if (-not [string]::IsNullOrWhiteSpace($Reason) -and -not $blocked.Contains($Reason)) {
        [void]$blocked.Add($Reason)
    }
}
function Resolve-ConfigPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}
function Read-JsonFile([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
    try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "$Label is invalid: $($_.Exception.Message)" }
}
# Read-only SHA-256, compatible with Windows PowerShell 5.1 and PowerShell 7.
# Avoid reliance on Get-FileHash availability on the production runner.
function Get-Phase7CReadOnlyRunnerSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Canonical runner file is unavailable for SHA-256 attestation.'
    }
    $stream = $null
    $hasher = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        $digest = $hasher.ComputeHash($stream)
        $sha256 = [System.BitConverter]::ToString($digest).Replace('-', '').ToUpperInvariant()
        if ($sha256 -notmatch '^[0-9A-F]{64}$') {
            throw 'Canonical runner SHA-256 format is invalid.'
        }
        return $sha256
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $hasher) { $hasher.Dispose() }
    }
}

function Test-SystemTaskPrincipal($Principal) {
    if ($null -eq $Principal) { return $false }
    $user = ([string]$Principal.UserId).Trim()
    $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
    return $systemUser -and [string]$Principal.LogonType -eq 'ServiceAccount' -and [string]$Principal.RunLevel -eq 'Highest'
}
function Invoke-ApiGet([string]$Path) {
    return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
}
function Invoke-ApiGetOptional([string]$Path) {
    try {
        return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
    } catch {
        $response = $_.Exception.Response
        if ($null -ne $response) {
            try {
                if ([int]$response.StatusCode -eq 404) { return $null }
            } catch {}
        }
        throw
    }
}
function Get-BridgeHealth {
    return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec $TimeoutSeconds
}
function Read-BridgeArray([string]$Path) {
    $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec $TimeoutSeconds
    $raw = ([string]$response.Content).Trim()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
    return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}
function Format-Nullable($Value) {
    if ($null -eq $Value) { return 'UNAVAILABLE' }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return 'UNAVAILABLE' }
    return $text
}

$localBranch = 'UNAVAILABLE'
$localHead = 'UNAVAILABLE'
$localTree = 'UNAVAILABLE'
$localDirtyCount = -1
$remoteMain = 'UNAVAILABLE'
$originCanonical = $false
$sourceGate = $false

$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
Push-Location $ProjectRoot
try {
    try {
        $localBranch = ([string](& $gitExe branch --show-current)).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($localBranch)) { throw 'branch read failed' }
    } catch { Add-Blocked 'LOCAL_BRANCH_UNAVAILABLE' }

    try {
        $localHead = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $localHead -notmatch '^[0-9a-f]{40}$') { throw 'HEAD read failed' }
    } catch { $localHead = 'UNAVAILABLE'; Add-Blocked 'LOCAL_HEAD_UNAVAILABLE' }

    try {
        $localTree = ([string](& $gitExe rev-parse 'HEAD^{tree}')).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $localTree -notmatch '^[0-9a-f]{40}$') { throw 'tree read failed' }
    } catch { $localTree = 'UNAVAILABLE'; Add-Blocked 'LOCAL_TREE_UNAVAILABLE' }

    try {
        $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
        if ($LASTEXITCODE -ne 0) { throw 'status read failed' }
        $localDirtyCount = @($dirty | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
    } catch { $localDirtyCount = -1; Add-Blocked 'LOCAL_DIRTY_STATE_UNAVAILABLE' }

    try {
        $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
        $originCanonical = $LASTEXITCODE -eq 0 -and $ExpectedOriginUrls -contains $originUrl
    } catch { $originCanonical = $false }

    try {
        $remoteRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
        if ($LASTEXITCODE -ne 0 -or $remoteRaw.Count -ne 1) { throw 'remote main read failed' }
        $remoteMain = ([string]$remoteRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
        if ($remoteMain -notmatch '^[0-9a-f]{40}$') { throw 'remote main invalid' }
    } catch { $remoteMain = 'UNAVAILABLE'; Add-Blocked 'REMOTE_MAIN_UNAVAILABLE' }
} finally {
    Pop-Location
}

if ($localBranch -ne 'main') { Add-Blocked 'LOCAL_BRANCH_NOT_MAIN' }
if ($localHead -ne $ExpectedMainCommit) { Add-Blocked 'LOCAL_HEAD_NOT_EXPECTED_MAIN' }
if ($remoteMain -ne $ExpectedMainCommit) { Add-Blocked 'REMOTE_MAIN_NOT_EXPECTED' }
if ($localDirtyCount -ne 0) { Add-Blocked 'LOCAL_WORKTREE_NOT_CLEAN' }
if (-not $originCanonical) { Add-Blocked 'ORIGIN_REMOTE_NOT_CANONICAL' }
$sourceGate = $localBranch -eq 'main' -and $localHead -eq $ExpectedMainCommit -and $remoteMain -eq $ExpectedMainCommit -and $localDirtyCount -eq 0 -and $originCanonical -and $localTree -match '^[0-9a-f]{40}$'

$ScriptsRoot = Join-Path $ProjectRoot 'scripts'
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ScriptsRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-scheduled-task-ownership.ps1'
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required read-only dependency is missing: $required" }
}
. $AccountLibrary
. $OwnershipLibrary

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    throw "Control API must be loopback-only. value=$ControlApiUrl"
}
$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$configAccountMode = ([string]$config.accountMode).Trim().ToUpperInvariant()

# Mirror the API runtimeRoot() precedence exactly: PHASE7C_RUNTIME_ROOT,
# then parent(PHASE7B_DEMO_WORK_DIR), then <project>/.runtime. The API runs
# from the canonical project root under the Phase7C task topology.
$runtimeRootOverride = ([string](Get-Phase7CEnvValue $EnvFile 'PHASE7C_RUNTIME_ROOT')).Trim()
$demoWorkDirOverride = ([string](Get-Phase7CEnvValue $EnvFile 'PHASE7B_DEMO_WORK_DIR')).Trim()
if (-not [string]::IsNullOrWhiteSpace($runtimeRootOverride)) {
    $RuntimeRoot = Resolve-ConfigPath $runtimeRootOverride
} elseif (-not [string]::IsNullOrWhiteSpace($demoWorkDirOverride)) {
    $RuntimeRoot = Split-Path -Parent (Resolve-ConfigPath $demoWorkDirOverride)
} else {
    $RuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '.runtime'))
}

# This probe must still run while PAUSE/DISARMED even if trading is disabled;
# RequireTrading is intentionally not used. Account/env shape remains validated.
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $configAccountMode
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$canonicalLoginRaw = ([string](Get-Phase7CEnvValue $EnvFile 'MT5_LOGIN')).Trim()
$canonicalLogin = 0L
$canonicalLoginValid = [long]::TryParse($canonicalLoginRaw, [ref]$canonicalLogin) -and $canonicalLogin -gt 0
$canonicalServer = ([string](Get-Phase7CEnvValue $EnvFile 'MT5_SERVER')).Trim()
$canonicalServerValid = -not [string]::IsNullOrWhiteSpace($canonicalServer)
if (-not $canonicalLoginValid -or -not $canonicalServerValid) {
    Add-Blocked 'CANONICAL_ACCOUNT_IDENTITY_INVALID'
}

$modeSnapshot = Invoke-ApiGet '/api/v1/phase7c/bot-mode'
$lifecycle = Invoke-ApiGet '/api/v1/phase7c/lifecycle'
$armSnapshot = Invoke-ApiGet '/api/v1/phase7c-live-arm-control/capability'
$sameMode = Invoke-ApiGet '/api/v1/phase7c-account-switch/same-mode-readiness'
$accountSwitchStatus = Invoke-ApiGetOptional '/api/v1/phase7c-account-switch/status'
$liveArmStatus = Invoke-ApiGetOptional '/api/v1/phase7c-live-arm-control/status'
$runtimeSource = Invoke-ApiGet '/api/v1/phase7c/runtime-source-attestation'
$bridgeHealth = Get-BridgeHealth
$positions = @(Read-BridgeArray '/v1/positions?symbol=XAUUSD')
$pendingOrders = @(Read-BridgeArray '/v1/orders?symbol=XAUUSD')

$botMode = [string]$modeSnapshot.state.mode
$arm = [string]$armSnapshot.liveArmStatus
$lifecycleRunning = [bool]$lifecycle.running
$lifecycleReady = [bool]$lifecycle.ready
$accountMode = ([string]$lifecycle.accountMode.accountMode).Trim().ToUpperInvariant()
$accountModeValid = [bool]$lifecycle.accountMode.valid
$accountStateSource = ([string]$lifecycle.accountMode.source).Trim().ToUpperInvariant()
$selectedEnvFileRaw = ([string]$lifecycle.accountMode.envFile).Trim()
$accountEnvFileBindingValid = $false
if ($accountStateSource -eq 'LEGACY_DEMO_DEFAULT' -and $accountMode -eq 'DEMO' -and [string]::IsNullOrWhiteSpace($selectedEnvFileRaw)) {
    $accountEnvFileBindingValid = $true
} elseif (-not [string]::IsNullOrWhiteSpace($selectedEnvFileRaw)) {
    try {
        $selectedEnvFile = [System.IO.Path]::GetFullPath($selectedEnvFileRaw)
        $accountEnvFileBindingValid = [string]::Equals($selectedEnvFile, $EnvFile, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        $accountEnvFileBindingValid = $false
    }
}
$accountLogin = Format-Nullable $sameMode.accountLogin
$accountServer = Format-Nullable $sameMode.server
$brokerLogin = 0L
$brokerLoginValid = [long]::TryParse(([string]$sameMode.accountLogin).Trim(), [ref]$brokerLogin) -and $brokerLogin -gt 0
$brokerServer = ([string]$sameMode.server).Trim()
$bridgeHealthy = [bool]$bridgeHealth.connected -and [string]$bridgeHealth.status -eq 'ok'
$expectedBrokerMode = if ($accountMode -eq 'LIVE') { 'real' } elseif ($accountMode -eq 'DEMO') { 'demo' } else { 'invalid' }
$bridgeAccountModeMatch = $bridgeHealthy -and [string]$bridgeHealth.accountMode -eq $expectedBrokerMode -and [bool]$sameMode.checks.bridgeMatchesSelectedAccount
$bridgeAccountIdentityMatch = $bridgeAccountModeMatch -and $canonicalLoginValid -and $canonicalServerValid -and $brokerLoginValid -and `
    $brokerLogin -eq $canonicalLogin -and [string]::Equals($brokerServer, $canonicalServer, [System.StringComparison]::OrdinalIgnoreCase)

$liveAuthorizationValid = $true
$liveAuthorizationOutput = 'NOT_APPLICABLE'
if ($accountMode -eq 'LIVE') {
    $liveAuthorizationValid = [bool]$armSnapshot.armChecks.liveAuthorizationValid
    $liveAuthorizationOutput = if ($liveAuthorizationValid) { 'True' } else { 'False' }
}

$accountSwitchRequestPresent = Test-Path -LiteralPath (Join-Path $RuntimeRoot 'phase7c-account-switch-request.json') -PathType Leaf
$liveArmRequestPresent = Test-Path -LiteralPath (Join-Path $RuntimeRoot 'phase7c-live-arm-control-request.json') -PathType Leaf
$accountSwitchRunning = $null -ne $accountSwitchStatus -and [string]$accountSwitchStatus.status -eq 'RUNNING'
$liveArmRunning = $null -ne $liveArmStatus -and [string]$liveArmStatus.status -eq 'RUNNING'
$accountSwitchUnresolved = $accountSwitchRequestPresent -or $accountSwitchRunning -or -not [bool]$sameMode.checks.noSwitchRunning
$liveArmUnresolved = $liveArmRequestPresent -or $liveArmRunning -or [bool]$armSnapshot.orphanedControlRequest
$unresolvedMutatingRequests = [int]([bool]$accountSwitchUnresolved) + [int]([bool]$liveArmUnresolved)

if ($botMode -ne [string]$lifecycle.mode.mode) { Add-Blocked 'MODE_SNAPSHOT_DIVERGENCE' }
if ($arm -notin @('ARMED','DISARMED')) { Add-Blocked 'ARM_STATE_INVALID' }
if (-not $accountModeValid -or $accountMode -notin @('DEMO','LIVE')) { Add-Blocked 'ACCOUNT_MODE_INVALID' }
if ($accountMode -ne $configAccountMode) { Add-Blocked 'ACCOUNT_MODE_CONFIG_DIVERGENCE' }
if (-not $accountEnvFileBindingValid) { Add-Blocked 'ACCOUNT_ENV_FILE_BINDING_MISMATCH' }
if (-not $bridgeHealthy) { Add-Blocked 'BRIDGE_NOT_HEALTHY' }
if (-not $bridgeAccountIdentityMatch) { Add-Blocked 'BRIDGE_ACCOUNT_IDENTITY_MISMATCH' }
if ($positions.Count -ne [int]$armSnapshot.openXauusdPositions -or $positions.Count -ne [int]$sameMode.openXauusdPositions) {
    Add-Blocked 'POSITION_COUNT_DIVERGENCE'
}

$taskOwnershipCanonical = $false
$taskDrift = @('UNAVAILABLE')
$taskState = 'UNAVAILABLE'
$taskLastResult = 'UNAVAILABLE'
$taskReadStatus = 'UNAVAILABLE'
$taskOwnershipEvaluation = 'NOT_RUN'
$taskRunnerHashStatus = 'NOT_RUN'
$taskRunnerPathStatus = 'NOT_RUN'
$taskRunnerShaStatus = 'NOT_RUN'
$taskRunnerMissingCommand = 'NONE'
$taskActionOwnershipStatus = 'NOT_RUN'
$taskDriftEvaluationStatus = 'NOT_RUN'
$taskPrincipalEvaluationStatus = 'NOT_RUN'
$taskOwnershipErrorStage = 'NONE'
$taskOwnershipErrorType = 'NONE'
$task = $null
$ownership = $null
$principalCanonical = $false
$runnerPath = ''
$runnerSha = ''

function Set-TaskOwnershipError([string]$Stage, [System.Exception]$Exception) {
    if ($taskOwnershipErrorStage -eq 'NONE') {
        $script:taskOwnershipErrorStage = $Stage
        $script:taskOwnershipErrorType = if ($null -eq $Exception) { 'UNKNOWN' } else { $Exception.GetType().Name }
    }
}

try {
    Import-Module ScheduledTasks -ErrorAction Stop
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $taskState = [string]$task.State
    $taskReadStatus = 'READABLE'
} catch {
    $taskReadStatus = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
    $taskDrift = @('TASK_PROVIDER_READ_FAILED')
    Set-TaskOwnershipError -Stage 'TASK_PROVIDER_READ' -Exception $_.Exception
}

# LastTaskResult is operational telemetry only. Some ScheduledTasks providers/runners
# omit this property under StrictMode. Missing telemetry must never downgrade an
# otherwise provably canonical task to a generic task-read failure.
if ($taskReadStatus -eq 'READABLE') {
    try {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
        if ($null -ne $taskInfo -and $null -ne $taskInfo.PSObject.Properties['LastTaskResult']) {
            $taskLastResult = [string]$taskInfo.LastTaskResult
        }
    } catch {
        $taskLastResult = 'UNAVAILABLE'
    }

    # Keep PATH and SHA validation independent so a missing PowerShell command
    # cannot be mistaken for ScheduledTask ownership drift. Never fall back to
    # a caller-supplied hash or mark a skipped check as a passing proof.
    try {
        $runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
        $taskRunnerPathStatus = 'PASS'
    } catch {
        $taskRunnerPathStatus = 'ERROR'
        $taskRunnerHashStatus = 'ERROR'
        if ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) {
            $missing = ([string]$_.Exception.CommandName).Trim()
            $taskRunnerMissingCommand = if ($missing -in @('Get-Phase7CExecutorTaskRunnerPath','Join-Path')) { $missing } else { 'OTHER_OR_UNKNOWN' }
        }
        Set-TaskOwnershipError -Stage 'RUNNER_PATH' -Exception $_.Exception
        Add-Blocked 'TASK_RUNNER_PATH_EVALUATION_FAILED'
    }

    if ($taskRunnerPathStatus -eq 'PASS') {
        try {
            $runnerSha = Get-Phase7CReadOnlyRunnerSha256 -Path $runnerPath
            $taskRunnerShaStatus = 'PASS'
            $taskRunnerHashStatus = 'PASS'
        } catch {
            $taskRunnerShaStatus = 'ERROR'
            $taskRunnerHashStatus = 'ERROR'
            if ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) {
                $missing = ([string]$_.Exception.CommandName).Trim()
                $taskRunnerMissingCommand = if ($missing -in @('Get-FileHash')) { $missing } else { 'OTHER_OR_UNKNOWN' }
            }
            Set-TaskOwnershipError -Stage 'RUNNER_HASH' -Exception $_.Exception
            Add-Blocked 'TASK_RUNNER_HASH_EVALUATION_FAILED'
        }
    }

    if ($taskRunnerHashStatus -eq 'PASS') {
        try {
            $ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $runnerSha
            $taskActionOwnershipStatus = 'PASS'
        } catch {
            $taskActionOwnershipStatus = 'ERROR'
            Set-TaskOwnershipError -Stage 'ACTION_OWNERSHIP' -Exception $_.Exception
            Add-Blocked 'TASK_ACTION_OWNERSHIP_EVALUATION_FAILED'
        }
    }

    try {
        $taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
        $taskDriftEvaluationStatus = 'PASS'
    } catch {
        $taskDrift = @('TASK_DRIFT_EVALUATION_FAILED')
        $taskDriftEvaluationStatus = 'ERROR'
        Set-TaskOwnershipError -Stage 'TASK_DRIFT' -Exception $_.Exception
        Add-Blocked 'TASK_DRIFT_EVALUATION_FAILED'
    }

    try {
        $principalCanonical = Test-SystemTaskPrincipal $task.Principal
        $taskPrincipalEvaluationStatus = if ($principalCanonical) { 'PASS' } else { 'NOT_CANONICAL' }
    } catch {
        $principalCanonical = $false
        $taskPrincipalEvaluationStatus = 'ERROR'
        Set-TaskOwnershipError -Stage 'TASK_PRINCIPAL' -Exception $_.Exception
        Add-Blocked 'TASK_PRINCIPAL_EVALUATION_FAILED'
    }

    $taskEvaluationComplete =
        $taskRunnerHashStatus -eq 'PASS' -and
        $taskActionOwnershipStatus -eq 'PASS' -and
        $taskDriftEvaluationStatus -eq 'PASS' -and
        $taskPrincipalEvaluationStatus -in @('PASS','NOT_CANONICAL')

    if ($taskEvaluationComplete) {
        $taskOwnershipCanonical =
            $null -ne $ownership -and
            [bool]$ownership.owned -and
            [bool]$ownership.canonical -and
            -not [bool]$ownership.repairRequired -and
            $taskDrift.Count -eq 0 -and
            $principalCanonical
        $taskOwnershipEvaluation = if ($taskOwnershipCanonical) { 'PASS' } else { 'NOT_CANONICAL' }
    } else {
        $taskOwnershipCanonical = $false
        $taskOwnershipEvaluation = 'ERROR'
    }
}
if (-not $taskOwnershipCanonical) { Add-Blocked 'TASK_OWNERSHIP_NOT_CANONICAL_SYSTEM' }

$deploymentSourceCommit = 'UNAVAILABLE'
$deploymentSourceTree = 'UNAVAILABLE'
$deploymentId = 'UNAVAILABLE'
$deploymentReadable = $false
$runtimeSourceOverall = [string]$runtimeSource.overall
$runtimeComponents = @($runtimeSource.components)
if ($null -ne $runtimeSource.deployment) {
    $deploymentSourceCommit = ([string]$runtimeSource.deployment.sourceCommit).Trim().ToLowerInvariant()
    $deploymentSourceTree = ([string]$runtimeSource.deployment.sourceTree).Trim().ToLowerInvariant()
    $deploymentId = [string]$runtimeSource.deployment.deploymentId
    $deploymentReadable = $deploymentSourceCommit -match '^[0-9a-f]{40}$' -and $deploymentSourceTree -match '^[0-9a-f]{40}$' -and -not [string]::IsNullOrWhiteSpace($deploymentId)
}
if (-not $deploymentReadable) { Add-Blocked 'DEPLOYMENT_ATTESTATION_UNAVAILABLE' }

$componentEvidenceUsable = $true
$nonExactComponents = New-Object 'System.Collections.Generic.List[string]'
foreach ($componentName in $RequiredComponents) {
    $matches = @($runtimeComponents | Where-Object { [string]$_.component -eq $componentName })
    if ($matches.Count -ne 1) {
        $componentEvidenceUsable = $false
        Add-Blocked ("RUNTIME_COMPONENT_EVIDENCE_{0}" -f $componentName.ToUpperInvariant().Replace('-', '_'))
        Write-Host ("RUNTIME_SOURCE_{0}=MISSING" -f $componentName.ToUpperInvariant().Replace('-', '_'))
        continue
    }
    $item = $matches[0]
    $verdict = [string]$item.verdict
    if ($verdict -notin @('EXACT_MATCH','MISMATCH','STALE')) {
        $componentEvidenceUsable = $false
        Add-Blocked ("RUNTIME_COMPONENT_AMBIGUOUS_{0}" -f $componentName.ToUpperInvariant().Replace('-', '_'))
    }
    if ($verdict -in @('MISMATCH','STALE')) { [void]$nonExactComponents.Add($componentName) }
    $label = $componentName.ToUpperInvariant().Replace('-', '_')
    Write-Host ("RUNTIME_SOURCE_{0}={1}|PID={2}|ALIVE={3}|SOURCE_COMMIT={4}|DEPLOYMENT_ID={5}" -f `
        $label, $verdict, (Format-Nullable $item.pid), (Format-Nullable $item.alive), (Format-Nullable $item.sourceCommit), (Format-Nullable $item.deploymentId))
}
if ($runtimeComponents.Count -ne $RequiredComponents.Count) {
    $componentEvidenceUsable = $false
    Add-Blocked 'RUNTIME_COMPONENT_COUNT_MISMATCH'
}
if ($runtimeSourceOverall -eq 'UNKNOWN') {
    $componentEvidenceUsable = $false
    Add-Blocked 'RUNTIME_SOURCE_OVERALL_UNKNOWN'
}

$deploymentAtTarget = $deploymentReadable -and $deploymentSourceCommit -eq $ExpectedMainCommit -and $deploymentSourceTree -eq $localTree
$recoveryRequired = $deploymentReadable -and $componentEvidenceUsable -and ((-not $deploymentAtTarget) -or $nonExactComponents.Count -gt 0)

$mutationGateReasons = New-Object 'System.Collections.Generic.List[string]'
function Add-MutationGateReason([string]$Reason) {
    if (-not $mutationGateReasons.Contains($Reason)) { [void]$mutationGateReasons.Add($Reason) }
}
if (-not $sourceGate) { Add-MutationGateReason 'SOURCE_GATE_FAIL' }
if ($botMode -ne 'PAUSE') { Add-MutationGateReason 'MODE_NOT_PAUSE' }
if ($arm -ne 'DISARMED' -or [bool]$armSnapshot.liveExecutionArmed) { Add-MutationGateReason 'ARM_NOT_DISARMED' }
if ($positions.Count -ne 0) { Add-MutationGateReason 'XAUUSD_POSITIONS_NONZERO' }
if ($pendingOrders.Count -ne 0) { Add-MutationGateReason 'XAUUSD_PENDING_ORDERS_NONZERO' }
if ($unresolvedMutatingRequests -ne 0) { Add-MutationGateReason 'UNRESOLVED_MUTATING_REQUESTS' }
if (-not $accountModeValid -or $accountMode -ne $configAccountMode) { Add-MutationGateReason 'ACCOUNT_MODE_INVALID_OR_DIVERGED' }
if (-not $accountEnvFileBindingValid) { Add-MutationGateReason 'ACCOUNT_ENV_FILE_BINDING_MISMATCH' }
if (-not $bridgeHealthy) { Add-MutationGateReason 'BRIDGE_NOT_HEALTHY' }
if (-not $bridgeAccountIdentityMatch) { Add-MutationGateReason 'ACCOUNT_IDENTITY_MISMATCH' }
if (-not $liveAuthorizationValid) { Add-MutationGateReason 'LIVE_AUTHORIZATION_INVALID' }
if (-not $taskOwnershipCanonical) { Add-MutationGateReason 'TASK_OWNERSHIP_OR_DRIFT' }
if (-not $deploymentReadable -or -not $componentEvidenceUsable) { Add-MutationGateReason 'RUNTIME_SOURCE_EVIDENCE_AMBIGUOUS' }

$recoveryMutationAllowed = $recoveryRequired -and $mutationGateReasons.Count -eq 0 -and $blocked.Count -eq 0
$classification = if (-not $sourceGate -or -not $deploymentReadable -or -not $componentEvidenceUsable -or $blocked.Count -gt 0) {
    'BLOCKED'
} elseif (-not $recoveryRequired) {
    'NO_RECOVERY_REQUIRED'
} elseif ($recoveryMutationAllowed) {
    'RECOVERY_ALLOWED'
} else {
    'RECOVERY_BLOCKED'
}

if ($classification -eq 'RECOVERY_BLOCKED') {
    foreach ($reason in @($mutationGateReasons)) { Add-Blocked $reason }
}
$blockedBy = if ($blocked.Count -eq 0) { 'NONE' } else { @($blocked) -join '|' }
$taskDriftOutput = if ($taskDrift.Count -eq 0) { 'NONE' } else { @($taskDrift) -join '|' }
$nonExactOutput = if ($nonExactComponents.Count -eq 0) { 'NONE' } else { @($nonExactComponents) -join '|' }
$canonicalLoginOutput = if ($canonicalLoginValid) { [string]$canonicalLogin } else { 'UNAVAILABLE' }
$canonicalServerOutput = if ($canonicalServerValid) { $canonicalServer } else { 'UNAVAILABLE' }

Write-Host "EXPECTED_MAIN=$ExpectedMainCommit"
Write-Host "LOCAL_BRANCH=$localBranch"
Write-Host "LOCAL_HEAD=$localHead"
Write-Host "LOCAL_TREE=$localTree"
Write-Host "LOCAL_DIRTY_COUNT=$localDirtyCount"
Write-Host "REMOTE_MAIN=$remoteMain"
Write-Host "SOURCE_GATE=$sourceGate"
Write-Host "DEPLOYMENT_SOURCE_COMMIT=$deploymentSourceCommit"
Write-Host "DEPLOYMENT_SOURCE_TREE=$deploymentSourceTree"
Write-Host "DEPLOYMENT_ID=$deploymentId"
Write-Host "BOT_MODE=$botMode"
Write-Host "ARM=$arm"
Write-Host "LIFECYCLE_RUNNING=$lifecycleRunning"
Write-Host "LIFECYCLE_READY=$lifecycleReady"
Write-Host "XAUUSD_POSITIONS=$($positions.Count)"
Write-Host "XAUUSD_PENDING_ORDERS=$($pendingOrders.Count)"
Write-Host "UNRESOLVED_MUTATING_REQUESTS=$unresolvedMutatingRequests"
Write-Host "RUNTIME_ROOT=$RuntimeRoot"
Write-Host "ACCOUNT_MODE=$accountMode"
Write-Host "ACCOUNT_LOGIN=$accountLogin"
Write-Host "ACCOUNT_SERVER=$accountServer"
Write-Host "CANONICAL_ACCOUNT_LOGIN=$canonicalLoginOutput"
Write-Host "CANONICAL_ACCOUNT_SERVER=$canonicalServerOutput"
Write-Host "ACCOUNT_ENV_FILE_BINDING_VALID=$accountEnvFileBindingValid"
Write-Host "BRIDGE_HEALTHY=$bridgeHealthy"
Write-Host "BRIDGE_ACCOUNT_MODE_MATCH=$bridgeAccountModeMatch"
Write-Host "BRIDGE_ACCOUNT_IDENTITY_MATCH=$bridgeAccountIdentityMatch"
Write-Host "LIVE_AUTHORIZATION_VALID=$liveAuthorizationOutput"
Write-Host "TASK_OWNERSHIP=$(if ($taskOwnershipCanonical) { 'CANONICAL_SYSTEM' } else { 'NOT_CANONICAL' })"
Write-Host "TASK_DRIFT=$taskDriftOutput"
Write-Host "TASK_STATE=$taskState"
Write-Host "TASK_LAST_RESULT=$taskLastResult"
Write-Host "TASK_READ_STATUS=$taskReadStatus"
Write-Host "TASK_OWNERSHIP_EVALUATION=$taskOwnershipEvaluation"
Write-Host "TASK_RUNNER_HASH_STATUS=$taskRunnerHashStatus"
Write-Host "TASK_RUNNER_PATH_STATUS=$taskRunnerPathStatus"
Write-Host "TASK_RUNNER_SHA_STATUS=$taskRunnerShaStatus"
Write-Host "TASK_RUNNER_MISSING_COMMAND=$taskRunnerMissingCommand"
Write-Host "TASK_ACTION_OWNERSHIP_STATUS=$taskActionOwnershipStatus"
Write-Host "TASK_DRIFT_EVALUATION_STATUS=$taskDriftEvaluationStatus"
Write-Host "TASK_PRINCIPAL_EVALUATION_STATUS=$taskPrincipalEvaluationStatus"
Write-Host "TASK_OWNERSHIP_ERROR_STAGE=$taskOwnershipErrorStage"
Write-Host "TASK_OWNERSHIP_ERROR_TYPE=$taskOwnershipErrorType"
Write-Host "RUNTIME_SOURCE_OVERALL=$runtimeSourceOverall"
Write-Host "RUNTIME_SOURCE_NON_EXACT_COMPONENTS=$nonExactOutput"
Write-Host "RECOVERY_REQUIRED=$recoveryRequired"
Write-Host "RECOVERY_MUTATION_ALLOWED=$recoveryMutationAllowed"
Write-Host "PREFLIGHT_CLASSIFICATION=$classification"
Write-Host "BLOCKED_BY=$blockedBy"

if ($classification -in @('RECOVERY_ALLOWED','NO_RECOVERY_REQUIRED')) {
    Write-Host 'PHASE7C_PRODUCTION_READONLY_PREFLIGHT_V2=PASS'
    exit 0
}

Write-Host 'PHASE7C_PRODUCTION_READONLY_PREFLIGHT_V2=BLOCKED'
exit 2