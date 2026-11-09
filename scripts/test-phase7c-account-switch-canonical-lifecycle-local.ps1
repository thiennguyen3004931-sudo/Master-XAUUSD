$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$targets = @(
  [pscustomobject]@{
    label = 'ACCOUNT_SWITCH'
    path = Join-Path $PSScriptRoot 'switch-phase7c-account-mode-local.ps1'
    stopCall = '(?m)^\s{2}Stop-ExecutorsThroughLifecycle\s*$'
    mutation = '(?m)^\s{2}Write-SelectedRuntimeFiles\s+\$TargetMode\b'
    startCall = '(?m)^\s{2}Start-ExecutorsThroughLifecycle\s+\$TargetMode\b'
  },
  [pscustomobject]@{
    label = 'DEMO_RECOVERY'
    path = Join-Path $PSScriptRoot 'recover-phase7c-demo-after-failed-switch-local.ps1'
    stopCall = '(?m)^Ensure-ExecutorsStoppedThroughLifecycle\s*$'
    mutation = '(?m)^Write-Phase7CAccountJsonAtomic\s+-Path\s+\$AccountStatePath\b'
    startCall = '(?m)^Start-ExecutorsThroughLifecycle\s+"DEMO"\s*$'
  }
)

$violations = New-Object System.Collections.Generic.List[string]

function Add-Violation([string]$Label, [string]$Code) {
  $violations.Add("$Label`:$Code")
}

function Match-Index([string]$Text, [string]$Pattern) {
  $match = [regex]::Match($Text, $Pattern)
  if (-not $match.Success) { return -1 }
  return $match.Index
}

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target.path)) {
    Add-Violation $target.label 'SOURCE_MISSING'
    continue
  }

  $source = Get-Content -LiteralPath $target.path -Raw

  if ($source -match '(?im)^\s*Start-ScheduledTask\s+-TaskName\s+\$ExecutorTaskName\b') {
    Add-Violation $target.label 'DIRECT_EXECUTOR_START_SCHEDULED_TASK_FORBIDDEN'
  }
  if ($source -match '(?im)^\s*Stop-ScheduledTask\s+-TaskName\s+\$ExecutorTaskName\b') {
    Add-Violation $target.label 'DIRECT_EXECUTOR_STOP_SCHEDULED_TASK_FORBIDDEN'
  }
  if ($source -notmatch '/api/v1/phase7c/lifecycle/stop') {
    Add-Violation $target.label 'CANONICAL_LIFECYCLE_STOP_MISSING'
  }
  if ($source -notmatch '/api/v1/phase7c/lifecycle/start') {
    Add-Violation $target.label 'CANONICAL_LIFECYCLE_START_MISSING'
  }
  if ($source -notmatch '(?s)Get-ScheduledTask.*\$ExecutorTaskName') {
    Add-Violation $target.label 'EXECUTOR_BROKER_TASK_PRECONDITION_MISSING'
  }
  if ($source -notmatch 'broker\.ready') {
    Add-Violation $target.label 'SYSTEM_BROKER_READY_CHECK_MISSING'
  }
  if ($source -notmatch 'desiredExecutorState') {
    Add-Violation $target.label 'DESIRED_EXECUTOR_STATE_CHECK_MISSING'
  }
  if ($source -notmatch 'STOPPED') {
    Add-Violation $target.label 'STOPPED_STATE_CHECK_MISSING'
  }
  if ($source -notmatch 'RUNNING') {
    Add-Violation $target.label 'RUNNING_STATE_CHECK_MISSING'
  }

  $stopIndex = Match-Index $source $target.stopCall
  $mutationIndex = Match-Index $source $target.mutation
  $startIndex = Match-Index $source $target.startCall
  if ($stopIndex -lt 0) { Add-Violation $target.label 'TOP_LEVEL_CANONICAL_STOP_CALL_MISSING' }
  if ($mutationIndex -lt 0) { Add-Violation $target.label 'ACCOUNT_MUTATION_MARKER_MISSING' }
  if ($startIndex -lt 0) { Add-Violation $target.label 'TOP_LEVEL_CANONICAL_START_CALL_MISSING' }
  if ($stopIndex -ge 0 -and $mutationIndex -ge 0 -and $stopIndex -gt $mutationIndex) {
    Add-Violation $target.label 'CANONICAL_STOP_MUST_PRECEDE_ACCOUNT_MUTATION'
  }
  if ($mutationIndex -ge 0 -and $startIndex -ge 0 -and $mutationIndex -gt $startIndex) {
    Add-Violation $target.label 'CANONICAL_START_MUST_FOLLOW_ACCOUNT_MUTATION'
  }
}

if ($violations.Count -gt 0) {
  Write-Host 'PHASE7C_ACCOUNT_SWITCH_CANONICAL_LIFECYCLE_CONTRACT=FAIL'
  foreach ($violation in $violations) { Write-Host "VIOLATION=$violation" }
  throw ('Phase7C account switch canonical lifecycle contract failed: ' + ($violations -join '; '))
}

Write-Host 'PHASE7C_ACCOUNT_SWITCH_CANONICAL_LIFECYCLE_CONTRACT=PASS'
Write-Host 'EXECUTOR_SCHEDULED_TASK_MUTATION=ABSENT'
Write-Host 'CANONICAL_LIFECYCLE_STOP_BEFORE_ACCOUNT_MUTATION=PASS'
Write-Host 'CANONICAL_LIFECYCLE_START_AFTER_ACCOUNT_MUTATION=PASS'
Write-Host 'SYSTEM_BROKER_PRECONDITION=PASS'
