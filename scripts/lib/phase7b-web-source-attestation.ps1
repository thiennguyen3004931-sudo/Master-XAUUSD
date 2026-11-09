Set-StrictMode -Version Latest

function Write-Phase7BWebRuntimeSourceAttestation {
  param(
    [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
    [Parameter(Mandatory = $true)] [int]$ProcessId,
    [Parameter(Mandatory = $true)] [string]$LauncherPath,
    [Parameter(Mandatory = $true)] $ConfigIdentity
  )

  if ($ProcessId -le 0) { throw "Web ProcessId must be positive." }

  $manifest = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $RuntimeRoot
  $launcherHash = Get-Phase7CRuntimeSourceFileSha256 -Path $LauncherPath
  $configFingerprint = Get-Phase7CRuntimeSourceConfigFingerprint -ConfigIdentity $ConfigIdentity

  $record = [pscustomobject][ordered]@{
    version = 1
    component = 'web'
    deploymentId = [string]$manifest.deploymentId
    sourceCommit = [string]$manifest.sourceCommit
    sourceTree = [string]$manifest.sourceTree
    pid = [int]$ProcessId
    startedAt = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    launcherSha256 = $launcherHash
    configFingerprint = $configFingerprint
  }

  $componentsDir = Join-Path ([System.IO.Path]::GetFullPath($RuntimeRoot)) 'phase7c-source-attestation\components'
  $path = Join-Path $componentsDir 'web.json'
  Write-Phase7CRuntimeSourceAtomicJson -Path $path -Value $record
  return $record
}
