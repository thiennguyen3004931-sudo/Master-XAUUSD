param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProbePath = Join-Path $PSScriptRoot 'preflight-phase7c-production-readonly-local.ps1'
if (-not (Test-Path -LiteralPath $ProbePath -PathType Leaf)) {
    throw 'RED_TARGET: missing strict production read-only preflight helper.'
}

$source = Get-Content -LiteralPath $ProbePath -Raw
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ProbePath, [ref]$tokens, [ref]$errors)
if (@($errors).Count -ne 0) {
    throw "Production read-only preflight has PowerShell parse errors: $(@($errors | ForEach-Object Message) -join '; ')"
}

# Execute only the extracted read-only hash helper on the repository source,
# without invoking the production preflight or accessing live control endpoints.
$hashFunction = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Get-Phase7CReadOnlyRunnerSha256'
}, $true))
if ($hashFunction.Count -ne 1) {
    throw 'Expected exactly one independent read-only runner SHA-256 helper.'
}
$sourceHash = $hashFunction[0].Extent.Text
foreach ($requiredHashContract in @(
    '[System.IO.File]::OpenRead($Path)',
    '[System.Security.Cryptography.SHA256]::Create()',
    'ComputeHash($stream)',
    '$stream.Dispose()',
    '$hasher.Dispose()'
)) {
    if (-not $sourceHash.Contains($requiredHashContract)) {
        throw "Read-only SHA-256 helper missing safety boundary: $requiredHashContract"
    }
}
if ($sourceHash -match '\bGet-FileHash\b') {
    throw 'Read-only SHA-256 helper must not depend on Get-FileHash availability.'
}
. ([scriptblock]::Create($sourceHash))
$referenceHasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $referenceBytes = [System.IO.File]::ReadAllBytes($ProbePath)
    $expectedHash = [System.BitConverter]::ToString($referenceHasher.ComputeHash($referenceBytes)).Replace('-', '')
} finally {
    $referenceHasher.Dispose()
}
# Prove helper is independent of the unavailable cmdlet on a safe test file.
function Get-FileHash { throw 'SYNTHETIC_COMMAND_NOT_FOUND' }
$actualHash = Get-Phase7CReadOnlyRunnerSha256 -Path $ProbePath
if ($actualHash -cne $expectedHash) {
    throw 'Read-only SHA-256 helper produced the wrong digest.'
}
$missingHashRejected = $false
try {
    [void](Get-Phase7CReadOnlyRunnerSha256 -Path (Join-Path $PSScriptRoot 'non-existent-sha-fixture.txt'))
} catch {
    $missingHashRejected = $true
}
if (-not $missingHashRejected) { throw 'Missing runner file must fail closed.' }

$requiredMarkers = @(
    'READ_ONLY=TRUE',
    'HTTP_METHODS=GET_ONLY',
    'GIT_MUTATION=NONE',
    'DEPLOYMENT_MANIFEST_MUTATION=NONE',
    'TASK_MUTATION=NONE',
    'PROCESS_MUTATION=NONE',
    'LIFECYCLE_MUTATION=NONE',
    'MODE_MUTATION=NONE',
    'ARM_MUTATION=NONE',
    'BRIDGE_RESTART=NONE',
    'EXECUTOR_RESTART=NONE',
    'ORDER_MUTATION=NONE',
    'POSITION_MUTATION=NONE',
    'LIVE_TEST_ORDER=NONE',
    'SECRET_VALUES_PRINTED=FALSE'
)
foreach ($marker in $requiredMarkers) {
    if (-not $source.Contains($marker)) { throw "Missing strict read-only attestation marker: $marker" }
}

$requiredEvidence = @(
    'LOCAL_BRANCH=',
    'LOCAL_HEAD=',
    'LOCAL_TREE=',
    'LOCAL_DIRTY_COUNT=',
    'REMOTE_MAIN=',
    'DEPLOYMENT_SOURCE_COMMIT=',
    'DEPLOYMENT_SOURCE_TREE=',
    'DEPLOYMENT_ID=',
    'BOT_MODE=',
    'ARM=',
    'LIFECYCLE_RUNNING=',
    'LIFECYCLE_READY=',
    'XAUUSD_POSITIONS=',
    'XAUUSD_PENDING_ORDERS=',
    'UNRESOLVED_MUTATING_REQUESTS=',
    'RUNTIME_ROOT=',
    'ACCOUNT_MODE=',
    'ACCOUNT_LOGIN=',
    'ACCOUNT_SERVER=',
    'CANONICAL_ACCOUNT_LOGIN=',
    'CANONICAL_ACCOUNT_SERVER=',
    'ACCOUNT_ENV_FILE_BINDING_VALID=',
    'BRIDGE_ACCOUNT_IDENTITY_MATCH=',
    'LIVE_AUTHORIZATION_VALID=',
    'TASK_OWNERSHIP=',
    'TASK_DRIFT=',
    'TASK_READ_STATUS=',
    'TASK_OWNERSHIP_EVALUATION=',
    'TASK_RUNNER_HASH_STATUS=',
    'TASK_RUNNER_PATH_STATUS=',
    'TASK_RUNNER_SHA_STATUS=',
    'TASK_RUNNER_MISSING_COMMAND=',
    'TASK_ACTION_OWNERSHIP_STATUS=',
    'TASK_DRIFT_EVALUATION_STATUS=',
    'TASK_PRINCIPAL_EVALUATION_STATUS=',
    'TASK_OWNERSHIP_ERROR_STAGE=',
    'TASK_OWNERSHIP_ERROR_TYPE=',
    'RUNTIME_SOURCE_OVERALL=',
    'RECOVERY_MUTATION_ALLOWED=',
    'BLOCKED_BY='
)
foreach ($marker in $requiredEvidence) {
    if (-not $source.Contains($marker)) { throw "Missing production preflight evidence output: $marker" }
}

# ScheduledTask LastTaskResult is optional telemetry. Under StrictMode its absence
# must not collapse a readable/canonical task into a generic ownership failure.
foreach ($taskSafetyMarker in @(
    "PSObject.Properties['LastTaskResult']",
    "TASK_PROVIDER_READ_FAILED",
    "TASK_READ_STATUS=",
    "TASK_OWNERSHIP_EVALUATION=",
    "TASK_RUNNER_HASH_STATUS=",
    "TASK_RUNNER_PATH_STATUS=",
    "TASK_RUNNER_SHA_STATUS=",
    "TASK_RUNNER_MISSING_COMMAND=",
    "TASK_RUNNER_PATH_EVALUATION_FAILED",
    "TASK_ACTION_OWNERSHIP_STATUS=",
    "TASK_DRIFT_EVALUATION_STATUS=",
    "TASK_PRINCIPAL_EVALUATION_STATUS=",
    "TASK_OWNERSHIP_ERROR_STAGE=",
    "TASK_OWNERSHIP_ERROR_TYPE=",
    "TASK_RUNNER_HASH_EVALUATION_FAILED",
    "TASK_ACTION_OWNERSHIP_EVALUATION_FAILED",
    "TASK_DRIFT_EVALUATION_FAILED",
    "TASK_PRINCIPAL_EVALUATION_FAILED"
)) {
    if (-not $source.Contains($taskSafetyMarker)) {
        throw "Missing fail-closed task ownership/optional telemetry separation: $taskSafetyMarker"
    }
}
if ($source.Contains("TASK_READ_FAILED")) {
    throw 'Generic TASK_READ_FAILED must not hide whether provider read or ownership evaluation failed.'
}
if ($source.Contains('$taskDrift = @(''TASK_OWNERSHIP_EVALUATION_FAILED'')')) {
    throw 'A single generic ownership catch must not replace staged task ownership diagnostics.'
}
foreach ($stageCall in @(
    "Set-TaskOwnershipError -Stage 'RUNNER_PATH'",
    "Set-TaskOwnershipError -Stage 'RUNNER_HASH'",
    "Set-TaskOwnershipError -Stage 'ACTION_OWNERSHIP'",
    "Set-TaskOwnershipError -Stage 'TASK_DRIFT'",
    "Set-TaskOwnershipError -Stage 'TASK_PRINCIPAL'"
)) {
    if (-not $source.Contains($stageCall)) {
        throw "Missing staged task ownership failure classification: $stageCall"
    }
}
$lastTaskResultIndex = $source.IndexOf("PSObject.Properties['LastTaskResult']", [System.StringComparison]::Ordinal)
$ownershipEvalIndex = $source.IndexOf('Test-Phase7CExecutorTaskActionOwnership', [System.StringComparison]::Ordinal)
if ($lastTaskResultIndex -lt 0 -or $ownershipEvalIndex -lt 0 -or $lastTaskResultIndex -ge $ownershipEvalIndex) {
    throw 'Optional LastTaskResult telemetry guard must be isolated before canonical ownership evaluation.'
}

$requiredEndpoints = @(
    '/api/v1/phase7c/bot-mode',
    '/api/v1/phase7c/lifecycle',
    '/api/v1/phase7c-live-arm-control/capability',
    '/api/v1/phase7c-account-switch/same-mode-readiness',
    '/api/v1/phase7c-account-switch/status',
    '/api/v1/phase7c-live-arm-control/status',
    '/api/v1/phase7c/runtime-source-attestation',
    '/v1/positions?symbol=XAUUSD',
    '/v1/orders?symbol=XAUUSD'
)
foreach ($endpoint in $requiredEndpoints) {
    if (-not $source.Contains($endpoint)) { throw "Missing required GET-only evidence endpoint: $endpoint" }
}

$componentNames = @('api','web','supervisor','trend','sideway','telegram','regime-notifier','lifecycle-broker')
foreach ($component in $componentNames) {
    if (-not $source.Contains($component)) { throw "Missing runtime-source component coverage: $component" }
}

foreach ($runtimeRootMarker in @('PHASE7C_RUNTIME_ROOT','PHASE7B_DEMO_WORK_DIR')) {
    if (-not $source.Contains($runtimeRootMarker)) {
        throw "Runtime-root resolution must mirror API precedence. Missing=$runtimeRootMarker"
    }
}
foreach ($identityEnvMarker in @('MT5_LOGIN','MT5_SERVER')) {
    if (-not $source.Contains($identityEnvMarker)) {
        throw "Exact canonical account identity must be read from the selected account env. Missing=$identityEnvMarker"
    }
}
if ($source -notmatch '(?i)bridgeAccountIdentityMatch') {
    throw 'Exact broker login/server identity comparison is required.'
}
if ($source -notmatch '(?i)accountEnvFileBindingValid') {
    throw 'Selected account-state envFile must be bound to the executor task config envFile.'
}

$forbiddenCommands = @(
    'Set-Content','Add-Content','Out-File','New-Item','Remove-Item','Move-Item','Copy-Item','Rename-Item','Clear-Content','Set-Item',
    'Start-Process','Stop-Process','Start-ScheduledTask','Stop-ScheduledTask','Register-ScheduledTask','Set-ScheduledTask','Unregister-ScheduledTask',
    'Remove-Job','Start-Job'
)
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
foreach ($commandAst in $commands) {
    $name = $commandAst.GetCommandName()
    if (-not [string]::IsNullOrWhiteSpace($name) -and $forbiddenCommands -contains $name) {
        throw "Strict production read-only preflight contains forbidden command: $name"
    }
}

if ($source -match '(?im)-Method\s+(Post|Put|Patch|Delete)\b') {
    throw 'Strict production read-only preflight must use HTTP GET only.'
}
$gitInvocationLines = @($source -split "`r?`n" | Where-Object { $_ -match '\$gitExe|(?:^|\s)git(?:\.exe)?(?:\s|$)' })
foreach ($line in $gitInvocationLines) {
    if ($line -match '(?i)\b(?:fetch|pull|checkout|reset|switch|restore|clean)\b') {
        throw "Strict production read-only preflight contains mutating Git verb: $line"
    }
}
if ($source -match '(?i)\[System\.IO\.FileMode\]::(?:Create|CreateNew|OpenOrCreate|Append|Truncate)') {
    throw 'Strict production read-only preflight must not open files in a creating/writing mode.'
}
if ($source -match '(?i)(?:WriteAllText|WriteAllBytes|AppendAllText|CreateText|atomicWrite|unlinkSync|writeFileSync|renameSync)') {
    throw 'Strict production read-only preflight contains a forbidden file mutation primitive.'
}

$allowedTaskReads = @('Get-ScheduledTask','Get-ScheduledTaskInfo')
$taskCommands = @($commands | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ -match 'ScheduledTask$' } | Sort-Object -Unique)
foreach ($name in $taskCommands) {
    if ($allowedTaskReads -notcontains $name) { throw "Scheduled Task command is not read-only: $name" }
}

if ($source -notmatch '(?m)&\s+\$gitExe\s+rev-parse\s+HEAD\b') { throw 'Missing local HEAD read through git rev-parse.' }
$quotedHeadTreePattern = '(?m)&\s+\$gitExe\s+rev-parse\s+[''"]HEAD\^\{tree\}[''"]'
if ($source -notmatch $quotedHeadTreePattern) { throw 'Local tree read must pass HEAD^{tree} as one explicitly quoted git rev-parse argument.' }
if ($source -notmatch '(?m)&\s+\$gitExe\s+status\s+--porcelain') { throw 'Missing worktree dirty-state read.' }
if ($source -notmatch '(?m)&\s+\$gitExe\s+ls-remote\s+--heads\s+origin\s+refs/heads/main') { throw 'Remote main must be read with git ls-remote only.' }
if (-not $source.Contains("'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core'")) {
    throw 'Post-M8 production preflight must trust the canonical private HTTPS origin.'
}
if (-not $source.Contains("'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master-core.git'")) {
    throw 'Post-M8 production preflight must trust the canonical private HTTPS .git origin.'
}
if (-not $source.Contains("'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master-core.git'")) {
    throw 'Post-M8 production preflight must trust the canonical private SSH origin.'
}
foreach ($legacyOrigin in @(
    "'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master'",
    "'https://github.com/thiennguyen3004931-sudo/xauusd-ai-master.git'",
    "'git@github.com:thiennguyen3004931-sudo/xauusd-ai-master.git'"
)) {
    if ($source.Contains($legacyOrigin)) {
        throw "Post-M8 production preflight must not trust legacy production origin: $legacyOrigin"
    }
}


Write-Output 'PHASE7C_PRODUCTION_READONLY_PREFLIGHT_V2_SOURCE_CONTRACT=PASS'
