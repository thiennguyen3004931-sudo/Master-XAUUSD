[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{40}$')]
    [string]$ExpectedMainCommit,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedEmbeddedRunnerSha256,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedRunnerSha256,

    [ValidateRange(3, 30)]
    [int]$TimeoutSeconds = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedMainCommit = $ExpectedMainCommit.Trim().ToLowerInvariant()
$expectedEmbeddedSha = $ExpectedEmbeddedRunnerSha256.Trim().ToUpperInvariant()
$expectedRunnerSha = $ExpectedRunnerSha256.Trim().ToUpperInvariant()
$TaskName = 'XAUUSD-Phase7C-Executors'
$TaskPath = '\'
$ExpectedOriginUrls = @(
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master',
    'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git',
    'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master.git'
)

Write-Host '============================================================'
Write-Host '=== PHASE7C TASK REPAIR — STRICT READ-ONLY READINESS ==='
Write-Host '============================================================'
Write-Host 'READ_ONLY=TRUE'
Write-Host 'HTTP_METHODS=GET_ONLY'
Write-Host 'GIT_MUTATION=NONE'
Write-Host 'TASK_MUTATION=NONE'
Write-Host 'PROCESS_MUTATION=NONE'
Write-Host 'LIFECYCLE_MUTATION=NONE'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'POSITION_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "PROJECT_ROOT_NOT_FOUND path=$ProjectRoot"
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
    return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
}
function Test-CanonicalSystemPrincipal($Principal) {
    if ($null -eq $Principal) { return $false }
    $user = ([string]$Principal.UserId).Trim()
    $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
    return $systemUser -and [string]$Principal.LogonType -eq 'ServiceAccount' -and [string]$Principal.RunLevel -eq 'Highest'
}
function Invoke-ApiGet([string]$ControlApiUrl, [string]$Path) {
    return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec $TimeoutSeconds
}
function Read-BridgeArray([string]$BridgeBase, [hashtable]$Headers, [string]$Path) {
    $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $Headers -Method Get -UseBasicParsing -TimeoutSec $TimeoutSeconds
    $raw = ([string]$response.Content).Trim()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
    return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

$localBranch = 'UNAVAILABLE'
$localHead = 'UNAVAILABLE'
$remoteMain = 'UNAVAILABLE'
$localDirtyCount = -1
$originCanonical = $false
$gitExe = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

Push-Location $ProjectRoot
try {
    try {
        $localBranch = ([string](& $gitExe branch --show-current)).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($localBranch)) { throw 'branch read failed' }
    } catch {
        Add-Blocked 'LOCAL_BRANCH_UNAVAILABLE'
    }

    try {
        $localHead = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
        if ($LASTEXITCODE -ne 0 -or $localHead -notmatch '^[0-9a-f]{40}$') { throw 'HEAD read failed' }
    } catch {
        $localHead = 'UNAVAILABLE'
        Add-Blocked 'LOCAL_HEAD_UNAVAILABLE'
    }

    try {
        $dirty = @(& $gitExe status --porcelain --untracked-files=normal)
        if ($LASTEXITCODE -ne 0) { throw 'status read failed' }
        $localDirtyCount = @($dirty | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
    } catch {
        $localDirtyCount = -1
        Add-Blocked 'LOCAL_DIRTY_STATE_UNAVAILABLE'
    }

    try {
        $originUrl = ([string](& $gitExe remote get-url origin)).Trim()
        $originCanonical = $LASTEXITCODE -eq 0 -and $ExpectedOriginUrls -contains $originUrl
    } catch {
        $originCanonical = $false
    }

    try {
        $remoteRaw = @(& $gitExe ls-remote --heads origin refs/heads/main)
        if ($LASTEXITCODE -ne 0 -or $remoteRaw.Count -ne 1) { throw 'remote main read failed' }
        $remoteMain = ([string]$remoteRaw[0]).Split([char]9)[0].Trim().ToLowerInvariant()
        if ($remoteMain -notmatch '^[0-9a-f]{40}$') { throw 'remote main invalid' }
    } catch {
        $remoteMain = 'UNAVAILABLE'
        Add-Blocked 'REMOTE_MAIN_UNAVAILABLE'
    }
} finally {
    Pop-Location
}

if ($localBranch -ne 'main') { Add-Blocked 'LOCAL_BRANCH_NOT_MAIN' }
if ($localHead -ne $ExpectedMainCommit) { Add-Blocked 'LOCAL_HEAD_NOT_EXPECTED_MAIN' }
if ($remoteMain -ne $ExpectedMainCommit) { Add-Blocked 'REMOTE_MAIN_NOT_EXPECTED' }
if ($localDirtyCount -ne 0) { Add-Blocked 'LOCAL_WORKTREE_NOT_CLEAN' }
if (-not $originCanonical) { Add-Blocked 'ORIGIN_REMOTE_NOT_CANONICAL' }
$sourceGate = $localBranch -eq 'main' -and $localHead -eq $ExpectedMainCommit -and $remoteMain -eq $ExpectedMainCommit -and $localDirtyCount -eq 0 -and $originCanonical

$ScriptsRoot = Join-Path $ProjectRoot 'scripts'
$ConfigPath = Join-Path $ProjectRoot '.runtime\phase7c-executor-task-config.json'
$AccountLibrary = Join-Path $ScriptsRoot 'lib\phase7c-account-mode.ps1'
$OwnershipLibrary = Join-Path $ScriptsRoot 'lib\phase7c-scheduled-task-ownership.ps1'
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "REQUIRED_DEPENDENCY_NOT_FOUND path=$required"
    }
}
. $AccountLibrary
. $OwnershipLibrary

$config = Read-JsonFile -Path $ConfigPath -Label 'Executor task config'
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') {
    throw "CONTROL_API_NOT_LOOPBACK value=$ControlApiUrl"
}
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$configAccountMode = ([string]$config.accountMode).Trim().ToUpperInvariant()
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode $configAccountMode
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ 'x-mt5-api-key' = $envInfo.apiKey }

$modeSnapshot = Invoke-ApiGet -ControlApiUrl $ControlApiUrl -Path '/api/v1/phase7c/bot-mode'
$lifecycle = Invoke-ApiGet -ControlApiUrl $ControlApiUrl -Path '/api/v1/phase7c/lifecycle'
$armSnapshot = Invoke-ApiGet -ControlApiUrl $ControlApiUrl -Path '/api/v1/phase7c-live-arm-control/capability'
$positions = @(Read-BridgeArray -BridgeBase $BridgeBase -Headers $BridgeHeaders -Path '/v1/positions?symbol=XAUUSD')
$pendingOrders = @(Read-BridgeArray -BridgeBase $BridgeBase -Headers $BridgeHeaders -Path '/v1/orders?symbol=XAUUSD')

$mode = ([string]$modeSnapshot.state.mode).Trim().ToUpperInvariant()
$arm = ([string]$armSnapshot.liveArmStatus).Trim().ToUpperInvariant()
$lifecycleRunning = [bool]$lifecycle.running
$lifecycleReady = [bool]$lifecycle.ready

if ($mode -ne 'PAUSE') { Add-Blocked 'MODE_NOT_PAUSE' }
if ($arm -ne 'DISARMED' -or [bool]$armSnapshot.liveExecutionArmed) { Add-Blocked 'ARM_NOT_DISARMED' }
if ($lifecycleRunning) { Add-Blocked 'LIFECYCLE_NOT_STOPPED' }
if ($lifecycleReady) { Add-Blocked 'LIFECYCLE_READY_NOT_FALSE' }
if ($positions.Count -ne 0) { Add-Blocked 'XAUUSD_POSITIONS_NONZERO' }
if ($pendingOrders.Count -ne 0) { Add-Blocked 'XAUUSD_PENDING_ORDERS_NONZERO' }

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$actualRunnerSha = (Get-FileHash -LiteralPath $runnerPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
$trustedRunnerSha = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
if ($actualRunnerSha -ne $trustedRunnerSha -or $actualRunnerSha -ne $expectedRunnerSha) {
    Add-Blocked 'RUNNER_ACTUAL_SHA_MISMATCH'
}

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
$ownership = Test-Phase7CExecutorTaskActionOwnership -Actions $task.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $expectedRunnerSha
$taskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
$principalCanonical = Test-CanonicalSystemPrincipal -Principal $task.Principal

if (-not $principalCanonical) { Add-Blocked 'PRINCIPAL_NOT_CANONICAL_SYSTEM' }
if ($taskDrift.Count -ne 0) { Add-Blocked 'TASK_DRIFT_NOT_NONE' }
if (-not [bool]$ownership.owned) { Add-Blocked 'OWNERSHIP_NOT_OWNED' }
if ([bool]$ownership.canonical) { Add-Blocked 'OWNERSHIP_ALREADY_CANONICAL' }
if (-not [bool]$ownership.repairRequired) { Add-Blocked 'OWNERSHIP_REPAIR_NOT_REQUIRED' }
if ([string]$ownership.reason -ne 'OWNED_HASH_DRIFT_REPAIR_REQUIRED') { Add-Blocked 'OWNERSHIP_REASON_NOT_HASH_DRIFT' }

$taskEmbeddedSha = ([string]$ownership.runnerSha256).Trim().ToUpperInvariant()
if ($taskEmbeddedSha -ne $expectedEmbeddedSha) { Add-Blocked 'PRE_REPAIR_EMBEDDED_SHA_MISMATCH' }

$repairAllowed = $sourceGate -and
    $mode -eq 'PAUSE' -and
    $arm -eq 'DISARMED' -and
    -not $lifecycleRunning -and
    -not $lifecycleReady -and
    $positions.Count -eq 0 -and
    $pendingOrders.Count -eq 0 -and
    $actualRunnerSha -eq $expectedRunnerSha -and
    $trustedRunnerSha -eq $expectedRunnerSha -and
    $principalCanonical -and
    $taskDrift.Count -eq 0 -and
    [bool]$ownership.owned -and
    -not [bool]$ownership.canonical -and
    [bool]$ownership.repairRequired -and
    [string]$ownership.reason -eq 'OWNED_HASH_DRIFT_REPAIR_REQUIRED' -and
    $taskEmbeddedSha -eq $expectedEmbeddedSha -and
    $blocked.Count -eq 0

$taskDriftOutput = if ($taskDrift.Count -eq 0) { 'NONE' } else { @($taskDrift) -join '|' }
$blockedBy = if ($blocked.Count -eq 0) { 'NONE' } else { @($blocked) -join '|' }

Write-Host "EXPECTED_MAIN=$ExpectedMainCommit"
Write-Host "LOCAL_BRANCH=$localBranch"
Write-Host "LOCAL_HEAD=$localHead"
Write-Host "REMOTE_MAIN=$remoteMain"
Write-Host "LOCAL_DIRTY_COUNT=$localDirtyCount"
Write-Host "SOURCE_GATE=$sourceGate"
Write-Host "MODE=$mode"
Write-Host "ARM=$arm"
Write-Host "LIFECYCLE_RUNNING=$lifecycleRunning"
Write-Host "LIFECYCLE_READY=$lifecycleReady"
Write-Host "XAUUSD_POSITIONS=$($positions.Count)"
Write-Host "XAUUSD_PENDING_ORDERS=$($pendingOrders.Count)"
Write-Host "RUNNER_ACTUAL_SHA=$actualRunnerSha"
Write-Host "RUNNER_TRUSTED_SHA=$trustedRunnerSha"
Write-Host "TASK_EMBEDDED_SHA=$taskEmbeddedSha"
Write-Host "OWNERSHIP_OWNED=$([bool]$ownership.owned)"
Write-Host "OWNERSHIP_CANONICAL=$([bool]$ownership.canonical)"
Write-Host "OWNERSHIP_REPAIRREQUIRED=$([bool]$ownership.repairRequired)"
Write-Host "OWNERSHIP_REASON=$([string]$ownership.reason)"
Write-Host "TASK_DRIFT=$taskDriftOutput"
Write-Host "PRINCIPAL_CANONICAL_SYSTEM=$principalCanonical"
Write-Host "REPAIR_ALLOWED=$repairAllowed"
Write-Host "BLOCKED_BY=$blockedBy"

if ($repairAllowed) {
    Write-Host 'PHASE7C_TASK_REPAIR_READINESS_PREFLIGHT=PASS'
    exit 0
}

Write-Host 'PHASE7C_TASK_REPAIR_READINESS_PREFLIGHT=BLOCKED'
exit 2
