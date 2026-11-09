$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$GuardedPath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-guarded-local.ps1"
$CorePath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
foreach ($requiredPath in @($GuardedPath, $CorePath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required recovery source not found: $requiredPath"
  }
}

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

foreach ($path in @($GuardedPath, $CorePath)) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${path}: $($errors[0].Message)"
  }
}

$guarded = (Get-Content -LiteralPath $GuardedPath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$core = (Get-Content -LiteralPath $CorePath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

# Production reproduction 2026-09-14: target source generation can be stale while
# lifecycle remains RUNNING+READY and the canonical singleton startup lock is HELD.
# A prior definition-only runner hash repair can make BOTH the current registered task
# action token and runner hash newer than the already-running stale broker instance.
# Therefore the guarded entrypoint must bind the running task instance to broker PID via
# Task Scheduler IRunningTask.EnginePID, while proving CURRENT registered task trust and
# stale broker generation attestation separately.
$guardRequired = @(
  '$generationDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision',
  '$reloadRequired = [bool]$generationDecision.reloadRequired',
  '$heldObserved',
  '$reloadRequired -and',
  '[bool]$lifecycle.running',
  '[bool]$lifecycle.ready',
  '[string]$runtimeGeneration.startupRunnerLockState -eq ''HELD''',
  'function Get-Phase7CRunningTaskInstanceProcessIds',
  '$instance.EnginePID',
  '$heldEligible',
  '$runningTaskInstancePids = @(Get-Phase7CRunningTaskInstanceProcessIds -Name $TaskName)',
  '$runningTaskInstancePids.Count -eq 1',
  '[int]$runningTaskInstancePids[0] -eq [int]$runtimeGeneration.statusBrokerPid',
  '[string]$brokerAttestation.component -eq ''lifecycle-broker''',
  '[int]$brokerAttestation.pid -eq [int]$runtimeGeneration.statusBrokerPid',
  '$brokerAttestationVersionValid',
  '$brokerAttestationGenerationValid',
  '$brokerAttestationIsStale',
  '[string]$brokerAttestation.deploymentId -match ''^[0-9a-fA-F]{32}$''',
  '[string]$brokerAttestation.sourceCommit -match ''^[0-9a-fA-F]{40}$''',
  '[string]$brokerAttestation.sourceTree -match ''^[0-9a-fA-F]{40}$''',
  '[string]$brokerAttestation.launcherSha256 -match ''^sha256:[0-9a-fA-F]{64}$''',
  'Assert-PauseDisarmed',
  'Assert-BridgeAndFlat -ExpectedSession $bridgeSessionId',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_HELD_LOCK=ELIGIBLE_QUIESCE_REQUIRED',
  '[void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})',
  'Wait-LifecycleStopped',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_HELD_LOCK_LIFECYCLE_STOP=PASS',
  '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CoreRecovery',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GUARDED_ENTRY=PASS'
)
foreach ($literal in $guardRequired) {
  Assert-True ($guarded.Contains($literal)) "RED: RUNNING+READY held-lock guarded recovery contract missing: $literal"
}
Assert-True (-not $guarded.Contains('$attestedLauncherSha256 -eq $expectedLauncherSha256')) 'RED: stale running broker must not be required to carry the CURRENT repaired task runner hash.'
Assert-True (-not $guarded.Contains('$canonicalProcessIds = @(Get-Phase7CCanonicalTaskProcessIds -Task $task)')) 'RED: stale running task instance must not be identified from the CURRENT repaired task action token.'

$eligible = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_HELD_LOCK=ELIGIBLE_QUIESCE_REQUIRED'
$stopApi = '[void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})'
$waitStopped = 'Wait-LifecycleStopped'
$stopped = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_HELD_LOCK_LIFECYCLE_STOP=PASS'
$coreInvoke = '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CoreRecovery'

$eligibleIndex = $guarded.IndexOf($eligible, [System.StringComparison]::Ordinal)
$stopIndex = $guarded.IndexOf($stopApi, $eligibleIndex, [System.StringComparison]::Ordinal)
$waitIndex = $guarded.IndexOf($waitStopped, $stopIndex, [System.StringComparison]::Ordinal)
$stoppedIndex = $guarded.IndexOf($stopped, [System.StringComparison]::Ordinal)
$coreInvokeIndex = $guarded.IndexOf($coreInvoke, [System.StringComparison]::Ordinal)

Assert-True ($eligibleIndex -ge 0) 'Held-lock guarded recovery must expose exact quiesce eligibility.'
Assert-True ($stopIndex -gt $eligibleIndex) 'Canonical lifecycle STOP must occur only after held-lock eligibility proof.'
Assert-True ($waitIndex -gt $stopIndex) 'Guarded recovery must wait for lifecycle STOP after requesting it.'
Assert-True ($stoppedIndex -gt $waitIndex) 'Held-lock lifecycle STOP audit marker must occur only after stop convergence.'
Assert-True ($coreInvokeIndex -gt $stoppedIndex) 'Canonical recovery core must run only after held-lock lifecycle quiesce completes.'

$heldSection = $guarded.Substring($eligibleIndex, $coreInvokeIndex - $eligibleIndex)
Assert-True (-not $heldSection.Contains('Stop-Process')) 'Held-lock guard must never kill a process directly.'
Assert-True (-not $heldSection.Contains('Stop-ScheduledTask')) 'Held-lock guard must leave Scheduled Task recycling to canonical recovery core.'
Assert-True (-not $heldSection.Contains('Remove-Item')) 'Held-lock guard must never mutate the singleton lock by hand.'
Assert-True (-not $heldSection.Contains('Start-ScheduledTask')) 'Held-lock guard must not start/restart the task directly.'

# Reuse, do not duplicate, the existing stopped-lifecycle generation path. This core
# already proves old broker exit, fresh PID, exact target attestation, HELD lock and
# stable READY before strict Web/API deployment.
$coreRequired = @(
  '$preWebLifecycleStopped',
  '[string]$preWebRuntimeGeneration.startupRunnerLockState -eq ''HELD''',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB=ELIGIBLE',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_STOP=PASS',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_BROKER_PROCESS_STOP=PASS',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_RESTART=PASS',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_STARTUP_RUNNER_LOCK=HELD',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_LIFECYCLE_READY=PASS',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=SATISFIED_PRE_WEB',
  '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy'
)
foreach ($literal in $coreRequired) {
  Assert-True ($core.Contains($literal)) "Canonical recovery core lost required stopped-generation contract: $literal"
}

$coreEligibleIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB=ELIGIBLE', [System.StringComparison]::Ordinal)
$coreTaskStopIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_STOP=PASS', [System.StringComparison]::Ordinal)
$coreBrokerStopIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_BROKER_PROCESS_STOP=PASS', [System.StringComparison]::Ordinal)
$coreTaskRestartIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_RESTART=PASS', [System.StringComparison]::Ordinal)
$coreLockIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_STARTUP_RUNNER_LOCK=HELD', [System.StringComparison]::Ordinal)
$coreReadyIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_LIFECYCLE_READY=PASS', [System.StringComparison]::Ordinal)
$coreReloadSatisfiedIndex = $core.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=SATISFIED_PRE_WEB', [System.StringComparison]::Ordinal)
$coreWebIndex = $core.IndexOf('& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy', [System.StringComparison]::Ordinal)
Assert-True ($coreTaskStopIndex -gt $coreEligibleIndex) 'Core task stop must occur after stopped-generation eligibility.'
Assert-True ($coreBrokerStopIndex -gt $coreTaskStopIndex) 'Core must prove old broker exit after task stop.'
Assert-True ($coreTaskRestartIndex -gt $coreBrokerStopIndex) 'Core task restart must occur only after old broker exit.'
Assert-True ($coreLockIndex -gt $coreTaskRestartIndex) 'Core must prove HELD lock after fresh task restart.'
Assert-True ($coreReadyIndex -gt $coreLockIndex) 'Core must restore stable READY after fresh HELD lock proof.'
Assert-True ($coreReloadSatisfiedIndex -gt $coreReadyIndex) 'Core may satisfy reload only after stable READY.'
Assert-True ($coreWebIndex -gt $coreReloadSatisfiedIndex) 'Strict Web/API deploy must remain after fresh generation proof.'

Write-Host "PHASE7C_RUNNING_HELD_LOCK_PREWEB_GENERATION_SOURCE_TEST=PASS"
