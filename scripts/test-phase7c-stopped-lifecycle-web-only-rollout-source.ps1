$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptsRoot = $PSScriptRoot
$SnapshotPath = Join-Path $ScriptsRoot 'snapshot-phase7c-stopped-lifecycle-web-only-safety-local.ps1'
$RolloutPath = Join-Path $ScriptsRoot 'rollout-phase7c-stopped-lifecycle-web-only-local.ps1'

foreach ($required in @($SnapshotPath, $RolloutPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required stopped-lifecycle Web-only rollout source is missing: $required"
  }
}

$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw
$rollout = Get-Content -LiteralPath $RolloutPath -Raw

# Syntax must parse under Windows PowerShell-compatible parser before semantic checks.
[void][scriptblock]::Create($snapshot)
[void][scriptblock]::Create($rollout)

function Assert-Match([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -notmatch $Pattern) { throw $Message }
}
function Assert-NoMatch([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -match $Pattern) { throw $Message }
}
function Assert-Ordered([string]$Text, [string]$First, [string]$Second, [string]$Message) {
  $firstIndex = $Text.IndexOf($First, [System.StringComparison]::OrdinalIgnoreCase)
  $secondIndex = $Text.IndexOf($Second, [System.StringComparison]::OrdinalIgnoreCase)
  if ($firstIndex -lt 0 -or $secondIndex -lt 0 -or $firstIndex -ge $secondIndex) { throw $Message }
}

# Steps 4-5: read-only safety snapshot must be canonical and fail closed.
Assert-Match $snapshot '/api/v1/phase7c/bot-mode' 'Snapshot must read canonical bot mode.'
Assert-Match $snapshot '/api/v1/phase7c-live-arm-control/capability' 'Snapshot must read canonical LIVE ARM capability.'
Assert-Match $snapshot '/api/v1/phase7c/lifecycle' 'Snapshot must read canonical lifecycle state.'
Assert-Match $snapshot '/v1/positions\?symbol=XAUUSD' 'Snapshot must read XAUUSD positions.'
Assert-Match $snapshot '/v1/orders\?symbol=XAUUSD' 'Snapshot must read XAUUSD pending orders.'
Assert-Match $snapshot 'BOT_MODE=PAUSE' 'Snapshot must require PAUSE.'
Assert-Match $snapshot 'ARM=DISARMED' 'Snapshot must require DISARMED.'
Assert-Match $snapshot 'LIFECYCLE_RUNNING=false' 'Snapshot must require stopped lifecycle.'
Assert-Match $snapshot 'POSITIONS=0' 'Snapshot must require zero XAUUSD positions.'
Assert-Match $snapshot 'PENDING_ORDERS=0' 'Snapshot must require zero XAUUSD pending orders.'
Assert-Match $snapshot 'bridgeSessionId' 'Snapshot must capture Bridge session identity.'

# Canonical executor Scheduled Task ownership must be proven read-only before source acceptance.
Assert-Match $snapshot 'phase7c-scheduled-task-ownership\.ps1' 'Snapshot must import canonical Scheduled Task ownership helpers.'
Assert-Match $snapshot 'XAUUSD-Phase7C-Executors' 'Snapshot must inspect the canonical Phase7C executor Scheduled Task.'
Assert-Match $snapshot 'Get-Phase7CExecutorTaskRunnerPath' 'Snapshot must resolve the canonical executor runner path.'
Assert-Match $snapshot 'Get-Phase7CTrustedGitFileSha256' 'Snapshot must bind task ownership to the trusted Git HEAD runner hash.'
Assert-Match $snapshot 'Test-Phase7CExecutorTaskActionOwnership' 'Snapshot must verify exact task action ownership.'
Assert-Match $snapshot 'Get-Phase7CExecutorTaskDrift' 'Snapshot must reject Scheduled Task definition drift.'
Assert-Match $snapshot 'ServiceAccount' 'Snapshot must require the canonical SYSTEM ServiceAccount principal.'
Assert-Match $snapshot 'Highest' 'Snapshot must require highest run level.'
Assert-Match $snapshot 'PHASE7C_STOPPED_WEB_SAFETY_TASK_OWNERSHIP=CANONICAL' 'Snapshot must emit canonical task ownership evidence.'
Assert-Match $snapshot 'PHASE7C_STOPPED_WEB_SAFETY_TASK_DRIFT=NONE' 'Snapshot must emit zero task drift evidence.'

# Inactive runtime-source components must be proven safely inactive before and after Web/API acceptance.
Assert-Match $snapshot 'phase7c-runtime-source-attestation\.ps1' 'Snapshot must import runtime-source attestation helpers.'
Assert-Match $snapshot '/api/v1/phase7c/runtime-source-attestation' 'Snapshot must read canonical runtime-source attestation through GET.'
foreach ($inactiveRole in @('supervisor', 'trend', 'sideway', 'telegram', 'regime-notifier')) {
  Assert-Match $snapshot ([regex]::Escape($inactiveRole)) "Snapshot must account for inactive runtime-source component '$inactiveRole'."
}
Assert-Match $snapshot 'STALE' 'Snapshot must require inactive attestations to be STALE/dead by default.'
Assert-Match $snapshot 'PID_REUSED_UNRELATED' 'Snapshot must explicitly classify the proven safe PID-reuse exception.'
Assert-Match $snapshot 'SOURCE_COMMIT_MISMATCH' 'PID-reuse exception must be restricted to provenance-only mismatch reasons.'
Assert-Match $snapshot 'SOURCE_TREE_MISMATCH' 'PID-reuse exception must be restricted to provenance-only mismatch reasons.'
Assert-Match $snapshot 'DEPLOYMENT_ID_MISMATCH' 'PID-reuse exception must be restricted to provenance-only mismatch reasons.'
Assert-Match $snapshot 'run-phase7c-regime-notifier-local\.ps1' 'PID-reuse proof must scan for the regime-notifier wrapper.'
Assert-Match $snapshot 'run-phase7c-regime-notifier\.mjs' 'PID-reuse proof must scan for the regime-notifier child.'
Assert-Match $snapshot 'regime-notifier\.pid' 'PID-reuse proof must require the canonical regime-notifier PID file to be absent.'
Assert-Match $snapshot 'Get-CimInstance\s+Win32_Process' 'PID-reuse proof must inspect the Windows process table read-only.'
Assert-Match $snapshot 'PHASE7C_STOPPED_WEB_SAFETY_INACTIVE_ATTESTATIONS=SAFE' 'Snapshot must emit explicit inactive-attestation acceptance evidence.'

Assert-NoMatch $snapshot '(?i)Invoke-RestMethod[^\r\n]*-Method\s+Post|Invoke-WebRequest[^\r\n]*-Method\s+Post' 'Snapshot must be GET-only.'
Assert-NoMatch $snapshot '(?i)/command|ARM_LIVE|DISARM_LIVE|Start-ScheduledTask|Stop-ScheduledTask|Stop-Process|taskkill|Register-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask' 'Snapshot must not contain runtime mutation primitives.'

# Steps 4-8 orchestration: preflight first, provenance initializer second, Web-only deploy third.
Assert-Match $rollout 'snapshot-phase7c-stopped-lifecycle-web-only-safety-local\.ps1' 'Rollout must invoke dedicated read-only safety snapshot.'
Assert-Match $rollout 'initialize-phase7c-runtime-source-deployment-local\.ps1' 'Rollout must invoke provenance-only initializer.'
Assert-Match $rollout 'deploy-phase7c-stopped-lifecycle-web-only-local\.ps1' 'Rollout must invoke only the stopped-lifecycle Web deploy helper.'
Assert-Ordered $rollout 'snapshot-phase7c-stopped-lifecycle-web-only-safety-local.ps1' 'initialize-phase7c-runtime-source-deployment-local.ps1' 'Safety snapshot must occur before deployment identity initialization.'
Assert-Ordered $rollout 'initialize-phase7c-runtime-source-deployment-local.ps1' 'deploy-phase7c-stopped-lifecycle-web-only-local.ps1' 'Deployment identity must be initialized before Web-only reload.'
Assert-Match $rollout 'deployment\.json' 'Rollout must read canonical deployment manifest.'
Assert-Match $rollout 'ExpectedDeploymentId' 'Rollout must bind the accepted deploymentId into Web-only reload.'
Assert-Match $rollout 'ExpectedCommit' 'Rollout must bind exact expected commit.'
Assert-Match $rollout 'ExpectedTree' 'Rollout must bind exact expected tree.'
Assert-Match $rollout 'POST_ACCEPT' 'Rollout must emit explicit post-accept result.'
Assert-Match $rollout 'MODE_UNCHANGED' 'Rollout must report mode invariant.'
Assert-Match $rollout 'ARM_UNCHANGED' 'Rollout must report ARM invariant.'
Assert-Match $rollout 'BRIDGE_UNCHANGED' 'Rollout must report Bridge invariant.'
Assert-Match $rollout 'POSITIONS_UNCHANGED' 'Rollout must report position invariant.'
Assert-Match $rollout 'PENDING_ORDERS_UNCHANGED' 'Rollout must report pending-order invariant.'
Assert-Match $rollout 'LIFECYCLE_STILL_STOPPED' 'Rollout must report lifecycle invariant.'

# The orchestration layer delegates the one approved mutation to the Web-only helper and must not broaden scope.
Assert-NoMatch $rollout '(?i)deploy-phase7c-mt5-dashboard-local\.ps1|recover-phase7c-runtime-ready-stable-deploy-local\.ps1|rollout-phase7c-production-source-transition-local\.ps1' 'Rollout must not call strict dashboard/recovery/source-transition mutators.'
Assert-NoMatch $rollout '(?i)Start-ScheduledTask|Stop-ScheduledTask|Stop-Process|taskkill|Register-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask' 'Rollout must not mutate tasks/processes directly.'
Assert-NoMatch $rollout '(?i)Invoke-RestMethod[^\r\n]*-Method\s+Post|Invoke-WebRequest[^\r\n]*-Method\s+Post|/command|ARM_LIVE|DISARM_LIVE' 'Rollout must not contain HTTP/order/mode/ARM mutation primitives.'

Write-Host 'PHASE7C_STOPPED_LIFECYCLE_WEB_ONLY_ROLLOUT_SOURCE_CONTRACT=PASS'
