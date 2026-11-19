$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"

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

Assert-True (Test-Path -LiteralPath $Helper -PathType Leaf) "Missing runtime-ready stable recovery deploy helper: $Helper"
Assert-PowerShellSyntax $Helper

$text = (Get-Content -LiteralPath $Helper -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

# Exact-source + fail-closed LIVE state gates.
Assert-True ($text.Contains('[Parameter(Mandatory = $true)] [string]$ExpectedCommit')) "helper must require exact ExpectedCommit"
Assert-True ($text.Contains('requires branch main')) "helper must require branch main"
Assert-True ($text.Contains('requires a clean worktree')) "helper must require clean worktree"
Assert-True ($text.Contains('exact commit mismatch')) "helper must reject source SHA mismatch"
Assert-True ($text.Contains('current bot mode PAUSE')) "helper must require PAUSE before mutation"
Assert-True ($text.Contains('canonical LIVE ARM=DISARMED')) "helper must require canonical DISARMED before mutation"
Assert-True ($text.Contains('requires configured LIVE account mode')) "helper must require configured LIVE account mode"
Assert-True ($text.Contains('requires zero XAUUSD positions')) "helper must require zero XAUUSD positions"
Assert-True ($text.Contains('requires zero pending XAUUSD orders')) "helper must require zero pending XAUUSD orders"

# Ordinary runtime-ready recovery still deploys Web/API before its stable probe and
# STOP -> repair/reload -> START sequence. Separately proven pre-Web generation paths
# may quiesce or restore runtime before Web deploy, so locate the ordinary STOP only
# within the post-deploy recovery region rather than using the first STOP in the file.
Assert-True ($text.Contains('deploy-phase7c-web-ui-local.ps1')) "helper must reuse canonical Web/API deploy helper"
$deployIndex = $text.IndexOf('& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy', [System.StringComparison]::Ordinal)
$stableProbeIndex = $text.IndexOf('$stableBeforeRecovery = Wait-LifecycleReadyStable', [System.StringComparison]::Ordinal)
$stopLiteral = '"/api/v1/phase7c/lifecycle/stop"'
$stopMatches = [regex]::Matches($text, [regex]::Escape($stopLiteral))
$ordinaryStopCandidates = @($stopMatches | Where-Object { $_.Index -gt $stableProbeIndex })
$startLiteral = '"/api/v1/phase7c/lifecycle/start"'
$startMatches = [regex]::Matches($text, [regex]::Escape($startLiteral))
Assert-True ($startMatches.Count -ge 1) "helper must contain lifecycle START"
$normalStartIndex = $startMatches[$startMatches.Count - 1].Index
Assert-True ($deployIndex -ge 0) "helper must invoke canonical Web/API deploy"
Assert-True ($stableProbeIndex -gt $deployIndex) "stable lifecycle probe must occur only after Web/API deploy"
Assert-True ($ordinaryStopCandidates.Count -eq 1) "ordinary recovery region must contain exactly one lifecycle STOP after stable probe"
$stopIndex = $ordinaryStopCandidates[0].Index
Assert-True ($stopIndex -gt $deployIndex) "ordinary lifecycle STOP must never occur before Web/API deploy"
Assert-True ($normalStartIndex -gt $stopIndex) "ordinary lifecycle START must occur only after STOP when recovery is needed"
Assert-True ($text.Contains('-ExpectedCommit $ExpectedCommit')) "Web/API deploy must use exact ExpectedCommit"
Assert-True ($text.Contains('READY_STABLE_MS=5000')) "helper must require explicit 5 second continuous READY stability"
Assert-True ($text.Contains('READY_STABLE_RESET')) "helper must reset stability window on any non-ready sample"
Assert-True ($text.Contains('LIFECYCLE_RECOVERY=SKIPPED_ALREADY_STABLE')) "helper must retain a same-generation stable no-op path"
Assert-True ($text.Contains('LIFECYCLE_RECOVERY=PERFORMED')) "helper must recover lifecycle when stable readiness or source generation requires it"

# P1 exact-match requires a fresh SYSTEM task generation whenever Initialize-Phase7C
# creates a new deployment identity, even if the old lifecycle is still READY and the
# Scheduled Task definition is already canonical. A stable old generation must never
# qualify for SKIPPED_ALREADY_STABLE after Web/API has adopted the new deployment ID.
Assert-True ($text.Contains('$runtimeSourceGenerationReloadRequired')) "helper must track whether the runtime source deployment identity changed"
Assert-True ($text.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=REQUIRED')) "helper must audit when canonical source generation reload is required"
Assert-True ($text.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=NOT_REQUIRED')) "helper must audit same-generation no-op eligibility"
Assert-True ($text.Contains('$stableBeforeRecovery -and -not $taskRepairRequired -and -not $runtimeSourceGenerationReloadRequired')) "stable lifecycle skip must be blocked when source generation changed"
Assert-True ($text.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_TASK_STOP=PASS')) "canonical generation reload must stop the owned SYSTEM task"
Assert-True ($text.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_BROKER_PROCESS_STOP=PASS')) "canonical generation reload must prove the previous broker exited"
Assert-True ($text.Contains('Start-ScheduledTask -TaskName $TaskName')) "canonical generation reload must restart the same Scheduled Task without repairing its definition"
Assert-True ($text.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_TASK_RESTART=PASS')) "canonical generation reload must audit task restart"
Assert-True ($text.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_STARTUP_RUNNER_LOCK=HELD')) "canonical generation reload must prove the new startup runner lock is HELD"
$generationTaskStopIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_TASK_STOP=PASS', [System.StringComparison]::Ordinal)
$generationBrokerStopIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_BROKER_PROCESS_STOP=PASS', [System.StringComparison]::Ordinal)
$generationLockIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_STARTUP_RUNNER_LOCK=HELD', [System.StringComparison]::Ordinal)
$generationTaskStartMatches = [regex]::Matches($text, [regex]::Escape('Start-ScheduledTask -TaskName $TaskName'))
$generationTaskStartCandidates = @($generationTaskStartMatches | Where-Object {
  $_.Index -gt $generationBrokerStopIndex -and $_.Index -lt $generationLockIndex
})
Assert-True ($generationTaskStartCandidates.Count -eq 1) "post-Web canonical generation reload must have exactly one task start between broker-stop and lock proof"
$generationTaskStartIndex = $generationTaskStartCandidates[0].Index
Assert-True ($generationTaskStopIndex -gt $stopIndex) "generation task stop must occur only after lifecycle STOP"
Assert-True ($generationBrokerStopIndex -gt $generationTaskStopIndex) "generation task restart must wait for old broker exit proof"
Assert-True ($generationTaskStartIndex -gt $generationBrokerStopIndex) "canonical task must restart only after old broker process is dead"
Assert-True ($generationLockIndex -gt $generationTaskStartIndex) "new generation must prove startup lock HELD after task restart"
Assert-True ($normalStartIndex -gt $generationLockIndex) "lifecycle START must occur only after the new SYSTEM generation is proven"

# Battery-stranded pre-Web repair is a bounded exception: task action is already
# canonical/trusted, battery-only definition drift is proven, lifecycle is already
# stopped, repair converges, broker lock is HELD, then lifecycle becomes READY.
$batteryEligibleIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_REPAIR=ELIGIBLE', [System.StringComparison]::Ordinal)
$batteryStoppedProofIndex = $text.IndexOf('Assert-LifecycleExecutorsStopped -Stage "BATTERY_PRE_WEB_REPAIR"', [System.StringComparison]::Ordinal)
$batteryTaskRepairPassIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_TASK_REPAIR=PASS', [System.StringComparison]::Ordinal)
$batteryLockHeldIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_STARTUP_RUNNER_LOCK=HELD', [System.StringComparison]::Ordinal)
$batteryReadyIndex = $text.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_LIFECYCLE_READY=PASS', [System.StringComparison]::Ordinal)
Assert-True ($batteryEligibleIndex -ge 0) "battery pre-Web repair must have an explicit eligibility audit marker"
Assert-True ($batteryStoppedProofIndex -gt $batteryEligibleIndex) "battery pre-Web repair must prove executors stopped after eligibility"
Assert-True ($batteryTaskRepairPassIndex -gt $batteryStoppedProofIndex) "battery task repair must occur only after stopped-lifecycle proof"
Assert-True ($batteryLockHeldIndex -gt $batteryTaskRepairPassIndex) "battery repair must prove startup lock HELD after task repair"
Assert-True ($batteryReadyIndex -gt $batteryLockHeldIndex) "battery pre-Web lifecycle READY must be proven after lock HELD"
Assert-True ($batteryReadyIndex -lt $deployIndex) "battery-stranded recovery must restore strict runtime before Web/API deploy"
if ($startMatches.Count -gt 1) {
  $batteryStartIndex = $startMatches[0].Index
  Assert-True ($batteryStartIndex -gt $batteryTaskRepairPassIndex) "battery lifecycle START must occur only after battery task repair"
  Assert-True ($batteryStartIndex -lt $deployIndex) "battery pre-Web START must remain before strict Web/API deploy"
}

# PR #238 provenance enforcement must be reconciled by this deploy helper.
Assert-True ($text.Contains('lib\phase7c-scheduled-task-ownership.ps1')) "helper must load the canonical Scheduled Task ownership library"
Assert-True ($text.Contains('register-phase7c-executor-task-local.ps1')) "helper must reuse the canonical Scheduled Task installer for repair"
Assert-True ($text.Contains('Get-Phase7CTrustedGitFileSha256')) "helper must derive the trusted runner hash from accepted Git bytes"
Assert-True ($text.Contains('Test-Phase7CExecutorTaskActionOwnership')) "helper must inspect task action ownership before mutation"
Assert-True ($text.Contains('ExpectedRunnerSha256')) "helper must verify the task action against the expected runner SHA256"
Assert-True ($text.Contains('TASK_PROVENANCE=CANONICAL_HASH_GUARD')) "helper must report canonical hash-guard provenance"
Assert-True ($text.Contains('TASK_PROVENANCE_REPAIR=SKIPPED_ALREADY_CANONICAL')) "helper must skip task definition repair when provenance is already canonical and definition is drift-free"
Assert-True ($text.Contains('TASK_PROVENANCE_REPAIR=PERFORMED')) "helper must report successful owned task provenance repair"
Assert-True ($text.Contains('TASK_PROVENANCE_REPAIR=BLOCKED_UNPROVEN_OWNERSHIP')) "helper must fail closed for foreign or unproven task ownership"
Assert-True ($text.Contains('Stop-ScheduledTask')) "helper must explicitly stop the owned SYSTEM task before repair/reload"
Assert-True ($text.Contains('-Repair')) "helper must invoke the canonical installer in repair mode when repair is required"
$taskStopMatches = [regex]::Matches($text, [regex]::Escape('Stop-ScheduledTask'))
$taskRepairMatches = [regex]::Matches($text, '(?m)^\s*-Repair\s+`?\s*$')
Assert-True ($taskStopMatches.Count -ge 1) "helper must contain Scheduled Task stop"
Assert-True ($taskRepairMatches.Count -ge 1) "helper must contain canonical task repair invocation"
$normalTaskRepairIndex = $taskRepairMatches[$taskRepairMatches.Count - 1].Index
$normalTaskStopCandidates = @($taskStopMatches | Where-Object { $_.Index -lt $normalTaskRepairIndex })
Assert-True ($normalTaskStopCandidates.Count -ge 1) "ordinary task repair must have a preceding Scheduled Task stop"
$normalTaskStopIndex = $normalTaskStopCandidates[$normalTaskStopCandidates.Count - 1].Index
Assert-True ($normalTaskStopIndex -gt $stopIndex) "ordinary Scheduled Task stop must occur only after lifecycle STOP"
Assert-True ($normalTaskRepairIndex -gt $normalTaskStopIndex) "ordinary task repair must occur only after the owned SYSTEM task is stopped"
Assert-True ($normalStartIndex -gt $normalTaskRepairIndex) "ordinary lifecycle START must occur only after task repair when repair is needed"

# Runtime teardown must include partial executors and the previous broker process, not only Task Scheduler state.
Assert-True ($text.Contains('Test-Phase7CLifecycleHasAliveProcess')) "helper must detect partial executor runtimes"
Assert-True ($text.Contains('$currentLifecycleNeedsStop = [bool]$currentLifecycle.running -or (Test-Phase7CLifecycleHasAliveProcess -State $currentLifecycle)')) "helper must STOP when any executor process remains alive"
Assert-True ($text.Contains('if (-not [bool]$state.running -and -not (Test-Phase7CLifecycleHasAliveProcess -State $state)) { return }')) "lifecycle stop wait must require every executor process dead"
Assert-True ($text.Contains('Get-Phase7CBrokerPidFromHeartbeat')) "helper must capture the previous broker PID before stopping the task"
$ordinaryBrokerStopMarker = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BROKER_PROCESS_STOP=PASS'
Assert-True ($text.Contains($ordinaryBrokerStopMarker)) "helper must prove the previous broker process exited before repair"
$brokerProcessStopIndex = $text.IndexOf($ordinaryBrokerStopMarker, [System.StringComparison]::Ordinal)
Assert-True ($brokerProcessStopIndex -gt $normalTaskStopIndex) "broker process exit proof must occur after ordinary Scheduled Task stop"
Assert-True ($normalTaskRepairIndex -gt $brokerProcessStopIndex) "ordinary task repair must occur only after the previous broker process is dead"

# Repair prerequisites must be proven before any runtime mutation to avoid preventable fail-closed downtime.
Assert-True ($text.Contains('api-user-sid.txt')) "helper must use the canonical recorded API user SID"
Assert-True ($text.Contains('Get-Phase7CRecordedApiUserSid')) "helper must validate the recorded API SID before repair"
Assert-True ($text.Contains('-ApiUserSid $apiUserSid')) "helper must pass the validated API SID explicitly to the canonical installer"
$apiSidResolveIndex = $text.IndexOf('$apiUserSid = Get-Phase7CRecordedApiUserSid', [System.StringComparison]::Ordinal)
$mutationGateIndex = $text.IndexOf('$mutationStarted = $false', [System.StringComparison]::Ordinal)
Assert-True ($apiSidResolveIndex -ge 0) "helper must resolve the API SID before mutation"
Assert-True ($mutationGateIndex -gt $apiSidResolveIndex) "API SID validation must occur before the recovery mutation gate"

# Bridge identity and broker-flat invariants must hold throughout.
Assert-True ($text.Contains('bridge session changed')) "helper must fail if Bridge session changes"
Assert-True ($text.Contains('BRIDGE_SESSION_UNCHANGED=PASS')) "helper must report unchanged Bridge session"
Assert-True ($text.Contains('BRIDGE_RESTART=NONE')) "helper must explicitly forbid Bridge restart"
Assert-True ($text.Contains('WEB_API_DEPLOY=PASS')) "helper must report Web/API deployment"
Assert-True ($text.Contains('ORDER_MUTATION=NONE')) "helper must explicitly forbid order mutation"
Assert-True ($text.Contains('LIVE_TEST_ORDER=NONE')) "helper must explicitly forbid LIVE test orders"

# Normal success must remain PAUSE + DISARMED. Never ARM and never AUTO.
Assert-True ($text.Contains('FINAL_MODE=PAUSE')) "helper must finish in PAUSE"
Assert-True ($text.Contains('FINAL_ARM=DISARMED')) "helper must finish DISARMED"
Assert-True (-not $text.Contains('Invoke-LiveArmAction "ARM_LIVE"')) "helper must never invoke ARM_LIVE"
Assert-True (-not $text.Contains('confirmation = "ARM_LIVE"')) "helper must never execute canonical ARM_LIVE"
Assert-True (-not $text.Contains('@{ mode = "AUTO"')) "helper must never set AUTO"
Assert-True (-not $text.Contains('activate-phase7c-local.ps1')) "helper must never invoke legacy activation"
Assert-True (-not $text.Contains('activate-phase7c-safe-local.ps1')) "helper must never invoke broad safe activation"

# Failure after mutation must preserve/restore fail-closed PAUSE + DISARMED best effort.
Assert-True ($text.Contains('runtime-ready-stable-recovery-fail-closed')) "catch path must persist PAUSE"
Assert-True ($text.Contains('DISARM_LIVE')) "catch path may only use canonical DISARM as a safety action"
Assert-True ($text.Contains('FAIL_CLOSED_MODE=PAUSE')) "catch path must report PAUSE"
Assert-True ($text.Contains('FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT')) "catch path must report DISARMED best effort"

Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_DEPLOY_SOURCE_TEST=PASS"
