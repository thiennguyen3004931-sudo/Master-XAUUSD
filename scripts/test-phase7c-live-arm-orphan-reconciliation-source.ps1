$ErrorActionPreference = "Stop"
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$ServicePath = Join-Path $ProjectRoot "apps\api\src\services\phase7c-live-arm-control.service.ts"
$RunnerPath = Join-Path $ProjectRoot "scripts\run-phase7c-live-arm-control-task-runner-local.ps1"
$RepairPath = Join-Path $ProjectRoot "scripts\reconcile-phase7c-live-arm-control-orphan-local.ps1"

foreach ($required in @($ServicePath, $RunnerPath, $RepairPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing LIVE ARM orphan reconciliation source: $required"
  }
}

$service = Get-Content -LiteralPath $ServicePath -Raw
$runner = Get-Content -LiteralPath $RunnerPath -Raw
$repair = Get-Content -LiteralPath $RepairPath -Raw

[void][scriptblock]::Create($runner)
[void][scriptblock]::Create($repair)

function Assert-Literal([string]$Source, [string]$Text, [string]$Label) {
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing LIVE ARM orphan reconciliation literal: $Label"
  }
}
function Assert-Contains([string]$Source, [string]$Pattern, [string]$Label) {
  if ($Source -notmatch $Pattern) {
    throw "Missing LIVE ARM orphan reconciliation marker: $Label"
  }
}
function Assert-NotContains([string]$Source, [string]$Pattern, [string]$Label) {
  if ($Source -match $Pattern) {
    throw "Forbidden LIVE ARM orphan reconciliation pattern: $Label"
  }
}

# API capability must fail closed whenever a durable request file still exists,
# regardless of whether a RUNNING status has aged past the UI stale threshold.
Assert-Literal $service 'const requestExists = fs.existsSync(requestPath());' 'durable request existence is explicit control state'
Assert-Literal $service 'noControlRunning = !requestExists &&' 'request file blocks capability even when status is stale'
Assert-Literal $service 'orphanedControlRequest: requestExists &&' 'capability exposes orphaned request observability'
Assert-Literal $service 'canArm: arm.approved' 'existing capability shape remains canonical'
Assert-Literal $service 'canDisarm: disarm.approved' 'existing capability shape remains canonical'
Assert-NotContains $service 'Date.now() - status.updatedAt > REQUEST_RUNNING_STALE_MS;' 'stale RUNNING status alone must not unblock durable request'

# Nested elevated child PowerShell calls must have a timeout below the task's 5m
# execution limit, so a hanging child reaches runner catch/finally first.
Assert-Literal $runner 'function Invoke-BoundedPowerShellChild' 'bounded child execution helper'
Assert-Literal $runner '$ChildTimeoutMs = 30000' '30 second child timeout'
Assert-Literal $runner '.WaitForExit($ChildTimeoutMs)' 'bounded child wait'
Assert-Literal $runner 'Stop-Process -Id $process.Id -Force' 'timed-out child termination'
Assert-Literal $runner 'CHILD_TIMEOUT' 'explicit child timeout failure phase/message'
Assert-Literal $runner 'Remove-Item -LiteralPath $RequestPath -Force' 'request cleanup remains in runner finally'

# One-time orphan reconciliation is intentionally separate from GET capability.
# It may mutate only the stale control request/status after proving fail-closed state.
Assert-Literal $repair '[Parameter(Mandatory = $true)] [string]$ExpectedCommit' 'repair exact source pin'
Assert-Literal $repair '[Parameter(Mandatory = $true)] [string]$ExpectedRequestId' 'repair exact request pin'
Assert-Literal $repair 'RECONCILED_AFTER_TERMINATED_WORKER' 'explicit reconciliation phase'
Assert-Literal $repair 'ExpectedAction = "DISARM_LIVE"' 'repair scope fixed to current DISARM orphan class'
Assert-Literal $repair 'REQUEST_STALE_MIN_MS = 600000' 'orphan must be stale for at least 10 minutes'
Assert-Literal $repair 'LIVE_ARM_RUNNER_PROVENANCE=PASS|BLOB=' 'repair proves current runner blob before mutation'
Assert-Literal $repair 'TASK_RUNNING_INSTANCE_COUNT=0' 'repair proves no task instance'
Assert-Literal $repair 'ARM_CONTROL_PROCESS_COUNT=0' 'repair proves no worker process'
Assert-Literal $repair 'XAUUSD_POSITIONS=0' 'repair proves flat positions'
Assert-Literal $repair 'XAUUSD_PENDING_ORDERS=0' 'repair proves flat pending orders'
Assert-Literal $repair 'BRIDGE_LIVE_ARM_STATUS=DISARMED' 'repair proves desired DISARM side effect'
Assert-Literal $repair 'BOT_MODE=PAUSE' 'repair requires fail-closed PAUSE'
Assert-Literal $repair 'ORDER_MUTATION=NONE' 'repair audit forbids orders'
Assert-Literal $repair 'POSITION_MUTATION=NONE' 'repair audit forbids position mutation'
Assert-Literal $repair 'MODE_MUTATION=NONE' 'repair audit forbids mode mutation'
Assert-Literal $repair 'ARM_MUTATION=NONE' 'repair audit forbids ARM mutation'
Assert-Literal $repair 'Remove-Item -LiteralPath $RequestPath -Force' 'repair clears only proven orphan request'
Assert-Literal $repair 'PHASE7C_LIVE_ARM_ORPHAN_RECONCILIATION=PASS' 'repair completion marker'
Assert-Contains $repair '(?s)Write-AtomicJson -Path \$StatusPath -Value.*?phase = "RECONCILED_AFTER_TERMINATED_WORKER".*?Remove-Item -LiteralPath \$RequestPath -Force' 'terminal status must persist before request removal'
Assert-NotContains $repair 'Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask' 'repair must not mutate task'
Assert-NotContains $repair '-Method\s+Post|Invoke-ApiPost|/api/v1/phase7c-live-arm-control/(execute|preflight)' 'repair must not invoke control mutations through API'
Assert-NotContains $repair '/v1/order|/v1/position.*(close|modify)' 'repair must not touch trading mutation endpoints'

Write-Host "PHASE7C_LIVE_ARM_ORPHAN_RECONCILIATION_SOURCE_TEST=PASS"
