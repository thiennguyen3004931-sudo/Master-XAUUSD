$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReconcilePath = Join-Path $PSScriptRoot 'reconcile-phase7c-stopped-lifecycle-broker-provenance-local.ps1'

if (-not (Test-Path -LiteralPath $ReconcilePath -PathType Leaf)) {
  throw "RED: reconcile entrypoint missing: $ReconcilePath"
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ReconcilePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "PowerShell syntax error in ${ReconcilePath}: $($errors[0].Message)"
}

$resolverAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Resolve-InactiveAttestationState'
}, $true)
if ($null -eq $resolverAst) {
  throw 'RED: Resolve-InactiveAttestationState is missing; PID reuse false-positive remains unresolved.'
}

$resolverSource = $resolverAst.Extent.Text
$contractAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Get-InactiveComponentProcessContract'
}, $true)
if ($null -eq $contractAst) {
  throw 'RED: Get-InactiveComponentProcessContract is missing.'
}
$contractSource = $contractAst.Extent.Text

& {
  param([string]$ContractSource, [string]$ResolverSource)
  Set-StrictMode -Version Latest

  $script:WorkDir = 'C:\runtime'
  $script:PidFilePresent = $false
  $script:Processes = @()

  function Test-Path {
    param(
      [string]$LiteralPath,
      [string]$PathType
    )
    return [bool]$script:PidFilePresent
  }

  function Get-CimInstance {
    param(
      [string]$ClassName,
      [string]$Filter,
      [string]$ErrorAction
    )
    if ($ClassName -ne 'Win32_Process') { throw "Unexpected CIM class: $ClassName" }
    return @($script:Processes)
  }

  Invoke-Expression $ContractSource
  Invoke-Expression $ResolverSource

  function New-Component(
    [string]$Verdict = 'MISMATCH',
    [bool]$Alive = $true,
    [int]$ProcessId = 38044,
    [object[]]$Reasons = @('SOURCE_COMMIT_MISMATCH','SOURCE_TREE_MISMATCH','DEPLOYMENT_ID_MISMATCH')
  ) {
    return [pscustomobject]@{
      verdict = $Verdict
      alive = $Alive
      pid = $ProcessId
      reasonCodes = $Reasons
    }
  }

  $stale = Resolve-InactiveAttestationState -Component (New-Component -Verdict 'STALE' -Alive $false -Reasons @('ATTESTED_PID_DEAD')) -Name 'regime-notifier'
  if ([string]$stale -ne 'STALE_DEAD') { throw "Expected STALE_DEAD, actual=$stale" }

  $script:PidFilePresent = $false
  $script:Processes = @(
    [pscustomobject]@{ ProcessId = 38044; Name = 'conhost.exe'; CommandLine = '\??\C:\WINDOWS\system32\conhost.exe 0x4' }
  )
  $reused = Resolve-InactiveAttestationState -Component (New-Component) -Name 'regime-notifier'
  if ([string]$reused -ne 'PID_REUSED_UNRELATED') { throw "Expected PID_REUSED_UNRELATED, actual=$reused" }

  $script:Processes = @(
    [pscustomobject]@{ ProcessId = 38044; Name = 'powershell.exe'; CommandLine = 'powershell.exe -File C:\repo\scripts\run-phase7c-regime-notifier-local.ps1' }
  )
  $realWrapperFailed = $false
  try { [void](Resolve-InactiveAttestationState -Component (New-Component) -Name 'regime-notifier') }
  catch { $realWrapperFailed = $true }
  if (-not $realWrapperFailed) { throw 'Expected a real regime-notifier wrapper orphan to fail closed.' }

  $script:Processes = @(
    [pscustomobject]@{ ProcessId = 38044; Name = 'conhost.exe'; CommandLine = '\??\C:\WINDOWS\system32\conhost.exe 0x4' },
    [pscustomobject]@{ ProcessId = 39000; Name = 'node.exe'; CommandLine = 'node C:\repo\scripts\run-phase7c-regime-notifier.mjs' }
  )
  $realChildFailed = $false
  try { [void](Resolve-InactiveAttestationState -Component (New-Component) -Name 'regime-notifier') }
  catch { $realChildFailed = $true }
  if (-not $realChildFailed) { throw 'Expected a surviving regime-notifier child process to fail closed.' }

  $script:Processes = @(
    [pscustomobject]@{ ProcessId = 38044; Name = 'conhost.exe'; CommandLine = '\??\C:\WINDOWS\system32\conhost.exe 0x4' }
  )
  $script:PidFilePresent = $true
  $pidFileFailed = $false
  try { [void](Resolve-InactiveAttestationState -Component (New-Component) -Name 'regime-notifier') }
  catch { $pidFileFailed = $true }
  if (-not $pidFileFailed) { throw 'Expected a present canonical PID file to block PID-reuse normalization.' }

  $script:PidFilePresent = $false
  $badReasonFailed = $false
  try { [void](Resolve-InactiveAttestationState -Component (New-Component -Reasons @('PID_MISMATCH')) -Name 'regime-notifier') }
  catch { $badReasonFailed = $true }
  if (-not $badReasonFailed) { throw 'Expected a non-provenance mismatch reason to fail closed.' }

  $unknownFailed = $false
  try { [void](Resolve-InactiveAttestationState -Component (New-Component -Verdict 'UNKNOWN' -Alive $false -Reasons @('EVIDENCE_INVALID')) -Name 'regime-notifier') }
  catch { $unknownFailed = $true }
  if (-not $unknownFailed) { throw 'Expected UNKNOWN inactive attestation to fail closed.' }
} $contractSource $resolverSource

$inactiveAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-InactiveAttestations'
}, $true)
if ($null -eq $inactiveAst -or $inactiveAst.Extent.Text.IndexOf('Resolve-InactiveAttestationState', [System.StringComparison]::Ordinal) -lt 0) {
  throw 'RED: inactive attestation gate must use the PID identity resolver.'
}

$postflightAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-PostflightAttestation'
}, $true)
if ($null -eq $postflightAst) { throw 'RED: Assert-PostflightAttestation is missing.' }
$postflightSource = $postflightAst.Extent.Text

& {
  param([string]$FunctionSource)
  Set-StrictMode -Version Latest
  $script:ExpectedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  $script:ExpectedDeploymentId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  function Assert-DeploymentAttestationIdentity($Snapshot) { if ($null -eq $Snapshot) { throw 'missing snapshot' } }
  function Assert-ApiWebExact($Snapshot, [Nullable[int]]$ExpectedApiPid, [Nullable[int]]$ExpectedWebPid) { return $null }
  function Assert-InactiveAttestations($Snapshot) { return }
  function Get-AttestationComponent($Snapshot, [string]$Name) {
    if ($Name -ne 'lifecycle-broker') { throw "Unexpected component: $Name" }
    return [pscustomobject]@{
      verdict = 'EXACT_MATCH'
      alive = $true
      pid = 303
      sourceCommit = $script:ExpectedCommit
      deploymentId = $script:ExpectedDeploymentId
    }
  }

  Invoke-Expression $FunctionSource
  $snapshot = [pscustomobject]@{ overall = 'MISMATCH'; components = @() }
  Assert-PostflightAttestation -Snapshot $snapshot -ExpectedApiPid 101 -ExpectedWebPid 202 -NewBrokerPid 303
} $postflightSource

$source = (Get-Content -LiteralPath $ReconcilePath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
foreach ($literal in @(
  'Get-CimInstance Win32_Process',
  'PID_REUSED_UNRELATED',
  'SOURCE_COMMIT_MISMATCH',
  'SOURCE_TREE_MISMATCH',
  'DEPLOYMENT_ID_MISMATCH',
  'run-phase7c-regime-notifier-local.ps1',
  'run-phase7c-regime-notifier.mjs',
  'PHASE7C_BROKER_RECONCILE_INACTIVE_PID_REUSE=VERIFIED_UNRELATED',
  'PHASE7C_BROKER_RECONCILE_POSTFLIGHT_EFFECTIVE_OVERALL=STALE'
)) {
  if ($source.IndexOf($literal, [System.StringComparison]::Ordinal) -lt 0) {
    throw "RED: required PID-reuse safety contract missing: $literal"
  }
}

Write-Host 'PHASE7C_STOPPED_RECONCILE_PID_REUSE_TEST=PASS'
