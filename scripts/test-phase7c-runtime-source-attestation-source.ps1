$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $ProjectRoot "scripts\lib\phase7c-runtime-source-attestation.ps1"
$Recovery = Join-Path $ProjectRoot "scripts\recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$WebDeploy = Join-Path $ProjectRoot "scripts\deploy-phase7c-web-ui-local.ps1"
$BrokerRunner = Join-Path $ProjectRoot "scripts\run-phase7c-executor-task-runner-local.ps1"
$Supervisor = Join-Path $ProjectRoot "scripts\run-phase7c-executors-local.ps1"
$CanonicalWorkflow = Join-Path $ProjectRoot ".github\workflows\phase7c-canonical-pr-gate.yml"
$RecoveryWorkflow = Join-Path $ProjectRoot ".github\workflows\phase7c-runtime-ready-stable-recovery-deploy-ci.yml"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

foreach ($path in @($Helper, $Recovery, $WebDeploy, $BrokerRunner, $Supervisor, $CanonicalWorkflow, $RecoveryWorkflow)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Runtime source attestation source missing: $path"
  }
  if ($path.EndsWith('.ps1', [System.StringComparison]::OrdinalIgnoreCase)) {
    Assert-PowerShellSyntax $path
  }
}
. $Helper

$fixtureRoot = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\.runtime"
$identity = Get-Phase7CRuntimeSourceConfigIdentity `
  -RuntimeRoot $fixtureRoot `
  -AccountMode LIVE `
  -LiveExecutionEnabled $true `
  -ControlApiUrl "http://127.0.0.1:3711"
$fingerprint = Get-Phase7CRuntimeSourceConfigFingerprint -ConfigIdentity $identity
Assert-True ($fingerprint -eq "sha256:ad7ecee6a3c038992ba8816bf8ec8235bc2febbdad35fcd07a35c511512445d9") "Cross-language fingerprint mismatch: $fingerprint"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-source-attestation-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try {
  $runtimeRoot = Join-Path $tempRoot ".runtime"
  $launcher = Join-Path $tempRoot "launcher.ps1"
  [System.IO.File]::WriteAllText($launcher, "Write-Host 'launcher'`n", (New-Object System.Text.UTF8Encoding($false)))

  $tempIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
    -RuntimeRoot $runtimeRoot `
    -AccountMode LIVE `
    -LiveExecutionEnabled $true `
    -ControlApiUrl "http://127.0.0.1:3711"

  $first = Initialize-Phase7CRuntimeSourceDeployment `
    -RuntimeRoot $runtimeRoot `
    -SourceCommit "4f156ef1b019ef676cc23ed978c9487eb41f2fe6" `
    -SourceTree "0ab41605d0ccdf0b17210826081ce4bd9e3a5620" `
    -Branch main `
    -ConfigIdentity $tempIdentity

  $second = Initialize-Phase7CRuntimeSourceDeployment `
    -RuntimeRoot $runtimeRoot `
    -SourceCommit "4f156ef1b019ef676cc23ed978c9487eb41f2fe6" `
    -SourceTree "0ab41605d0ccdf0b17210826081ce4bd9e3a5620" `
    -Branch main `
    -ConfigIdentity $tempIdentity

  Assert-True ([string]$first.deploymentId -eq [string]$second.deploymentId) "Same identity must reuse deploymentId"
  Assert-True ([long]$first.createdAt -eq [long]$second.createdAt) "Same identity must reuse createdAt"

  Start-Sleep -Milliseconds 5
  $changedIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
    -RuntimeRoot $runtimeRoot `
    -AccountMode DEMO `
    -LiveExecutionEnabled $false `
    -ControlApiUrl "http://127.0.0.1:3711"
  $third = Initialize-Phase7CRuntimeSourceDeployment `
    -RuntimeRoot $runtimeRoot `
    -SourceCommit "4f156ef1b019ef676cc23ed978c9487eb41f2fe6" `
    -SourceTree "0ab41605d0ccdf0b17210826081ce4bd9e3a5620" `
    -Branch main `
    -ConfigIdentity $changedIdentity

  Assert-True ([string]$third.deploymentId -ne [string]$first.deploymentId) "Changed config must rotate deploymentId"
  Assert-True ([long]$third.createdAt -gt [long]$first.createdAt) "Changed config must rotate createdAt"

  $component = Write-Phase7CRuntimeSourceComponentAttestation `
    -RuntimeRoot $runtimeRoot `
    -Component trend `
    -ProcessId 12345 `
    -LauncherPath $launcher `
    -ConfigIdentity $changedIdentity

  Assert-True ([string]$component.component -eq "trend") "component name mismatch"
  Assert-True ([int]$component.pid -eq 12345) "component PID mismatch"
  Assert-True ([string]$component.deploymentId -eq [string]$third.deploymentId) "component deploymentId mismatch"
  Assert-True ([string]$component.configFingerprint -eq [string]$third.configFingerprint) "component config fingerprint mismatch"
  Assert-True ([string]$component.launcherSha256 -match '^sha256:[0-9a-f]{64}$') "launcher hash invalid"

  $manifestPath = Join-Path $runtimeRoot "phase7c-source-attestation\deployment.json"
  $componentPath = Join-Path $runtimeRoot "phase7c-source-attestation\components\trend.json"
  Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) "deployment manifest missing"
  Assert-True (Test-Path -LiteralPath $componentPath -PathType Leaf) "component attestation missing"
  [void](Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)
  [void](Get-Content -LiteralPath $componentPath -Raw | ConvertFrom-Json)

  # Generation reload decision regression contract. Identity is deploymentId +
  # sourceCommit + sourceTree for every canonical SYSTEM component; PID changes alone
  # must never classify a source-generation mismatch.
  $canonicalComponents = @('api','lifecycle-broker','supervisor','trend','sideway','telegram','regime-notifier')
  $processId = 20000
  foreach ($componentName in $canonicalComponents) {
    $processId++
    [void](Write-Phase7CRuntimeSourceComponentAttestation `
      -RuntimeRoot $runtimeRoot `
      -Component $componentName `
      -ProcessId $processId `
      -LauncherPath $launcher `
      -ConfigIdentity $changedIdentity)
  }

  # CASE_2: same deployment + all seven exact => no reload.
  $exactDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $third `
    -TargetDeployment $third
  Assert-True (-not [bool]$exactDecision.reloadRequired) "CASE_2 exact target generation must not require reload"
  Assert-True (-not [bool]$exactDecision.deploymentIdChanged) "CASE_2 deploymentId must remain unchanged"
  Assert-True ([bool]$exactDecision.attestationExactMatch) "CASE_2 all canonical component attestations must be exact"
  Assert-True (@($exactDecision.mismatchComponents).Count -eq 0) "CASE_2 must not report mismatched components"

  # CASE_1: same target deploymentId but stale lifecycle-broker source => reload.
  $brokerPath = Join-Path $runtimeRoot "phase7c-source-attestation\components\lifecycle-broker.json"
  $staleBroker = Get-Content -LiteralPath $brokerPath -Raw | ConvertFrom-Json
  $staleBroker.sourceCommit = "b09131f906fd710c44071bf2e59f227672887e23"
  Assert-True ([string]$staleBroker.deploymentId -eq [string]$third.deploymentId) "CASE_1 fixture must retain target deploymentId"
  [System.IO.File]::WriteAllText(
    $brokerPath,
    ($staleBroker | ConvertTo-Json -Depth 8 -Compress),
    (New-Object System.Text.UTF8Encoding($false))
  )
  $staleDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $third `
    -TargetDeployment $third
  Assert-True ([bool]$staleDecision.reloadRequired) "CASE_1 stale lifecycle broker must require generation reload"
  Assert-True (-not [bool]$staleDecision.deploymentIdChanged) "CASE_1 must prove deploymentId itself did not change"
  Assert-True (@($staleDecision.mismatchComponents) -contains 'lifecycle-broker') "CASE_1 must identify lifecycle-broker mismatch"
  Assert-True (@($staleDecision.reasonCodes) -contains 'SOURCE_COMMIT_MISMATCH') "CASE_1 must expose SOURCE_COMMIT_MISMATCH"

  # Restore exact broker, then prove PID-only churn is not source-generation drift.
  [void](Write-Phase7CRuntimeSourceComponentAttestation `
    -RuntimeRoot $runtimeRoot `
    -Component lifecycle-broker `
    -ProcessId 29999 `
    -LauncherPath $launcher `
    -ConfigIdentity $changedIdentity)
  $pidOnlyDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $third `
    -TargetDeployment $third
  Assert-True (-not [bool]$pidOnlyDecision.reloadRequired) "PID-only change must not require source-generation reload"
  Assert-True ([bool]$pidOnlyDecision.attestationExactMatch) "PID-only change must retain exact source identity"

  # CASE_3: missing canonical component attestation => reload fail-closed.
  $sidewayPath = Join-Path $runtimeRoot "phase7c-source-attestation\components\sideway.json"
  Remove-Item -LiteralPath $sidewayPath -Force
  $missingDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $third `
    -TargetDeployment $third
  Assert-True ([bool]$missingDecision.reloadRequired) "CASE_3 missing canonical attestation must require reload"
  Assert-True (@($missingDecision.mismatchComponents) -contains 'sideway') "CASE_3 must identify the missing canonical component"
  Assert-True (@($missingDecision.reasonCodes) -contains 'ATTESTATION_MISSING') "CASE_3 must expose ATTESTATION_MISSING"
  [void](Write-Phase7CRuntimeSourceComponentAttestation `
    -RuntimeRoot $runtimeRoot `
    -Component sideway `
    -ProcessId 30001 `
    -LauncherPath $launcher `
    -ConfigIdentity $changedIdentity)

  # Explicitly lock the remaining canonical mismatch reason codes.
  $telegramPath = Join-Path $runtimeRoot "phase7c-source-attestation\components\telegram.json"
  $telegramMismatch = Get-Content -LiteralPath $telegramPath -Raw | ConvertFrom-Json
  $telegramMismatch.deploymentId = "11111111111111111111111111111111"
  [System.IO.File]::WriteAllText($telegramPath, ($telegramMismatch | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  $componentDeploymentMismatchDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $third `
    -TargetDeployment $third
  Assert-True ([bool]$componentDeploymentMismatchDecision.reloadRequired) "Component deploymentId mismatch must require reload"
  Assert-True (@($componentDeploymentMismatchDecision.reasonCodes) -contains 'DEPLOYMENT_ID_MISMATCH') "Component mismatch must expose DEPLOYMENT_ID_MISMATCH"
  [void](Write-Phase7CRuntimeSourceComponentAttestation `
    -RuntimeRoot $runtimeRoot `
    -Component telegram `
    -ProcessId 30002 `
    -LauncherPath $launcher `
    -ConfigIdentity $changedIdentity)

  $trendPath = Join-Path $runtimeRoot "phase7c-source-attestation\components\trend.json"
  $treeMismatch = Get-Content -LiteralPath $trendPath -Raw | ConvertFrom-Json
  $treeMismatch.sourceTree = "2222222222222222222222222222222222222222"
  [System.IO.File]::WriteAllText($trendPath, ($treeMismatch | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  $treeMismatchDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $third `
    -TargetDeployment $third
  Assert-True ([bool]$treeMismatchDecision.reloadRequired) "Source tree mismatch must require reload"
  Assert-True (@($treeMismatchDecision.reasonCodes) -contains 'SOURCE_TREE_MISMATCH') "Tree mismatch must expose SOURCE_TREE_MISMATCH"
  [void](Write-Phase7CRuntimeSourceComponentAttestation `
    -RuntimeRoot $runtimeRoot `
    -Component trend `
    -ProcessId 30003 `
    -LauncherPath $launcher `
    -ConfigIdentity $changedIdentity)

  # CASE_4: previous deploymentId differs => reload even with all target attestations exact.
  $previousDifferentDeployment = [pscustomobject][ordered]@{
    version = 1
    deploymentId = "33333333333333333333333333333333"
    sourceCommit = [string]$third.sourceCommit
    sourceTree = [string]$third.sourceTree
    branch = 'main'
    worktreeClean = $true
    createdAt = [long]$third.createdAt
    configFingerprint = [string]$third.configFingerprint
  }
  $changedDeploymentDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
    -RuntimeRoot $runtimeRoot `
    -PreviousDeployment $previousDifferentDeployment `
    -TargetDeployment $third
  Assert-True ([bool]$changedDeploymentDecision.reloadRequired) "CASE_4 changed deploymentId must require reload"
  Assert-True ([bool]$changedDeploymentDecision.deploymentIdChanged) "CASE_4 must report deploymentIdChanged"
  Assert-True ([bool]$changedDeploymentDecision.attestationExactMatch) "CASE_4 target component attestations remain exact"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$helperText = (Get-Content -LiteralPath $Helper -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
Assert-True ($helperText -notmatch '(?i)ARM_LIVE') "P1 helper must not ARM LIVE"
Assert-True ($helperText -notmatch '(?i)mode\s*=\s*["'']AUTO["'']') "P1 helper must not set AUTO"
Assert-True ($helperText -notmatch '(?i)Start-ScheduledTask') "P1 helper must not start Scheduled Tasks"
Assert-True ($helperText -notmatch '(?i)/v1/orders') "P1 helper must not call order endpoints"

# Task 2: both canonical deployment paths must create/reuse the same generation
# only after exact source/config guards, and before any P1-aware runtime restart.
$recoveryText = (Get-Content -LiteralPath $Recovery -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$webText = (Get-Content -LiteralPath $WebDeploy -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

foreach ($pair in @(
  [pscustomobject]@{ Name = 'recovery'; Text = $recoveryText },
  [pscustomobject]@{ Name = 'web'; Text = $webText }
)) {
  Assert-True ($pair.Text.Contains('lib\phase7c-runtime-source-attestation.ps1')) "RED Task2: $($pair.Name) must load P1 attestation helper"
  Assert-True ($pair.Text.Contains('Initialize-Phase7CRuntimeSourceDeployment')) "RED Task2: $($pair.Name) must initialize/reuse deployment manifest"
  Assert-True ($pair.Text.Contains('PHASE7C_RUNTIME_SOURCE_DEPLOYMENT_ID=')) "RED Task2: $($pair.Name) must audit deploymentId"
  Assert-True ($pair.Text.Contains('PHASE7C_RUNTIME_SOURCE_COMMIT=')) "RED Task2: $($pair.Name) must audit source commit"
  Assert-True ($pair.Text.Contains('PHASE7C_RUNTIME_SOURCE_TREE=')) "RED Task2: $($pair.Name) must audit source tree"
  Assert-True ($pair.Text.Contains('PHASE7C_RUNTIME_SOURCE_MANIFEST=READY')) "RED Task2: $($pair.Name) must audit manifest readiness"
  Assert-True ($pair.Text.Contains('rev-parse "$ExpectedCommit`^{tree}"')) "RED Task2: $($pair.Name) must derive tree from exact accepted commit"
}

$recoveryGitIndex = $recoveryText.IndexOf('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GIT_GUARD=PASS', [System.StringComparison]::Ordinal)
$recoveryManifestIndex = $recoveryText.IndexOf('Initialize-Phase7CRuntimeSourceDeployment', [System.StringComparison]::Ordinal)
$recoveryMutationIndex = $recoveryText.IndexOf('$mutationStarted = $false', [System.StringComparison]::Ordinal)
Assert-True ($recoveryGitIndex -ge 0 -and $recoveryManifestIndex -gt $recoveryGitIndex) "RED Task2: recovery manifest must follow exact Git guard"
Assert-True ($recoveryMutationIndex -gt $recoveryManifestIndex) "RED Task2: recovery manifest must exist before recovery mutation gate"

# Stale canonical component identity must participate in the generation reload decision
# before the recovery mutation gate. The old deploymentId-only expression is forbidden.
Assert-True ($recoveryText.Contains('Get-Phase7CRuntimeSourceGenerationReloadDecision')) "recovery must classify deployment and canonical component attestation identity together"
Assert-True ($recoveryText.Contains('$runtimeSourceGenerationReloadRequired = [bool]$runtimeSourceGenerationDecision.reloadRequired')) "recovery must use the canonical reload decision result"
Assert-True ($recoveryText.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD_REASONS=')) "recovery must audit generation reload reasons"
Assert-True ($recoveryText.Contains('PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_MISMATCH_COMPONENTS=')) "recovery must audit mismatched canonical components"
Assert-True (-not $recoveryText.Contains('$null -eq $previousDeployment -or')) "recovery must not retain deploymentId-only generation reload decision"

$webGitIndex = $webText.IndexOf('PHASE7C_WEB_UI_DEPLOY_GIT_CLEAN=PASS', [System.StringComparison]::Ordinal)
$webManifestIndex = $webText.IndexOf('Initialize-Phase7CRuntimeSourceDeployment', [System.StringComparison]::Ordinal)
$webFreshIndex = $webText.IndexOf('[void](Assert-LifecycleBrokerSourceFresh -WorkDir $WorkDir)', [System.StringComparison]::Ordinal)
Assert-True ($webGitIndex -ge 0 -and $webManifestIndex -gt $webGitIndex) "RED Task2: Web manifest must follow exact Git guard"
Assert-True ($webFreshIndex -gt $webManifestIndex) "RED Task2: Web manifest must precede broker freshness/build/restart"

$webFreshSourcesStart = $webText.IndexOf('$startupLoadedSources = @(', [System.StringComparison]::Ordinal)
$webFreshSourcesEnd = if ($webFreshSourcesStart -ge 0) { $webText.IndexOf("`n  )", $webFreshSourcesStart, [System.StringComparison]::Ordinal) } else { -1 }
Assert-True ($webFreshSourcesStart -ge 0 -and $webFreshSourcesEnd -gt $webFreshSourcesStart) "RED review: Web broker freshness source set is not structurally readable"
$webFreshSourcesBlock = $webText.Substring($webFreshSourcesStart, $webFreshSourcesEnd - $webFreshSourcesStart)
Assert-True ($webFreshSourcesBlock.Contains('$RuntimeSourceAttestationLibrary')) "RED review: Web broker freshness must include P1 helper loaded by the broker"

Assert-True ($webText.Contains('phase7c-account-mode.json')) "RED review: Web manifest identity must read durable canonical account state"
Assert-True ($webText.Contains('-AccountMode $canonicalAttestedAccountMode')) "RED review: Web manifest identity must use canonical accountMode"
Assert-True ($webText.Contains('-LiveExecutionEnabled $canonicalAttestedLiveExecutionEnabled')) "RED review: Web manifest identity must use canonical liveExecutionEnabled"
$webAccountStateIndex = $webText.IndexOf('phase7c-account-mode.json', [System.StringComparison]::Ordinal)
Assert-True ($webAccountStateIndex -ge 0 -and $webAccountStateIndex -lt $webManifestIndex) "RED review: Web canonical account state must be validated before manifest initialization"

# Task 3: attest only at existing launch boundaries and use the real/canonical PIDs.
$brokerText = (Get-Content -LiteralPath $BrokerRunner -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$supervisorText = (Get-Content -LiteralPath $Supervisor -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

Assert-True ($brokerText.Contains('lib\phase7c-runtime-source-attestation.ps1')) "RED Task3: lifecycle broker must load P1 attestation helper"
Assert-True ($brokerText.Contains('-Component lifecycle-broker')) "RED Task3: lifecycle broker component record missing"
Assert-True ($brokerText.Contains('-ProcessId $PID')) "RED Task3: lifecycle broker must attest actual PowerShell PID"
Assert-True ($brokerText.Contains('-LauncherPath $PSCommandPath')) "RED Task3: lifecycle broker must hash its canonical launcher"
Assert-True ($brokerText.Contains('PHASE7C_RUNTIME_SOURCE_ATTESTATION_LIFECYCLE_BROKER=DEGRADED')) "RED Task3: broker attestation failure must be observable and non-fatal"

Assert-True ($supervisorText.Contains('lib\phase7c-runtime-source-attestation.ps1')) "RED Task3: supervisor must load P1 attestation helper"
Assert-True ($supervisorText.Contains('-Component supervisor')) "RED Task3: supervisor component record missing"
Assert-True ($supervisorText.Contains('-ProcessId $PID')) "RED Task3: supervisor must attest actual PowerShell PID"
foreach ($component in @('trend','sideway','telegram','regime-notifier')) {
  Assert-True ($supervisorText.Contains("-Component $component")) "RED Task3: supervisor must attest child component $component"
}
foreach ($pidPath in @('$TrendPidPath','$SidewayPidPath','$TelegramModePidPath','$RegimeNotifierPidPath')) {
  Assert-True ($supervisorText.Contains("Get-Content -LiteralPath $pidPath")) "RED Task3: child attestation must use canonical PID file $pidPath"
}
Assert-True ($supervisorText.Contains('PHASE7C_RUNTIME_SOURCE_ATTESTATION_SUPERVISOR=DEGRADED')) "RED Task3: supervisor attestation failure must be non-fatal"
Assert-True ($supervisorText.Contains('PHASE7C_RUNTIME_SOURCE_ATTESTATION_CHILD=DEGRADED')) "RED Task3: child attestation failure must be non-fatal"

# Task 6: CI must keep P1 behavior/source coverage and retrigger recovery safety
# whenever any P1 launch/deploy/attestation surface changes.
$canonicalWorkflowText = (Get-Content -LiteralPath $CanonicalWorkflow -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
$recoveryWorkflowText = (Get-Content -LiteralPath $RecoveryWorkflow -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

foreach ($required in @(
  'test-phase7c-runtime-source-attestation-source.ps1',
  'test-phase7c-runtime-source-attestation-api-source.ps1',
  'test-phase7c-runtime-source-attestation-web-source.ps1'
)) {
  Assert-True ($canonicalWorkflowText.Contains($required)) "RED Task6: canonical workflow must run $required"
  Assert-True ($recoveryWorkflowText.Contains($required)) "RED Task6: recovery workflow must run $required"
}
Assert-True ($canonicalWorkflowText.Contains('phase7c-runtime-source-attestation.service.test.ts')) "RED Task6: canonical Linux must run P1 Node behavior tests"
Assert-True ($canonicalWorkflowText.Contains("permissions:`n  contents: read")) "Task6 canonical workflow must preserve contents: read"
Assert-True ($recoveryWorkflowText.Contains("permissions:`n  contents: read")) "Task6 recovery workflow must preserve contents: read"

foreach ($requiredPath in @(
  'scripts/lib/phase7c-runtime-source-attestation.ps1',
  'scripts/recover-phase7c-runtime-ready-stable-deploy-local.ps1',
  'scripts/deploy-phase7c-web-ui-local.ps1',
  'scripts/run-phase7b-api-runtime-local.ps1',
  'scripts/run-phase7c-executor-task-runner-local.ps1',
  'scripts/run-phase7c-executors-local.ps1',
  'apps/api/src/index.ts',
  'apps/api/src/app.ts',
  'apps/api/src/routes/phase7c-runtime-source-attestation.route.ts',
  'apps/api/src/services/phase7c-runtime-source-attestation.service.ts',
  'apps/api/src/services/phase7c-runtime-source-attestation.service.test.ts',
  'apps/web/src/pages/Phase7CControlCenterShellPage.tsx',
  'apps/web/src/phase7c-runtime-source-attestation-api.ts',
  'apps/web/src/phase7c-runtime-source-attestation-types.ts',
  'apps/web/src/ui/Phase7CRuntimeSourceAttestationCard.tsx',
  'scripts/test-phase7c-runtime-source-attestation-source.ps1',
  'scripts/test-phase7c-runtime-source-attestation-api-source.ps1',
  'scripts/test-phase7c-runtime-source-attestation-web-source.ps1'
)) {
  Assert-True ($recoveryWorkflowText.Contains($requiredPath)) "RED Task6: recovery workflow path filters must include $requiredPath"
}

Write-Host "PHASE7C_RUNTIME_SOURCE_ATTESTATION_SOURCE_TEST=PASS"
