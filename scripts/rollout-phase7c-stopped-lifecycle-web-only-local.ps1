param(
  [string]$WorkDir = '.runtime',
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$StartupTimeoutSeconds = 90,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedCommit,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedTree
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SnapshotPath = Join-Path $PSScriptRoot 'snapshot-phase7c-stopped-lifecycle-web-only-safety-local.ps1'
$InitializePath = Join-Path $PSScriptRoot 'initialize-phase7c-runtime-source-deployment-local.ps1'
$WebOnlyDeployPath = Join-Path $PSScriptRoot 'deploy-phase7c-stopped-lifecycle-web-only-local.ps1'

foreach ($required in @($SnapshotPath, $InitializePath, $WebOnlyDeployPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Stopped-lifecycle Web-only rollout required helper is missing: $required"
  }
}

if ($ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw 'ApiPort is invalid.' }
if ($WebPort -lt 1024 -or $WebPort -gt 65535) { throw 'WebPort is invalid.' }
if ($ApiPort -eq $WebPort) { throw 'ApiPort and WebPort must be different.' }
if ($StartupTimeoutSeconds -lt 30 -or $StartupTimeoutSeconds -gt 300) { throw 'StartupTimeoutSeconds must be between 30 and 300.' }

$expectedCommitNormalized = $ExpectedCommit.Trim().ToLowerInvariant()
$expectedTreeNormalized = $ExpectedTree.Trim().ToLowerInvariant()

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Path value is required.' }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-DeploymentManifest([string]$ResolvedWorkDir) {
  $path = Join-Path $ResolvedWorkDir 'phase7c-source-attestation\deployment.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Canonical deployment.json is missing after initialize-only step: $path" }
  try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
  catch { throw "Canonical deployment.json is invalid: $($_.Exception.Message)" }
}

function Assert-SnapshotInvariant($Before, $After) {
  if ([string]$After.mode -ne [string]$Before.mode) { throw 'MODE changed across stopped-lifecycle Web-only rollout.' }
  if ([string]$After.arm -ne [string]$Before.arm) { throw 'ARM changed across stopped-lifecycle Web-only rollout.' }
  if ([string]$After.bridgeSessionId -ne [string]$Before.bridgeSessionId -or [int]$After.bridgePid -ne [int]$Before.bridgePid) {
    throw 'Bridge identity changed across stopped-lifecycle Web-only rollout.'
  }
  if ([int]$After.positionCount -ne [int]$Before.positionCount) { throw 'XAUUSD positions changed across stopped-lifecycle Web-only rollout.' }
  if ([int]$After.pendingOrderCount -ne [int]$Before.pendingOrderCount) { throw 'XAUUSD pending orders changed across stopped-lifecycle Web-only rollout.' }
  if ([bool]$After.lifecycleRunning -or [bool]$After.lifecycleReady) { throw 'Lifecycle is not still stopped after Web-only rollout.' }
}

$resolvedWorkDir = Resolve-ProjectPath $WorkDir
$controlApiUrl = "http://127.0.0.1:$ApiPort"

Write-Host '============================================================'
Write-Host '=== PHASE7C STOPPED LIFECYCLE WEB-ONLY ROLLOUT ==='
Write-Host '============================================================'
Write-Host 'MODE_MUTATION=NONE'
Write-Host 'ARM_MUTATION=NONE'
Write-Host 'BRIDGE_RESTART=NONE'
Write-Host 'EXECUTOR_RESTART=NONE'
Write-Host 'ORDER_MUTATION=NONE'
Write-Host 'LIVE_TEST_ORDER=NONE'
Write-Host "EXPECTED_COMMIT=$expectedCommitNormalized"
Write-Host "EXPECTED_TREE=$expectedTreeNormalized"

# Steps 4-5: nothing may be initialized or restarted until the live read-only state is proven safe.
$pre = & $SnapshotPath -WorkDir $resolvedWorkDir -ApiPort $ApiPort
if ($null -eq $pre) { throw 'Pre-rollout read-only safety snapshot did not return state.' }
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_STEP_4_PENDING_ORDERS_0=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_STEP_5_SAFE_STATE_RESNAPSHOT=PASS'

# Step 6: provenance-only deployment identity initialization. This writes only canonical attestation identity.
& $InitializePath `
  -WorkDir $resolvedWorkDir `
  -AccountMode LIVE `
  -LiveExecutionEnabled $true `
  -ControlApiUrl $controlApiUrl `
  -ExpectedCommit $expectedCommitNormalized `
  -ExpectedTree $expectedTreeNormalized
if ($LASTEXITCODE -ne 0) { throw "Initialize-only helper exited with code $LASTEXITCODE." }

$deployment = Read-DeploymentManifest -ResolvedWorkDir $resolvedWorkDir
$deploymentId = ([string]$deployment.deploymentId).Trim().ToLowerInvariant()
if ($deploymentId -notmatch '^[0-9a-f]{32}$') { throw "Canonical deploymentId is invalid: $deploymentId" }
if ([string]$deployment.sourceCommit -ne $expectedCommitNormalized -or [string]$deployment.sourceTree -ne $expectedTreeNormalized) {
  throw 'Canonical deployment manifest source identity does not match expected commit/tree.'
}
if ([string]$deployment.branch -ne 'main' -or -not [bool]$deployment.worktreeClean) {
  throw 'Canonical deployment manifest must attest clean main source.'
}
Write-Host "PHASE7C_STOPPED_WEB_ROLLOUT_STEP_6_DEPLOYMENT_IDENTITY=PASS|DEPLOYMENT_ID=$deploymentId"

# Step 7: the sole runtime mutation is delegated to the previously contracted Web-only helper.
& $WebOnlyDeployPath `
  -WorkDir $resolvedWorkDir `
  -ApiPort $ApiPort `
  -WebPort $WebPort `
  -StartupTimeoutSeconds $StartupTimeoutSeconds `
  -ExpectedCommit $expectedCommitNormalized `
  -ExpectedTree $expectedTreeNormalized `
  -ExpectedDeploymentId $deploymentId
if ($LASTEXITCODE -ne 0) { throw "Stopped-lifecycle Web-only deploy helper exited with code $LASTEXITCODE." }
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_STEP_7_WEB_ONLY_RELOAD=PASS'

# Step 8: re-snapshot from canonical GET-only surfaces after the Web helper's provenance/ancestry acceptance.
$post = & $SnapshotPath -WorkDir $resolvedWorkDir -ApiPort $ApiPort
if ($null -eq $post) { throw 'Post-rollout read-only safety snapshot did not return state.' }
Assert-SnapshotInvariant -Before $pre -After $post

$deploymentAfter = Read-DeploymentManifest -ResolvedWorkDir $resolvedWorkDir
if ([string]$deploymentAfter.deploymentId -ne $deploymentId -or [string]$deploymentAfter.sourceCommit -ne $expectedCommitNormalized -or [string]$deploymentAfter.sourceTree -ne $expectedTreeNormalized) {
  throw 'Canonical deployment identity changed across Web-only rollout.'
}

Write-Host "PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_DEPLOYMENT_ID=$deploymentId"
Write-Host "PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_SOURCE_COMMIT=$expectedCommitNormalized"
Write-Host "PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_SOURCE_TREE=$expectedTreeNormalized"
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_MODE_UNCHANGED=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_ARM_UNCHANGED=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_BRIDGE_UNCHANGED=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_POSITIONS_UNCHANGED=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_PENDING_ORDERS_UNCHANGED=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT_LIFECYCLE_STILL_STOPPED=PASS'
Write-Host 'PHASE7C_STOPPED_WEB_ROLLOUT_POST_ACCEPT=PASS'
