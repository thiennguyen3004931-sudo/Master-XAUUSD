param(
  [string]$WorkDir = ".runtime",
  [Parameter(Mandatory = $true)]
  [ValidateSet("DEMO", "LIVE")]
  [string]$AccountMode,
  [Parameter(Mandatory = $true)]
  [bool]$LiveExecutionEnabled,
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedCommit,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedTree
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
if (-not (Test-Path -LiteralPath $RuntimeSourceAttestationLibrary -PathType Leaf)) {
  throw "Runtime source attestation library is missing: $RuntimeSourceAttestationLibrary"
}
. $RuntimeSourceAttestationLibrary

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "WorkDir is required." }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

Push-Location $ProjectRoot
try {
  $git = Get-Command git -ErrorAction Stop

  $branch = (& $git.Source branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    throw "Runtime source deployment initialization requires branch main. Current=$branch"
  }

  $dirty = @(& $git.Source status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect git working tree." }
  if ($dirty.Count -gt 0) {
    throw "Runtime source deployment initialization requires a clean working tree."
  }

  $head = (& $git.Source rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
    throw "Could not resolve exact source commit."
  }

  $tree = (& $git.Source rev-parse "HEAD^{tree}").Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $tree -notmatch '^[0-9a-f]{40}$') {
    throw "Could not resolve exact source tree."
  }

  $expectedCommitNormalized = $ExpectedCommit.Trim().ToLowerInvariant()
  $expectedTreeNormalized = $ExpectedTree.Trim().ToLowerInvariant()
  if ($head -ne $expectedCommitNormalized) {
    throw "Runtime source deployment initialization commit mismatch. expected=$expectedCommitNormalized actual=$head"
  }
  if ($tree -ne $expectedTreeNormalized) {
    throw "Runtime source deployment initialization tree mismatch. expected=$expectedTreeNormalized actual=$tree"
  }

  $resolvedWorkDir = Resolve-ProjectPath $WorkDir
  $configIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
    -RuntimeRoot $resolvedWorkDir `
    -AccountMode $AccountMode `
    -LiveExecutionEnabled $LiveExecutionEnabled `
    -ControlApiUrl $ControlApiUrl

  $deployment = Initialize-Phase7CRuntimeSourceDeployment `
    -RuntimeRoot $resolvedWorkDir `
    -SourceCommit $head `
    -SourceTree $tree `
    -Branch main `
    -ConfigIdentity $configIdentity

  if ([string]$deployment.sourceCommit -ne $head -or [string]$deployment.sourceTree -ne $tree) {
    throw "Canonical deployment manifest does not match the verified source identity."
  }

  Write-Host "PHASE7C_RUNTIME_SOURCE_DEPLOYMENT_ID=$($deployment.deploymentId)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_COMMIT=$($deployment.sourceCommit)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_TREE=$($deployment.sourceTree)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_BRANCH=$($deployment.branch)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_WORKTREE_CLEAN=$($deployment.worktreeClean)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_INITIALIZE_ONLY=PASS"
} finally {
  Pop-Location
}
