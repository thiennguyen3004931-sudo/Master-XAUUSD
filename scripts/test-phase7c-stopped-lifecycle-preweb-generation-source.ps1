$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RecoveryPath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$DashboardPath = Join-Path $PSScriptRoot "deploy-phase7c-mt5-dashboard-local.ps1"

foreach ($required in @($RecoveryPath, $DashboardPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required stopped-lifecycle pre-Web generation source not found: $required"
  }
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

Assert-PowerShellSyntax $RecoveryPath
Assert-PowerShellSyntax $DashboardPath
$recovery = (Get-Content -LiteralPath $RecoveryPath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$dashboard = (Get-Content -LiteralPath $DashboardPath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

# Production reproduction: dashboard deploy is intentionally strict and requires
# live executor PID files before it will stop/restart the Web/API task. Therefore a
# canonical recovery that begins with lifecycle STOPPED + zero executors cannot call
# Web/API deploy first; it must restore a fresh attested SYSTEM generation and READY
# lifecycle before entering the unchanged strict dashboard path.
Assert-True ($dashboard.Contains('$supervisorPid = Read-AlivePid "supervisor"')) `
  'Dashboard deploy must retain strict live supervisor PID protection.'
Assert-True ($dashboard.Contains('$trendPid = Read-AlivePid "trend"')) `
  'Dashboard deploy must retain strict live trend PID protection.'
Assert-True ($dashboard.Contains('$sidewayPid = Read-AlivePid "sideway"')) `
  'Dashboard deploy must retain strict live sideway PID protection.'
Assert-True ($dashboard.Contains('-RequireTelegram')) `
  'Dashboard deploy must retain strict Telegram verification.'

$eligible = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB=ELIGIBLE'
$stoppedProof = 'Assert-LifecycleExecutorsStopped -Stage "GENERATION_PRE_WEB"'
$taskStop = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_STOP=PASS'
$brokerStop = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_BROKER_PROCESS_STOP=PASS'
$taskRestart = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_RESTART=PASS'
$lockHeld = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_STARTUP_RUNNER_LOCK=HELD'
$ready = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_LIFECYCLE_READY=PASS'
$reloadSatisfied = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=SATISFIED_PRE_WEB'
$webDeploy = '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy'

foreach ($literal in @($eligible, $stoppedProof, $taskStop, $brokerStop, $taskRestart, $lockHeld, $ready, $reloadSatisfied)) {
  Assert-True ($recovery.Contains($literal)) "RED: stopped-lifecycle generation recovery contract missing: $literal"
}

$eligibleIndex = $recovery.IndexOf($eligible, [System.StringComparison]::Ordinal)
$stoppedIndex = $recovery.IndexOf($stoppedProof, [System.StringComparison]::Ordinal)
$taskStopIndex = $recovery.IndexOf($taskStop, [System.StringComparison]::Ordinal)
$brokerStopIndex = $recovery.IndexOf($brokerStop, [System.StringComparison]::Ordinal)
$taskRestartIndex = $recovery.IndexOf($taskRestart, [System.StringComparison]::Ordinal)
$lockIndex = $recovery.IndexOf($lockHeld, [System.StringComparison]::Ordinal)
$readyIndex = $recovery.IndexOf($ready, [System.StringComparison]::Ordinal)
$reloadSatisfiedIndex = $recovery.IndexOf($reloadSatisfied, [System.StringComparison]::Ordinal)
$webDeployIndex = $recovery.IndexOf($webDeploy, [System.StringComparison]::Ordinal)

Assert-True ($eligibleIndex -ge 0) 'Stopped-lifecycle pre-Web generation path must have an explicit eligibility marker.'
Assert-True ($stoppedIndex -gt $eligibleIndex) 'Pre-Web generation recovery must prove all executors stopped after eligibility.'
Assert-True ($taskStopIndex -gt $stoppedIndex) 'Canonical task stop must occur only after stopped-executor proof.'
Assert-True ($brokerStopIndex -gt $taskStopIndex) 'Task restart must wait for previous broker exit proof.'
Assert-True ($taskRestartIndex -gt $brokerStopIndex) 'Canonical task restart must occur only after previous broker exits.'
Assert-True ($lockIndex -gt $taskRestartIndex) 'New generation must prove startup lock HELD after task restart.'
Assert-True ($readyIndex -gt $lockIndex) 'Lifecycle must become stably READY only after new generation lock proof.'
Assert-True ($reloadSatisfiedIndex -gt $readyIndex) 'Generation requirement must be marked satisfied only after stable READY.'
Assert-True ($webDeployIndex -gt $reloadSatisfiedIndex) 'Strict Web/API dashboard deploy must occur only after stopped-lifecycle generation recovery is complete.'

Assert-True ($recovery.Contains('Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB"')) `
  'Pre-Web generation recovery must remain PAUSE + DISARMED.'
Assert-True ($recovery.Contains('Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB"')) `
  'Pre-Web generation recovery must preserve Bridge session identity.'
Assert-True ($recovery.Contains('Assert-FlatBroker -Stage "GENERATION_PRE_WEB"')) `
  'Pre-Web generation recovery must require XAUUSD flatness.'
Assert-True ($recovery.Contains('Canonical pre-Web source generation reload requires the Scheduled Task to remain exact canonical.')) `
  'Pre-Web generation recovery must fail closed unless task definition remains canonical.'
Assert-True ($recovery.Contains('Canonical pre-Web source generation reload requires SYSTEM + ServiceAccount + Highest.')) `
  'Pre-Web generation recovery must preserve SYSTEM principal proof.'
Assert-True (-not $recovery.Contains('GENERATION_PRE_WEB_TASK_REPAIR')) `
  'Stopped-lifecycle canonical generation recovery must not repair task definition.'

# Production reproduction 2026-09-05: the first canonical Start-ScheduledTask
# returned without error, but Windows held the task in Queued with zero COM task
# instances, zero canonical PowerShell processes, a RELEASED startup lock, a dead
# previous broker PID, and stale heartbeat/status. Battery, idle, network and task
# enabled settings were all canonical. A bounded recovery may clear that orphan queue
# only after re-proving the exact fail-closed shape, then retry the same task once.
$orphanRequired = @(
  'function Get-Phase7CCanonicalTaskProcessCount',
  'function Get-Phase7CRunningTaskInstanceCount',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED=ELIGIBLE',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED_CLEAR=PASS',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED_RESTART_RETRY=ONCE',
  '[string]$orphanQueuedTask.State -eq ''Queued''',
  '$orphanCanonicalProcessCount -eq 0',
  '$orphanRunningInstanceCount -eq 0',
  '-not [bool]$orphanRuntimeGeneration.brokerProcessAlive',
  '-not [bool]$orphanRuntimeGeneration.brokerHeartbeatFresh',
  '[string]$orphanRuntimeGeneration.startupRunnerLockState -in @(''MISSING'', ''RELEASED'')',
  'Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED"',
  'Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED"',
  'Assert-FlatBroker -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED"'
)
foreach ($literal in $orphanRequired) {
  Assert-True ($recovery.Contains($literal)) "RED: orphan-queued generation recovery contract missing: $literal"
}

$orphanEligible = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED=ELIGIBLE'
$orphanClear = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED_CLEAR=PASS'
$orphanRetry = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED_RESTART_RETRY=ONCE'
$restartFailure = 'Canonical pre-Web source generation task restart did not produce a fresh new lifecycle broker.'
$orphanEligibleIndex = $recovery.IndexOf($orphanEligible, [System.StringComparison]::Ordinal)
$orphanClearIndex = $recovery.IndexOf($orphanClear, [System.StringComparison]::Ordinal)
$orphanRetryIndex = $recovery.IndexOf($orphanRetry, [System.StringComparison]::Ordinal)
$restartFailureIndex = $recovery.IndexOf($restartFailure, [System.StringComparison]::Ordinal)

Assert-True ($orphanEligibleIndex -ge 0) 'Orphan queue recovery must expose exact eligibility.'
Assert-True ($orphanClearIndex -gt $orphanEligibleIndex) 'Orphan queue clear must occur after eligibility.'
Assert-True ($orphanRetryIndex -gt $orphanClearIndex) 'Single retry must occur after queue clear proof.'
Assert-True ($restartFailureIndex -gt $orphanRetryIndex) 'Fail-closed broker restart error must remain after the bounded retry.'

$orphanSection = $recovery.Substring($orphanEligibleIndex, $restartFailureIndex - $orphanEligibleIndex)
Assert-True ($orphanSection.Contains('Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop')) `
  'Orphan queue recovery must cancel only the same canonical Scheduled Task.'
Assert-True ($orphanSection.Contains('Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop')) `
  'Orphan queue recovery must retry only the same canonical Scheduled Task.'
Assert-True (-not $orphanSection.Contains('Register-ScheduledTask')) `
  'Orphan queue recovery must not re-register task definition.'
Assert-True (-not $orphanSection.Contains('Restart-Service')) `
  'Orphan queue recovery must never restart Task Scheduler service.'

# Production reproduction 2026-09-07: after an exact HEALTHY source transition,
# lifecycle STOP succeeded while the canonical SYSTEM broker remained alive/fresh
# and PID-matched, but the startup-runner lock was RELEASED. This must NOT be treated
# as healthy. A bounded repair is allowed only when one canonical task process and one
# Scheduler instance both bind the broker PID, the broker launcher SHA matches the
# trusted Git runner, and the ordinary PAUSE/DISARMED/Bridge/flat guards remain true.
$releasedLockRequired = @(
  'function Get-Phase7CCanonicalTaskProcessIds',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RELEASED_LOCK=ELIGIBLE_REPAIR_REQUIRED',
  '$preWebCanonicalProcessIds.Count -eq 1',
  '$preWebRunningInstanceCount -eq 1',
  '[int]$preWebCanonicalProcessIds[0] -eq [int]$preWebRuntimeGeneration.statusBrokerPid',
  '[string]$preWebRuntimeGeneration.startupRunnerLockState -in @(''MISSING'', ''RELEASED'')',
  '$preWebExpectedLauncherSha256 = ''sha256:'' + $trustedRunnerSha256.ToLowerInvariant()',
  '[string]$preWebBrokerAttestation.component -eq ''lifecycle-broker''',
  '[int]$preWebBrokerAttestation.pid -eq [int]$preWebRuntimeGeneration.statusBrokerPid',
  '$preWebAttestedLauncherSha256 -eq $preWebExpectedLauncherSha256',
  'Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"',
  'Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"',
  'Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"'
)
foreach ($literal in $releasedLockRequired) {
  Assert-True ($recovery.Contains($literal)) "RED: released-lock stopped-lifecycle recovery contract missing: $literal"
}
Assert-True (-not $recovery.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RELEASED_LOCK=HEALTHY')) `
  'Released startup lock must never be normalized to healthy generation state.'

# Production reproduction 2026-09-09: generation reload can be required while the
# lifecycle is still RUNNING+READY and the exact canonical SYSTEM broker/task tuple is
# alive/fresh/PID-matched but the startup-runner singleton lock is RELEASED or MISSING.
# The recovery must quiesce the lifecycle first, prove executors stopped, then enter
# the existing stopped-lifecycle released-lock repair. It must never weaken the lock
# verifier, kill a process directly, or mutate the singleton lock by hand.
$runningReleasedRequired = @(
  '$preWebRunningReleasedLockCandidate',
  '$preWebRunningReleasedLockRepairEligible',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK=ELIGIBLE_QUIESCE_REQUIRED',
  '$preWebRunningCanonicalProcessIds.Count -eq 1',
  '$preWebRunningInstanceCount -eq 1',
  '[int]$preWebRunningCanonicalProcessIds[0] -eq [int]$preWebRuntimeGeneration.statusBrokerPid',
  '[string]$preWebRuntimeGeneration.startupRunnerLockState -in @(''MISSING'', ''RELEASED'')',
  'Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"',
  'Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"',
  'Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"',
  '[void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})',
  'Wait-LifecycleStopped',
  'Assert-LifecycleExecutorsStopped -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"',
  'Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"',
  'Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"',
  'Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"',
  'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_LIFECYCLE_STOP=PASS'
)
foreach ($literal in $runningReleasedRequired) {
  Assert-True ($recovery.Contains($literal)) "RED: running+ready released-lock quiesce contract missing: $literal"
}

$runningReleasedEligible = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK=ELIGIBLE_QUIESCE_REQUIRED'
$runningReleasedStopped = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_LIFECYCLE_STOP=PASS'
$stoppedReleasedEligible = 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RELEASED_LOCK=ELIGIBLE_REPAIR_REQUIRED'
$runningReleasedEligibleIndex = $recovery.IndexOf($runningReleasedEligible, [System.StringComparison]::Ordinal)
$runningReleasedStoppedIndex = $recovery.IndexOf($runningReleasedStopped, [System.StringComparison]::Ordinal)
$stoppedReleasedEligibleIndex = $recovery.IndexOf($stoppedReleasedEligible, [System.StringComparison]::Ordinal)

Assert-True ($runningReleasedEligibleIndex -ge 0) 'RUNNING+READY released-lock recovery must expose exact quiesce eligibility.'
Assert-True ($runningReleasedStoppedIndex -gt $runningReleasedEligibleIndex) 'Lifecycle STOP proof must occur after RUNNING+READY released-lock eligibility.'
Assert-True ($stoppedReleasedEligibleIndex -gt $runningReleasedStoppedIndex) 'Existing stopped-lifecycle released-lock repair must be entered only after lifecycle STOP is proven.'

$runningReleasedSection = $recovery.Substring($runningReleasedEligibleIndex, $stoppedReleasedEligibleIndex - $runningReleasedEligibleIndex)
Assert-True (-not $runningReleasedSection.Contains('Stop-Process')) `
  'RUNNING+READY released-lock recovery must never kill a process directly.'
Assert-True (-not $runningReleasedSection.Contains('Remove-Item')) `
  'RUNNING+READY released-lock recovery must never delete the singleton lock manually.'
Assert-True (-not $runningReleasedSection.Contains('Set-Content')) `
  'RUNNING+READY released-lock recovery must never rewrite the singleton lock manually.'
Assert-True (-not $recovery.Contains('GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK=HEALTHY')) `
  'RUNNING+READY RELEASED/MISSING startup lock must never be normalized to healthy.'

Write-Host "PHASE7C_STOPPED_LIFECYCLE_PREWEB_GENERATION_SOURCE_TEST=PASS"
