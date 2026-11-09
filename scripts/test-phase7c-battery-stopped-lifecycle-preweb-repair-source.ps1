$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RecoveryPath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
if (-not (Test-Path -LiteralPath $RecoveryPath -PathType Leaf)) {
  throw "Required recovery source not found: $RecoveryPath"
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($RecoveryPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "PowerShell syntax error in ${RecoveryPath}: $($errors[0].Message)"
}

$recovery = Get-Content -LiteralPath $RecoveryPath -Raw

function Assert-Contains {
  param(
    [Parameter(Mandatory = $true)] [string]$Text,
    [Parameter(Mandatory = $true)] [string]$Pattern,
    [Parameter(Mandatory = $true)] [string]$Message
  )
  if ($Text -notmatch $Pattern) { throw $Message }
}

function Assert-Order {
  param(
    [Parameter(Mandatory = $true)] [string]$Text,
    [Parameter(Mandatory = $true)] [string]$Before,
    [Parameter(Mandatory = $true)] [string]$After,
    [Parameter(Mandatory = $true)] [string]$Message
  )
  $beforeIndex = $Text.IndexOf($Before, [System.StringComparison]::Ordinal)
  $afterIndex = $Text.IndexOf($After, [System.StringComparison]::Ordinal)
  if ($beforeIndex -lt 0 -or $afterIndex -lt 0 -or $beforeIndex -ge $afterIndex) {
    throw $Message
  }
}

# LIVE RED reproduced after PR #241:
# - canonical trusted task, battery-only definition drift
# - Scheduled Task Running
# - broker process alive + heartbeat fresh + startup lock HELD
# - lifecycle stopped with zero executor processes / no PID files
# The recovery must repair the battery task definition BEFORE Web/API deploy,
# because dashboard deploy requires live supervisor/trend/sideway PID files.
Assert-Contains $recovery '\$batteryLifecycleStoppedNoExecutors\s*=' `
  'RED: recovery must explicitly classify lifecycle stopped + zero executors for battery pre-Web repair.'
Assert-Contains $recovery '\$batteryHealthyBrokerStoppedLifecycleEligible\s*=' `
  'Recovery must explicitly classify the healthy-broker/stopped-lifecycle battery repair tuple.'
Assert-Contains $recovery '\[string\]\$taskBeforeBatteryRepair\.State\s+-eq\s+[''\"]Running[''\"]' `
  'Healthy-broker battery pre-Web repair must require Scheduled Task Running.'
Assert-Contains $recovery '\[bool\]\$runtimeGenerationBeforeBatteryRepair\.brokerProcessAlive' `
  'Healthy-broker battery pre-Web repair must require broker process alive.'
Assert-Contains $recovery '\[bool\]\$runtimeGenerationBeforeBatteryRepair\.brokerHeartbeatFresh' `
  'Healthy-broker battery pre-Web repair must require fresh broker heartbeat.'
Assert-Contains $recovery '\$lockStateBeforeBatteryRepair\s*=\s*\[string\]\$runtimeGenerationBeforeBatteryRepair\.startupRunnerLockState' `
  'Battery pre-Web repair must bind the observed startup-runner lock state exactly once.'
Assert-Contains $recovery '\$lockHeldBeforeBatteryRepair\s*=\s*\$lockStateBeforeBatteryRepair\s+-eq\s+[''\"]HELD[''\"]' `
  'Healthy-broker battery pre-Web repair must derive an explicit HELD lock proof.'
Assert-Contains $recovery '\$batteryHealthyBrokerStoppedLifecycleEligible\s*=[\s\S]*\$lockHeldBeforeBatteryRepair\s+-and[\s\S]*\$batteryLifecycleStoppedNoExecutors' `
  'Healthy-broker battery tuple must consume the explicit HELD lock proof.'
Assert-Contains $recovery '-not\s+\[bool\]\$lifecycleBeforeBatteryRepair\.running' `
  'Battery pre-Web repair must require lifecycle running=false.'
Assert-Contains $recovery '-not\s+\(Test-Phase7CLifecycleHasAliveProcess\s+-State\s+\$lifecycleBeforeBatteryRepair\)' `
  'Battery pre-Web repair must require zero alive lifecycle executor processes.'
Assert-Contains $recovery '\$batteryPreWebRepairEligible\s*=\s*[\s\S]*?\$batteryStrandedOutageEligible\s*(?:\x60)?\s*-or\s*(?:\x60)?\s*\$batteryHealthyBrokerStoppedLifecycleEligible' `
  'Battery pre-Web repair must allow only the proven stranded tuple or the proven healthy-broker/stopped-lifecycle tuple.'

# Unlike the original stranded case, this LIVE state has an active broker.
# Recovery must capture the old PID, stop the task, prove the old broker process
# is dead, and only then invoke the canonical installer -Repair.
Assert-Contains $recovery '\$brokerPidBeforeBatteryRepair\s*=\s*Get-Phase7CBrokerPidFromHeartbeat' `
  'Battery pre-Web repair must capture the existing broker PID before stopping the task.'
Assert-Contains $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_PREVIOUS_BROKER_EXIT=PASS\|PREVIOUS_PID=' `
  'Battery pre-Web repair must emit proof that the previous broker process stopped.'
Assert-Contains $recovery 'Get-Process\s+-Id\s+\$brokerPidBeforeBatteryRepair\s+-ErrorAction\s+SilentlyContinue' `
  'Battery pre-Web repair must verify the captured broker PID is no longer alive.'
Assert-Order $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_PREVIOUS_BROKER_EXIT=PASS' '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $TaskInstaller' `
  'Previous broker PID death must be proven before the canonical task installer runs.'
Assert-Order $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_LIFECYCLE_READY=PASS' '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy' `
  'Battery repair and stable lifecycle restore must finish before Web/API deploy.'

# Preserve the narrow design: no battery-specific dashboard/account-verifier bypass.
if ($recovery -match 'AllowOwnedTaskBatterySettingsMigration') {
  throw 'Battery stopped-lifecycle recovery must not add a generic battery verifier bypass.'
}

Write-Host 'PHASE7C_BATTERY_STOPPED_LIFECYCLE_PREWEB_REPAIR_SOURCE=PASS'
