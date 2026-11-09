$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Verifier = Join-Path $PSScriptRoot 'verify-phase7c-account-runtime-local.ps1'
if (-not (Test-Path -LiteralPath $Verifier)) { throw "Verifier source missing: $Verifier" }

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Verifier, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "Verifier parse failed: $($errors -join '; ')" }

$source = Get-Content -LiteralPath $Verifier -Raw
$violations = New-Object System.Collections.Generic.List[string]

function Require([string]$Pattern, [string]$Code) {
  if ($source -notmatch $Pattern) { $violations.Add($Code) }
}
function Forbid([string]$Pattern, [string]$Code) {
  if ($source -match $Pattern) { $violations.Add($Code) }
}

# Legacy startup-runner status is no longer canonical after the Scheduled Task
# became the persistent SYSTEM lifecycle broker.
Forbid 'startup-runner-status\.json' 'LEGACY_STARTUP_RUNNER_STATUS_PATH_FORBIDDEN'
Forbid 'SUPERVISOR_RUNNING' 'LEGACY_SUPERVISOR_RUNNING_STATUS_FORBIDDEN'

# Canonical verifier identity/state must come specifically from lifecycle broker state.
Require '\$LifecycleBrokerRoot\s*=\s*Join-Path\s+\$WorkDir\s+"phase7c-lifecycle-broker"' 'LIFECYCLE_BROKER_ROOT_MISSING'
Require '\$BrokerHeartbeatPath\s*=\s*Join-Path\s+\$LifecycleBrokerStateDir\s+"heartbeat\.json"' 'LIFECYCLE_BROKER_HEARTBEAT_MISSING'
Require '\$BrokerStatusPath\s*=\s*Join-Path\s+\$LifecycleBrokerStateDir\s+"status\.json"' 'LIFECYCLE_BROKER_STATUS_MISSING'
Require '\$brokerHeartbeat\s*=\s*Get-Content\s+-LiteralPath\s+\$BrokerHeartbeatPath' 'BROKER_HEARTBEAT_READ_MISSING'
Require '\$brokerStatus\s*=\s*Get-Content\s+-LiteralPath\s+\$BrokerStatusPath' 'BROKER_STATUS_READ_MISSING'
Require 'brokerPid' 'BROKER_PID_CHECK_MISSING'
Require 'desiredExecutorState' 'DESIRED_EXECUTOR_STATE_CHECK_MISSING'
Require 'supervisorPid' 'BROKER_SUPERVISOR_PID_CHECK_MISSING'
Require 'RUNNING' 'BROKER_RUNNING_STATE_CHECK_MISSING'
Require 'updatedAt' 'BROKER_FRESHNESS_CHECK_MISSING'

# Preserve the existing fail-closed topology proof: task-owned broker keeps the
# singleton lock, is directly owned by Task Scheduler, and owns the supervisor.
Require 'startup-runner\.lock' 'BROKER_SINGLETON_LOCK_CHECK_MISSING'
Require 'Win32_Service' 'TASK_SCHEDULER_SERVICE_CHECK_MISSING'
Require "Name = 'Schedule'" 'TASK_SCHEDULER_IDENTITY_CHECK_MISSING'
Require 'ParentProcessId' 'PROCESS_PARENT_TOPOLOGY_CHECK_MISSING'

if ($violations.Count -gt 0) {
  Write-Host 'PHASE7C_ACCOUNT_RUNTIME_SYSTEM_BROKER_VERIFIER_CONTRACT=FAIL'
  foreach ($violation in $violations) { Write-Host "VIOLATION=$violation" }
  throw ('Phase7C account runtime verifier still targets legacy startup-runner status: ' + ($violations -join '; '))
}

Write-Host 'PHASE7C_ACCOUNT_RUNTIME_SYSTEM_BROKER_VERIFIER_CONTRACT=PASS'
Write-Host 'LEGACY_STARTUP_RUNNER_STATUS=ABSENT'
Write-Host 'SYSTEM_BROKER_HEARTBEAT_STATUS=CANONICAL'
Write-Host 'SYSTEM_BROKER_TOPOLOGY_PROOF=PRESERVED'
