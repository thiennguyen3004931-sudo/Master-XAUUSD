$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$HelperPath = Join-Path $PSScriptRoot 'transition-phase7c-stopped-lifecycle-released-lock-source-local.ps1'
if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
  throw "RED: released-lock source-resume helper is missing: $HelperPath"
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

Assert-PowerShellSyntax $HelperPath
$source = (Get-Content -LiteralPath $HelperPath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

$forbidden = @(
  'Start-ScheduledTask',
  'Stop-ScheduledTask',
  'Register-ScheduledTask',
  'Unregister-ScheduledTask',
  'Restart-Service',
  'Invoke-ApiPost',
  '-Method Post',
  '/api/v1/phase7c/lifecycle/start',
  '/api/v1/phase7c/lifecycle/stop',
  'ARM_LIVE',
  'DISARM_LIVE',
  'AUTO',
  '/v1/close'
)
foreach ($token in $forbidden) {
  Assert-True (-not $source.Contains($token)) "Released-lock source resume must not contain runtime mutation token: $token"
}

$required = @(
  '[Parameter(Mandatory = $true)] [string]$ProjectRoot',
  '[Parameter(Mandatory = $true)] [string]$ExpectedCurrentCommit',
  '[Parameter(Mandatory = $true)] [string]$TargetCommit',
  '[Parameter(Mandatory = $true)] [string]$ExpectedRemoteMainCommit',
  '[Parameter(Mandatory = $true)] [string]$ExpectedHelperBlobSha1',
  '[Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$ExpectedBridgeSessionId',
  '[Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$ExpectedBrokerPid',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_HELPER_FILE_PROVENANCE=PASS',
  'git hash-object',
  'git status --porcelain',
  'git ls-remote',
  'git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main',
  'git merge-base --is-ancestor',
  'git merge --ff-only',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_GIT_MODE=EXACT_FF_ONLY',
  '/api/v1/phase7c/bot-mode',
  '/api/v1/phase7c-live-arm-control/capability',
  '/api/v1/phase7c/lifecycle',
  '/health',
  '/v1/positions?symbol=XAUUSD',
  '/v1/orders?symbol=XAUUSD',
  'Get-Phase7CCanonicalTaskProcessIds',
  'Get-Phase7CRunningTaskInstanceCount',
  '[string]$generation.startupRunnerLockState -in @(''MISSING'', ''RELEASED'')',
  '$canonicalProcessIds.Count -eq 1',
  '$runningTaskInstanceCount -eq 1',
  '[int]$canonicalProcessIds[0] -eq [int]$generation.statusBrokerPid',
  '[bool]$generation.brokerProcessAlive',
  '[bool]$generation.brokerHeartbeatFresh',
  '[bool]$generation.brokerStatusPidMatch',
  '[string]$brokerAttestation.component -eq ''lifecycle-broker''',
  '[int]$brokerAttestation.pid -eq [int]$generation.statusBrokerPid',
  '$attestedLauncherSha256 -eq $expectedLauncherSha256',
  'Test-Phase7CExecutorTaskActionOwnership',
  'Get-Phase7CExecutorTaskDrift',
  'Test-Phase7CSystemTaskPrincipal',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_PREFLIGHT=PASS',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_PRE_MUTATION_RECHECK=PASS',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_GIT_FAST_FORWARD=PASS',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_POST_SOURCE=PASS',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_FINAL_MODE=PAUSE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_FINAL_ARM=DISARMED',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_TASK_MUTATION=NONE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_LIFECYCLE_MUTATION=NONE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_BRIDGE_RESTART=NONE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_ORDER_MUTATION=NONE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_POSITION_MUTATION=NONE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_LIVE_TEST_ORDER=NONE',
  'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_NEXT_ACTION=RUN_CANONICAL_RUNTIME_READY_RECOVERY'
)
foreach ($token in $required) {
  Assert-True ($source.Contains($token)) "RED: released-lock source resume contract missing: $token"
}

# Initial preflight deliberately has no prior Bridge session or broker PID yet. The
# snapshot helper must therefore explicitly allow empty string sentinels; otherwise
# PowerShell mandatory-string binding fails before any safety probe can run.
Assert-True ($source.Contains("-ExpectedBridgeSessionId ''")) `
  'Initial released-lock preflight must use an empty Bridge-session sentinel.'
Assert-True ($source.Contains("-ExpectedBrokerPid ''")) `
  'Initial released-lock preflight must use an empty broker-PID sentinel.'

# Source-only transition must prove the guarded runner is byte-identical across
# current and target so the already-running canonical SYSTEM task remains trusted.
Assert-True ($source.Contains('$currentRunnerBlob -ne $targetRunnerBlob')) `
  'Released-lock source transition must block when runner Git blob changes across the FF.'

# The abnormal lock state remains repair-required. The source transition may carry it
# forward unchanged, but must never normalize it to HEALTHY or HELD before recovery.
Assert-True (-not $source.Contains('RELEASED_LOCK=HEALTHY')) `
  'Released lock must never be normalized to healthy by source-only transition.'
Assert-True (-not $source.Contains('STARTUP_RUNNER_LOCK=HELD')) `
  'Source-only transition must not claim it restored the startup lock.'

Write-Host 'PHASE7C_RELEASED_LOCK_SOURCE_RESUME_SOURCE_TEST=PASS'
