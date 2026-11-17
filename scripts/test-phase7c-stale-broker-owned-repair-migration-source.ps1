$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RecoveryPath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$WebDeployPath = Join-Path $PSScriptRoot "deploy-phase7c-web-ui-local.ps1"

foreach ($required in @($RecoveryPath, $WebDeployPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required stale-broker migration source not found: $required"
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

function Assert-Literal {
  param(
    [Parameter(Mandatory = $true)] [string]$Text,
    [Parameter(Mandatory = $true)] [string]$Literal,
    [Parameter(Mandatory = $true)] [string]$Message
  )
  if ($Text.IndexOf($Literal, [System.StringComparison]::Ordinal) -lt 0) { throw $Message }
}

Assert-PowerShellSyntax $RecoveryPath
Assert-PowerShellSyntax $WebDeployPath
$recovery = Get-Content -LiteralPath $RecoveryPath -Raw
$webDeploy = Get-Content -LiteralPath $WebDeployPath -Raw

# Production reproduction: after guarded source sync, a still-running lifecycle
# broker can be older than source. Ordinary Web/API deploy must continue to fail
# closed. Canonical recovery already has one narrow migration proof window:
# AllowOwnedTaskProvenanceMigration + exact trusted runner SHA256. Only that path
# may tolerate the stale broker long enough to reach STOP -> repair -> START.
Assert-Literal $webDeploy '[switch]$AllowOwnedTaskProvenanceMigration' `
  'Web/API deploy must retain the explicit owned-task provenance migration switch.'
Assert-Literal $webDeploy '[string]$ExpectedRunnerSha256' `
  'Owned-task migration must stay bound to the exact trusted runner SHA256.'
Assert-Literal $webDeploy 'if ($brokerStartedUtc -lt $latestSourceWriteUtc)' `
  'Web/API deploy must retain explicit stale lifecycle broker detection.'
Assert-Literal $webDeploy 'if ($AllowOwnedTaskProvenanceMigration)' `
  'Stale-source exception must be tied to the existing owned-task migration window.'
Assert-Literal $webDeploy 'PHASE7C_WEB_UI_DEPLOY_BROKER_SOURCE_STALE_MIGRATION=ALLOWED_OWNED_TASK_REPAIR' `
  'RED: Web/API deploy is missing the narrow stale-broker allowance inside the already-proven owned-task migration window.'
Assert-Literal $webDeploy 'Web UI deploy blocked: lifecycle broker process is stale relative to source loaded at broker startup.' `
  'Ordinary Web/API deploy must preserve the existing stale-broker fail-closed error.'
Assert-Literal $webDeploy 'PHASE7C_WEB_UI_DEPLOY_BROKER_SOURCE_FRESH=PASS' `
  'Fresh broker source must keep the existing PASS marker.'

# Recovery is the proof authority for this narrow window. It only appends the
# migration arguments for taskProvenanceRepairRequired, after API SID validation,
# and taskRepairRequired remains true so a stale old generation cannot be accepted
# as SKIPPED_ALREADY_STABLE. A changed source deployment also blocks that skip.
Assert-Literal $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_API_SID_PREFLIGHT=PASS' `
  'Recovery must validate the recorded API SID before owned-task migration.'
Assert-Literal $recovery 'if ($taskProvenanceRepairRequired)' `
  'Recovery must classify the owned provenance repair path explicitly.'
Assert-Literal $recovery "'-AllowOwnedTaskProvenanceMigration'" `
  'Recovery must explicitly open the existing owned-task migration window.'
Assert-Literal $recovery "'-ExpectedRunnerSha256'," `
  'Recovery must pass the expected runner SHA256 migration argument.'
Assert-Literal $recovery '$trustedRunnerSha256' `
  'Recovery must bind the migration window to the trusted Git runner SHA256.'
Assert-Literal $recovery '$taskRepairRequired = $taskProvenanceRepairRequired -or $taskBatterySettingsRepairRequired' `
  'Provenance repair must remain a mandatory lifecycle recovery reason.'
Assert-Literal $recovery 'if ($stableBeforeRecovery -and -not $taskRepairRequired -and -not $runtimeSourceGenerationReloadRequired)' `
  'A provenance-repair rollout and a changed source deployment must remain ineligible for SKIPPED_ALREADY_STABLE.'
Assert-Literal $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=PERFORMED' `
  'Canonical recovery must still require successful provenance repair before final PASS.'
Assert-Literal $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_POST_REPAIR_STARTUP_RUNNER_LOCK=HELD' `
  'Canonical recovery must still prove the startup runner lock after repair.'

Write-Host "PHASE7C_STALE_BROKER_OWNED_REPAIR_MIGRATION_SOURCE_TEST=PASS"
