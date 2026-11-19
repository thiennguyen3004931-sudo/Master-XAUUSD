$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RecoveryPath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$WebDeployPath = Join-Path $PSScriptRoot "deploy-phase7c-web-ui-local.ps1"
$DashboardDeployPath = Join-Path $PSScriptRoot "deploy-phase7c-mt5-dashboard-local.ps1"
$VerifierPath = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"
$OwnershipPath = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"

foreach ($required in @($RecoveryPath, $WebDeployPath, $DashboardDeployPath, $VerifierPath, $OwnershipPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required battery migration source not found: $required"
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

foreach ($sourcePath in @($RecoveryPath, $WebDeployPath, $DashboardDeployPath, $VerifierPath, $OwnershipPath)) {
  Assert-PowerShellSyntax $sourcePath
}

$recovery = Get-Content -LiteralPath $RecoveryPath -Raw
$webDeploy = Get-Content -LiteralPath $WebDeployPath -Raw
$dashboardDeploy = Get-Content -LiteralPath $DashboardDeployPath -Raw
$verifier = Get-Content -LiteralPath $VerifierPath -Raw
$ownershipSource = Get-Content -LiteralPath $OwnershipPath -Raw

function Assert-Contains {
  param(
    [Parameter(Mandatory = $true)] [string]$Text,
    [Parameter(Mandatory = $true)] [string]$Pattern,
    [Parameter(Mandatory = $true)] [string]$Message
  )
  if ($Text -notmatch $Pattern) { throw $Message }
}

function Assert-NotContains {
  param(
    [Parameter(Mandatory = $true)] [string]$Text,
    [Parameter(Mandatory = $true)] [string]$Pattern,
    [Parameter(Mandatory = $true)] [string]$Message
  )
  if ($Text -match $Pattern) { throw $Message }
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

# One canonical classifier defines the only task-definition drift this recovery
# extension may auto-repair. The classifier is shared with the task installer.
Assert-Contains $ownershipSource 'function\s+Test-Phase7CBatteryOnlyTaskDrift' `
  'RED: canonical ownership helper must expose an exact battery-only task drift classifier.'
Assert-Contains $ownershipSource 'DISALLOW_START_IF_ON_BATTERIES' `
  'Battery-only drift classifier must include the start-on-battery restriction.'
Assert-Contains $ownershipSource 'STOP_IF_GOING_ON_BATTERIES' `
  'Battery-only drift classifier must include the stop-on-battery restriction.'

. $OwnershipPath

$canonicalBatteryDrift = @('DISALLOW_START_IF_ON_BATTERIES', 'STOP_IF_GOING_ON_BATTERIES')
if (-not (Test-Phase7CBatteryOnlyTaskDrift -Drift $canonicalBatteryDrift)) {
  throw 'Battery-only classifier must accept the exact two canonical battery restrictions.'
}
if (-not (Test-Phase7CBatteryOnlyTaskDrift -Drift @('DISALLOW_START_IF_ON_BATTERIES'))) {
  throw 'Battery-only classifier must accept a single canonical battery restriction.'
}
if (Test-Phase7CBatteryOnlyTaskDrift -Drift @()) {
  throw 'Battery-only classifier must reject empty drift.'
}
if (Test-Phase7CBatteryOnlyTaskDrift -Drift @('DISALLOW_START_IF_ON_BATTERIES', 'TRIGGER')) {
  throw 'Battery-only classifier must reject mixed battery + unrelated task drift.'
}

# Recovery must treat canonical trusted action + battery-only settings drift as
# repair-required without reclassifying it as action-provenance drift.
Assert-Contains $recovery 'Get-Phase7CExecutorTaskDrift\s+-Task\s+\$task' `
  'Recovery must inspect canonical task definition drift before deciding repair scope.'
Assert-Contains $recovery 'Test-Phase7CBatteryOnlyTaskDrift\s+-Drift\s+\$taskDefinitionDrift' `
  'Recovery must use the canonical battery-only drift classifier.'
Assert-Contains $recovery '\$taskBatterySettingsRepairRequired\s*=' `
  'Recovery must track battery-settings repair separately from action provenance repair.'
Assert-Contains $recovery '\$taskRepairRequired\s*=\s*\$taskProvenanceRepairRequired\s+-or\s+\$taskBatterySettingsRepairRequired' `
  'Recovery must enter controlled task repair for either trusted provenance drift or battery-only settings drift.'
Assert-Contains $recovery 'unsupported definition drift' `
  'Canonical action with non-battery task-definition drift must fail closed.'

# If the old battery policy has already stranded the canonical task, recovery may
# repair before Web/API deploy only after proving the exact controlled outage:
# canonical trusted task/principal, lifecycle stopped, broker dead+stale, lock absent.
Assert-Contains $recovery 'Get-Phase7CRuntimeGenerationSnapshot\s+-WorkDir\s+\$WorkDir' `
  'Battery outage recovery must inspect canonical runtime generation read-only.'
Assert-Contains $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_REPAIR=ELIGIBLE' `
  'Recovery must emit an explicit audit marker only after proving the battery-stranded outage.'
Assert-Contains $recovery '\$batteryPreWebRepairEligible\s*=' `
  'Recovery must calculate an explicit battery pre-Web repair eligibility gate.'
Assert-Contains $recovery 'brokerProcessAlive' `
  'Battery pre-Web repair eligibility must require broker process absence.'
Assert-Contains $recovery 'brokerHeartbeatFresh' `
  'Battery pre-Web repair eligibility must require non-fresh broker heartbeat.'
Assert-Contains $recovery 'startupRunnerLockState' `
  'Battery pre-Web repair eligibility must require startup-runner lock absence/release.'
Assert-Contains $recovery 'Test-Phase7CLifecycleHasAliveProcess' `
  'Battery pre-Web repair eligibility must prove executor lifecycle is stopped.'

# The pre-Web repair must use the canonical installer, verify convergence, then
# restore lifecycle READY before the ordinary strict Web/API deploy. No verifier
# exemption is introduced for the battery outage.
Assert-Contains $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_TASK_REPAIR=PASS' `
  'Recovery must emit a battery pre-Web task repair pass marker after installer convergence.'
Assert-Contains $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_STARTUP_RUNNER_LOCK=HELD' `
  'Recovery must prove startup-runner lock HELD after battery task repair.'
Assert-Contains $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_LIFECYCLE_READY=PASS' `
  'Recovery must restore lifecycle READY before Web/API deploy.'
Assert-Order $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_TASK_REPAIR=PASS' '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy' `
  'Battery task repair must complete before ordinary Web/API deploy.'
Assert-Order $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_LIFECYCLE_READY=PASS' '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy' `
  'Lifecycle must be READY again before ordinary Web/API deploy.'
Assert-Contains $recovery 'if \(\$taskRepairRequired\)[\s\S]*-Repair' `
  'Normal controlled repair block must also accept battery-only settings repair when runtime is still healthy.'

# This narrower design intentionally adds no battery-specific bypass to Web,
# dashboard, or the strict account verifier. The existing provenance migration
# window remains unchanged and is still the only verifier exemption.
foreach ($source in @($recovery, $webDeploy, $dashboardDeploy, $verifier)) {
  Assert-NotContains $source 'AllowOwnedTaskBatterySettingsMigration' `
    'Battery settings recovery must not introduce a Web/dashboard/verifier bypass switch.'
}
Assert-NotContains $verifier 'BATTERY_MIGRATION_CONTROLLED_OUTAGE' `
  'Strict account verifier must not learn a battery-outage exemption mode.'
Assert-Contains $recovery 'AllowOwnedTaskProvenanceMigration' `
  'Existing trusted action-provenance migration window must remain available for its original scope.'

Write-Host 'PHASE7C_BATTERY_SETTINGS_RECOVERY_MIGRATION_SOURCE=PASS'
