$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RecoveryPath = Join-Path $PSScriptRoot "recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$WebDeployPath = Join-Path $PSScriptRoot "deploy-phase7c-web-ui-local.ps1"
$DashboardDeployPath = Join-Path $PSScriptRoot "deploy-phase7c-mt5-dashboard-local.ps1"
$VerifierPath = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"

foreach ($required in @($RecoveryPath, $WebDeployPath, $DashboardDeployPath, $VerifierPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required migration verifier source not found: $required"
  }
}

$recovery = Get-Content -LiteralPath $RecoveryPath -Raw
$webDeploy = Get-Content -LiteralPath $WebDeployPath -Raw
$dashboardDeploy = Get-Content -LiteralPath $DashboardDeployPath -Raw
$verifier = Get-Content -LiteralPath $VerifierPath -Raw

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}
foreach ($sourcePath in @($RecoveryPath, $WebDeployPath, $DashboardDeployPath, $VerifierPath)) {
  Assert-PowerShellSyntax $sourcePath
}

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

# The verifier must expose an explicit, opt-in migration window plus the exact
# expected trusted runner SHA. A generic lock-skip switch is intentionally not
# acceptable.
Assert-Contains $verifier '\[switch\]\$AllowOwnedTaskProvenanceMigration' `
  'RED: account verifier must expose the narrow owned-task provenance migration switch.'
Assert-Contains $verifier '\[string\]\$ExpectedRunnerSha256' `
  'Account verifier migration window must require the expected trusted runner SHA256.'
Assert-Contains $verifier 'Normalize-Phase7CRunnerSha256\s+-Sha256\s+\$ExpectedRunnerSha256' `
  'Account verifier must validate the migration SHA256 through the canonical ownership helper.'
Assert-Contains $verifier 'Get-Phase7CTrustedGitFileSha256[\s\S]*-ProjectRoot\s+\$ProjectRoot[\s\S]*-Path\s+\$expectedRunnerPath' `
  'Account verifier must independently derive the trusted runner SHA256 from accepted Git HEAD bytes.'
Assert-Contains $verifier '\[string\]::Equals\([\s\S]*\$expectedMigrationRunnerSha256[\s\S]*\$trustedMigrationRunnerSha256[\s\S]*Ordinal' `
  'Account verifier must bind caller expected SHA256 to the independently derived trusted Git SHA256.'
Assert-Contains $verifier 'PHASE7C_ACCOUNT_VERIFY_TASK_MIGRATION_TRUSTED_GIT_SHA=PASS' `
  'Account verifier must emit trusted Git SHA proof before using the migration window.'
Assert-Contains $verifier 'Test-Phase7CExecutorTaskActionOwnership[\s\S]*-ExpectedRunnerSha256\s+\$trustedMigrationRunnerSha256' `
  'Account verifier must recompute task ownership against the independently trusted Git runner SHA256.'
Assert-Contains $verifier '\$migrationWindowAllowed\s*=\s*\[bool\]\$ownership\.owned[\s\S]*\[bool\]\$ownership\.repairRequired[\s\S]*-not\s+\[bool\]\$ownership\.canonical' `
  'Migration lock exemption must require owned + repairRequired + non-canonical task provenance.'
Assert-Contains $verifier 'SYSTEM[\s\S]*ServiceAccount[\s\S]*Highest' `
  'Migration lock exemption must require the canonical SYSTEM + ServiceAccount + Highest principal.'
Assert-Contains $verifier 'PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_LOCK_MIGRATION_WINDOW=ALLOWED_OWNED_REPAIR_REQUIRED' `
  'Account verifier must emit an explicit marker when the narrow migration window is used.'
Assert-Contains $verifier 'if \(-not \$lockHeld -and -not \$migrationWindowAllowed\)[\s\S]*SYSTEM lifecycle broker singleton lock is not held' `
  'Startup-runner lock must remain mandatory outside the proven migration window.'
Assert-Contains $verifier 'if \(\$AllowOwnedTaskProvenanceMigration -and -not \$migrationWindowAllowed\)[\s\S]*throw' `
  'Requested migration mode must fail closed when task provenance or principal proof is insufficient.'

# Propagation must remain explicit from recovery -> web deploy -> dashboard ->
# strict account verifier. It must never become an environment/global bypass.
foreach ($source in @($webDeploy, $dashboardDeploy)) {
  Assert-Contains $source '\[switch\]\$AllowOwnedTaskProvenanceMigration' `
    'Web/dashboard deploy must expose the explicit migration window switch.'
  Assert-Contains $source '\[string\]\$ExpectedRunnerSha256' `
    'Web/dashboard deploy must propagate the exact trusted runner SHA256.'
}
Assert-Contains $webDeploy '\$dashboardDeployArgs\s*=\s*@\(' `
  'Web deploy must build explicit migration-only dashboard arguments.'
Assert-Contains $webDeploy '\$dashboardDeployArgs\s*\+=\s*@\([\s\S]*AllowOwnedTaskProvenanceMigration[\s\S]*ExpectedRunnerSha256' `
  'Web deploy must forward migration switch + expected runner SHA256 only through explicit dashboard arguments.'
Assert-Contains $webDeploy '@dashboardDeployArgs' `
  'Web deploy must splat the explicit migration-only arguments into dashboard deploy.'
Assert-Contains $dashboardDeploy '\$accountVerifierArgs\s*=\s*@\(' `
  'Dashboard deploy must build explicit migration-only verifier arguments.'
Assert-Contains $dashboardDeploy '\$accountVerifierArgs\s*\+=\s*@\([\s\S]*AllowOwnedTaskProvenanceMigration[\s\S]*ExpectedRunnerSha256' `
  'Dashboard deploy must forward migration switch + expected runner SHA256 only through explicit verifier arguments.'
Assert-Contains $dashboardDeploy '@accountVerifierArgs' `
  'Dashboard deploy must splat the explicit migration-only arguments into strict account verifier.'

# Prove the argument-splat shape used by powershell.exe -File on the same Windows
# shells that execute this contract. This protects LIVE PS5.1 propagation from a
# source-only syntax false positive.
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-migration-splat-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $child = Join-Path $tempRoot "child.ps1"
  $out = Join-Path $tempRoot "out.txt"
  $childLines = @(
    'param(',
    '  [switch]$AllowOwnedTaskProvenanceMigration,',
    '  [string]$ExpectedRunnerSha256 = ""',
    ')',
    '[System.IO.File]::WriteAllText($env:PHASE7C_SPLAT_OUT, "$([bool]$AllowOwnedTaskProvenanceMigration)|$ExpectedRunnerSha256")'
  )
  $childLines | Set-Content -LiteralPath $child -Encoding UTF8
  $expectedSplatHash = ('A' * 64)
  $nativeArgs = @('-AllowOwnedTaskProvenanceMigration', '-ExpectedRunnerSha256', $expectedSplatHash)
  $env:PHASE7C_SPLAT_OUT = $out
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $child @nativeArgs
  if ($LASTEXITCODE -ne 0) { throw "powershell.exe migration argument splat failed with exit code $LASTEXITCODE" }
  $splatResult = (Get-Content -LiteralPath $out -Raw).Trim()
  if ($splatResult -ne "True|$expectedSplatHash") {
    throw "powershell.exe migration argument splat did not preserve switch/hash. actual=$splatResult"
  }
} finally {
  Remove-Item Env:PHASE7C_SPLAT_OUT -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Recovery may open the migration window only after it has already classified
# the task as owned + repair-required and validated the API SID/principal.
Assert-Contains $recovery '\$webApiDeployArgs\s*=\s*@\(' `
  'Recovery must build explicit Web/API deploy arguments before mutation.'
Assert-Contains $recovery 'if \(\$taskProvenanceRepairRequired\)[\s\S]*\$webApiDeployArgs\s*\+=' `
  'Recovery must add migration-only arguments only on the proven repair-required path.'
Assert-Contains $recovery 'AllowOwnedTaskProvenanceMigration' `
  'Recovery must request the verifier migration window for an owned repair-required task.'
Assert-Contains $recovery 'ExpectedRunnerSha256[\s\S]*\$trustedRunnerSha256' `
  'Recovery must bind the migration window to the trusted Git runner SHA256.'
Assert-Order $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_API_SID_PREFLIGHT=PASS' '$webApiDeployArgs' `
  'API SID/principal provenance preflight must complete before recovery can build migration-window deploy arguments.'

# The temporary exemption ends at task repair. Before the ordinary provenance
# lifecycle restart/final PASS, the recovered runner lock must be proven HELD.
# Battery-stranded recovery has a separate earlier START, so bind this assertion
# to the last START occurrence, which is the normal/provenance recovery path.
Assert-Contains $recovery 'phase7c-runtime-ownership-probe\.ps1' `
  'Recovery must load the canonical runtime ownership probe for post-repair lock proof.'
Assert-Contains $recovery 'Get-Phase7CReadOnlyLockState\s+-Path' `
  'Recovery must probe startup-runner lock state after task provenance repair.'
Assert-Contains $recovery 'PHASE7C_RUNTIME_READY_STABLE_RECOVERY_POST_REPAIR_STARTUP_RUNNER_LOCK=HELD' `
  'Recovery must emit a post-repair startup-runner lock HELD marker.'
Assert-Contains $recovery 'if \(\$postRepairLockState -ne ["'']HELD["'']\)[\s\S]*throw' `
  'Recovery must fail closed when repaired task does not hold the startup-runner lock.'
$postRepairLockIndex = $recovery.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_POST_REPAIR_STARTUP_RUNNER_LOCK=HELD', [System.StringComparison]::Ordinal)
$startMatches = [regex]::Matches($recovery, [regex]::Escape('Invoke-ApiPost "/api/v1/phase7c/lifecycle/start"'))
if ($postRepairLockIndex -lt 0 -or $startMatches.Count -lt 1) {
  throw 'Post-repair lock or lifecycle START source marker is missing.'
}
$ordinaryStartIndex = $startMatches[$startMatches.Count - 1].Index
if ($ordinaryStartIndex -le $postRepairLockIndex) {
  throw 'Post-repair runner lock must be HELD before ordinary/provenance lifecycle start.'
}

Write-Host 'PHASE7C_RECOVERY_MIGRATION_VERIFIER_WINDOW_SOURCE=PASS'
