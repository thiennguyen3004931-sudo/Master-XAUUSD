$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runnerPath = Join-Path $PSScriptRoot 'run-phase7c-account-bridge-task-runner-local.ps1'
$helperPath = Join-Path $PSScriptRoot 'lib\phase7b-windows-job-object.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Assert-True (Test-Path -LiteralPath $runnerPath -PathType Leaf) "Bridge task runner not found: $runnerPath"
Assert-True (Test-Path -LiteralPath $helperPath -PathType Leaf) "Canonical Job Object helper not found: $helperPath"

$runnerSource = Get-Content -LiteralPath $runnerPath -Raw
$violations = New-Object System.Collections.Generic.List[string]

if ($runnerSource -notmatch 'lib\\phase7b-windows-job-object\.ps1') {
  $violations.Add('BRIDGE_RUNNER_JOB_OBJECT_HELPER_REFERENCE_MISSING')
}
if ($runnerSource -notmatch '(?m)^\s*\.\s+\$JobObjectHelper\s*$') {
  $violations.Add('BRIDGE_RUNNER_JOB_OBJECT_HELPER_NOT_DOT_SOURCED')
}

$createIndex = $runnerSource.IndexOf('New-Phase7BKillOnCloseJob', [System.StringComparison]::Ordinal)
$assignIndex = $runnerSource.IndexOf('Add-Phase7BProcessToJob', [System.StringComparison]::Ordinal)
$firstStartIndex = $runnerSource.IndexOf('Start-Process', [System.StringComparison]::Ordinal)

if ($createIndex -lt 0) {
  $violations.Add('BRIDGE_RUNNER_JOB_OBJECT_CREATE_MISSING')
}
if ($assignIndex -lt 0) {
  $violations.Add('BRIDGE_RUNNER_JOB_OBJECT_ASSIGN_MISSING')
}
if ($firstStartIndex -lt 0) {
  $violations.Add('BRIDGE_RUNNER_CHILD_START_MISSING')
}
if ($createIndex -ge 0 -and $firstStartIndex -ge 0 -and $createIndex -gt $firstStartIndex) {
  $violations.Add('BRIDGE_RUNNER_JOB_OBJECT_CREATE_MUST_PRECEDE_CHILD_START')
}
if ($assignIndex -ge 0 -and $firstStartIndex -ge 0 -and $assignIndex -gt $firstStartIndex) {
  $violations.Add('BRIDGE_RUNNER_JOB_OBJECT_ASSIGN_MUST_PRECEDE_CHILD_START')
}

if ($runnerSource -notmatch 'Add-Phase7BProcessToJob\s+-Job\s+\$[A-Za-z0-9_:]+\s+-ProcessId\s+\$PID\b') {
  $violations.Add('BRIDGE_RUNNER_MUST_ASSIGN_SUPERVISOR_PID_TO_JOB')
}

if ($violations.Count -gt 0) {
  Write-Host 'PHASE7C_ACCOUNT_BRIDGE_TASK_CHILD_CLEANUP_SOURCE_TEST=FAIL'
  foreach ($violation in $violations) { Write-Host "VIOLATION=$violation" }
  throw ('Phase7C account Bridge task child cleanup source contract failed: ' + ($violations -join '; '))
}

Write-Host 'PHASE7C_ACCOUNT_BRIDGE_TASK_CHILD_CLEANUP_SOURCE_TEST=PASS'
Write-Host 'JOB_OBJECT_HELPER=CANONICAL_PHASE7B_SHARED_HELPER'
Write-Host 'JOB_OBJECT_ASSIGNMENT=SUPERVISOR_PID_BEFORE_CHILD_START'
Write-Host 'FORCED_TASK_TERMINATION_CONTRACT=DESCENDANTS_BOUND_TO_KILL_ON_CLOSE_JOB'
