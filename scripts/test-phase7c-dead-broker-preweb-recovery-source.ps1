$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $PSScriptRoot 'recover-phase7c-dead-broker-preweb-v2-local.ps1'

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

# Production incident contract: source generation is already exact, but the canonical
# lifecycle broker is dead, its heartbeat is missing/stale, Task Scheduler is Ready
# with zero running instances, the singleton lock is released, and orphan executor
# wrappers can still exist. This dedicated recovery path must restore only the broker
# and lifecycle boundary before the existing strict Web/API recovery is run again.
Assert-True (Test-Path -LiteralPath $Helper -PathType Leaf) "RED: dedicated dead-broker recovery helper must exist"
Assert-PowerShellSyntax $Helper

$text = (Get-Content -LiteralPath $Helper -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

Assert-True ($text.Contains('[Parameter(Mandatory = $true)] [string]$ExpectedCommit')) "helper must require exact ExpectedCommit"
Assert-True ($text.Contains('[Parameter(Mandatory = $true)] [string]$ExpectedRuntimeCommit')) "helper must pin the pre-existing accepted runtime commit independently from local HEAD"
Assert-True ($text.Contains('requires branch main')) "helper must require branch main"
Assert-True ($text.Contains('requires a clean worktree')) "helper must require clean worktree"
Assert-True ($text.Contains('exact commit mismatch')) "helper must reject source SHA mismatch"
Assert-True ($text.Contains('$runtimeTransitionChangedPaths')) "helper must explicitly inspect source-transition changed paths"
Assert-True ($text.Contains('scripts/recover-phase7c-dead-broker-preweb-v2-local.ps1')) "runtime transition allowlist must include only the dedicated helper source"
Assert-True ($text.Contains('scripts/test-phase7c-dead-broker-preweb-recovery-source.ps1')) "runtime transition allowlist must include the dedicated source contract"
Assert-True ($text.Contains('.github/workflows/phase7c-dead-broker-preweb-recovery-ci.yml')) "runtime transition allowlist must include the dedicated CI workflow"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_RUNTIME_SOURCE_TRANSITION=UNCHANGED_RUNTIME_FILES')) "helper must prove no runtime-loaded files changed between accepted runtime and local HEAD"
Assert-True ($text.Contains('[string]$deployment.sourceCommit -ne $ExpectedRuntimeCommit')) "helper must prove the current runtime manifest belongs to the explicitly pinned pre-existing runtime commit"

Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB=ELIGIBLE')) "helper must expose bounded dead-broker eligibility"
Assert-True ($text.Contains('[string]$deadBrokerTask.State -eq ''Ready''')) "helper must require Scheduled Task Ready"
Assert-True ($text.Contains('$deadBrokerCanonicalProcessCount -eq 0')) "helper must require zero canonical task processes"
Assert-True ($text.Contains('$deadBrokerRunningInstanceCount -eq 0')) "helper must require zero Scheduler running instances"
Assert-True ($text.Contains('[string]$deadBrokerGeneration.statusReadState -eq ''OK''')) "helper must retain readable old broker status evidence"
Assert-True ($text.Contains('[string]$deadBrokerGeneration.heartbeatReadState -in @(''MISSING'', ''OK'')')) "helper must explicitly support missing/stale heartbeat evidence"
Assert-True ($text.Contains('-not [bool]$deadBrokerGeneration.brokerProcessAlive')) "helper must prove broker process unavailable"
Assert-True ($text.Contains('-not [bool]$deadBrokerGeneration.brokerHeartbeatFresh')) "helper must prove heartbeat not fresh"
Assert-True ($text.Contains('[string]$deadBrokerGeneration.startupRunnerLockState -in @(''MISSING'', ''RELEASED'')')) "helper must require released/missing singleton lock"
Assert-True ($text.Contains('$deadBrokerOldPidProcess = Get-Process -Id ([int]$deadBrokerGeneration.statusBrokerPid) -ErrorAction SilentlyContinue')) "helper must independently prove the old status broker PID is dead"
Assert-True ($text.Contains('$deadBrokerLifecycle.running') -and $text.Contains('$deadBrokerLifecycle.ready')) "helper must require lifecycle unavailable before recovery"

Assert-True ($text.Contains('Test-Phase7CExecutorTaskActionOwnership')) "helper must prove canonical task ownership"
Assert-True ($text.Contains('Get-Phase7CExecutorTaskDrift')) "helper must reject Scheduled Task definition drift"
Assert-True ($text.Contains('Test-Phase7CSystemTaskPrincipal')) "helper must require SYSTEM + ServiceAccount + Highest"
Assert-True ($text.Contains('Assert-PauseDisarmed -Stage "DEAD_BROKER_PRE_WEB"')) "helper must re-prove PAUSE + DISARMED"
Assert-True ($text.Contains('Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "DEAD_BROKER_PRE_WEB"')) "helper must pin Bridge session"
Assert-True ($text.Contains('Assert-FlatBroker -Stage "DEAD_BROKER_PRE_WEB"')) "helper must require flat XAUUSD"

$startTaskMatches = [regex]::Matches($text, [regex]::Escape('Start-ScheduledTask -TaskName $TaskName'))
Assert-True ($startTaskMatches.Count -eq 1) "helper must start the existing canonical Scheduled Task exactly once"
Assert-True (-not $text.Contains('Stop-ScheduledTask')) "dead-broker Ready/zero-instance recovery must not stop Task Scheduler"
Assert-True (-not $text.Contains('Stop-Process')) "helper must not directly kill arbitrary processes"
Assert-True (-not $text.Contains('taskkill.exe')) "helper must leave orphan cleanup to canonical broker START"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_TASK_RESTART=PASS')) "helper must audit canonical task restart"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_BROKER_ATTESTATION=EXACT')) "helper must prove new broker attestation equals accepted deployment"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_STARTUP_RUNNER_LOCK=HELD')) "helper must prove singleton lock HELD"

Assert-True ($text.Contains('[void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})')) "helper must use canonical lifecycle START"
Assert-True (-not $text.Contains('$preStartReconcile')) "helper itself must not duplicate broker START orphan reconciliation"
Assert-True ($text.Contains('Wait-LifecycleReadyStable')) "helper must require continuous lifecycle readiness"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_LIFECYCLE_READY=PASS')) "helper must audit stable lifecycle readiness"
Assert-True ($text.Contains('Get-Phase7CRuntimeSourceGenerationAttestationStatus')) "helper must prove final runtime source generation exact"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_FINAL_SOURCE_ATTESTATION=EXACT')) "helper must audit final source attestation exact"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_FINAL_MODE=PAUSE')) "helper must finish PAUSE"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_FINAL_ARM=DISARMED')) "helper must finish DISARMED"
Assert-True ($text.Contains('PHASE7C_DEAD_BROKER_PRE_WEB_NEXT_ACTION=RUN_RUNTIME_READY_STABLE_RECOVERY')) "helper must hand off to existing strict recovery"

Assert-True (-not $text.Contains('deploy-phase7c-web-ui-local.ps1')) "dedicated helper must not weaken or bypass strict Web/API deploy"
Assert-True (-not $text.Contains('ARM_LIVE')) "helper must never ARM LIVE"
Assert-True (-not $text.Contains('@{ mode = "AUTO"')) "helper must never set AUTO"
Assert-True (-not $text.Contains('LIVE_TEST_ORDER')) "helper must not contain live test-order behavior"

Write-Host 'PHASE7C_DEAD_BROKER_PREWEB_RECOVERY_SOURCE_TEST=PASS'
