Set-StrictMode -Version Latest

function Get-Phase7CRuntimeSourceConfigIdentity {
  param(
    [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
    [Parameter(Mandatory = $true)] [ValidateSet("DEMO", "LIVE")] [string]$AccountMode,
    [Parameter(Mandatory = $true)] [bool]$LiveExecutionEnabled,
    [Parameter(Mandatory = $true)] [string]$ControlApiUrl
  )

  if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { throw "RuntimeRoot is required." }
  if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) { throw "ControlApiUrl is required." }

  return [pscustomobject][ordered]@{
    version = 1
    accountMode = $AccountMode.Trim().ToUpperInvariant()
    liveExecutionEnabled = [bool]$LiveExecutionEnabled
    runtimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
    controlApiUrl = $ControlApiUrl.TrimEnd('/')
  }
}

function ConvertTo-Phase7CRuntimeSourceCanonicalConfigJson {
  param([Parameter(Mandatory = $true)] $ConfigIdentity)

  if ($null -eq $ConfigIdentity) { throw "ConfigIdentity is required." }
  $versionProperty = $ConfigIdentity.PSObject.Properties['version']
  $accountModeProperty = $ConfigIdentity.PSObject.Properties['accountMode']
  $liveExecutionProperty = $ConfigIdentity.PSObject.Properties['liveExecutionEnabled']
  $runtimeRootProperty = $ConfigIdentity.PSObject.Properties['runtimeRoot']
  $controlApiProperty = $ConfigIdentity.PSObject.Properties['controlApiUrl']
  if ($null -eq $versionProperty -or $null -eq $accountModeProperty -or $null -eq $liveExecutionProperty -or $null -eq $runtimeRootProperty -or $null -eq $controlApiProperty) {
    throw "ConfigIdentity is missing required V1 fields."
  }

  $accountMode = ([string]$accountModeProperty.Value).Trim().ToUpperInvariant()
  if ($accountMode -notin @('DEMO', 'LIVE')) { throw "ConfigIdentity accountMode must be DEMO or LIVE." }
  $runtimeRoot = [string]$runtimeRootProperty.Value
  $controlApiUrl = [string]$controlApiProperty.Value
  if ([string]::IsNullOrWhiteSpace($runtimeRoot) -or [string]::IsNullOrWhiteSpace($controlApiUrl)) {
    throw "ConfigIdentity runtimeRoot/controlApiUrl must be non-empty."
  }

  $canonical = [ordered]@{
    version = 1
    accountMode = $accountMode
    liveExecutionEnabled = [bool]$liveExecutionProperty.Value
    runtimeRoot = $runtimeRoot
    controlApiUrl = $controlApiUrl.TrimEnd('/')
  }
  return ($canonical | ConvertTo-Json -Depth 4 -Compress)
}

function Get-Phase7CRuntimeSourceSha256Text {
  param([Parameter(Mandatory = $true)] [string]$Text)

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($bytes)
  } finally {
    $sha256.Dispose()
  }
  return 'sha256:' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-Phase7CRuntimeSourceFileSha256 {
  param([Parameter(Mandatory = $true)] [string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Runtime source attestation launcher not found: $Path"
  }
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha256.ComputeHash($stream)
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
  return 'sha256:' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-Phase7CRuntimeSourceConfigFingerprint {
  param([Parameter(Mandatory = $true)] $ConfigIdentity)
  return Get-Phase7CRuntimeSourceSha256Text -Text (ConvertTo-Phase7CRuntimeSourceCanonicalConfigJson -ConfigIdentity $ConfigIdentity)
}

function Write-Phase7CRuntimeSourceAtomicJson {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] $Value
  )

  $directory = Split-Path -Parent $Path
  if ([string]::IsNullOrWhiteSpace($directory)) { throw "Atomic JSON target must have a parent directory." }
  [void](New-Item -ItemType Directory -Force -Path $directory)

  $json = $Value | ConvertTo-Json -Depth 8 -Compress
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $token = [guid]::NewGuid().ToString('N')
  $tempPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + $token + '.tmp')
  $backupPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + $token + '.bak')
  $stream = $null
  try {
    $bytes = $utf8.GetBytes($json)
    $stream = New-Object System.IO.FileStream(
      $tempPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [System.IO.File]::Replace($tempPath, $Path, $backupPath)
      if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
        Remove-Item -LiteralPath $backupPath -Force
      }
    } else {
      [System.IO.File]::Move($tempPath, $Path)
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Test-Phase7CRuntimeSourceDeploymentManifest {
  param($Manifest)

  if ($null -eq $Manifest) { return $false }
  foreach ($name in @('version','deploymentId','sourceCommit','sourceTree','branch','worktreeClean','createdAt','configFingerprint')) {
    if ($null -eq $Manifest.PSObject.Properties[$name]) { return $false }
  }
  if ([int]$Manifest.version -ne 1) { return $false }
  if ([string]$Manifest.deploymentId -notmatch '^[0-9a-f]{32}$') { return $false }
  if ([string]$Manifest.sourceCommit -notmatch '^[0-9a-f]{40}$') { return $false }
  if ([string]$Manifest.sourceTree -notmatch '^[0-9a-f]{40}$') { return $false }
  if ([string]$Manifest.branch -ne 'main') { return $false }
  if (-not [bool]$Manifest.worktreeClean) { return $false }
  if ([long]$Manifest.createdAt -le 0) { return $false }
  if ([string]$Manifest.configFingerprint -notmatch '^sha256:[0-9a-f]{64}$') { return $false }
  return $true
}

function Read-Phase7CRuntimeSourceDeployment {
  param([Parameter(Mandatory = $true)] [string]$RuntimeRoot)

  $path = Join-Path ([System.IO.Path]::GetFullPath($RuntimeRoot)) 'phase7c-source-attestation\deployment.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Runtime source deployment manifest is missing: $path"
  }
  try {
    $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  } catch {
    throw "Runtime source deployment manifest is invalid JSON: $path. $($_.Exception.Message)"
  }
  if (-not (Test-Phase7CRuntimeSourceDeploymentManifest -Manifest $manifest)) {
    throw "Runtime source deployment manifest failed V1 validation: $path"
  }
  return $manifest
}

function Initialize-Phase7CRuntimeSourceDeployment {
  param(
    [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
    [Parameter(Mandatory = $true)] [string]$SourceCommit,
    [Parameter(Mandatory = $true)] [string]$SourceTree,
    [Parameter(Mandatory = $true)] [ValidateSet('main')] [string]$Branch,
    [Parameter(Mandatory = $true)] $ConfigIdentity
  )

  $SourceCommit = $SourceCommit.Trim().ToLowerInvariant()
  $SourceTree = $SourceTree.Trim().ToLowerInvariant()
  if ($SourceCommit -notmatch '^[0-9a-f]{40}$') { throw "SourceCommit must be an exact 40-character Git SHA." }
  if ($SourceTree -notmatch '^[0-9a-f]{40}$') { throw "SourceTree must be an exact 40-character Git tree SHA." }

  $runtimeRootFull = [System.IO.Path]::GetFullPath($RuntimeRoot)
  $attestationRoot = Join-Path $runtimeRootFull 'phase7c-source-attestation'
  $path = Join-Path $attestationRoot 'deployment.json'
  $fingerprint = Get-Phase7CRuntimeSourceConfigFingerprint -ConfigIdentity $ConfigIdentity

  $existing = $null
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    try {
      $candidate = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      if (Test-Phase7CRuntimeSourceDeploymentManifest -Manifest $candidate) { $existing = $candidate }
    } catch {
      $existing = $null
    }
  }

  $sameIdentity = $null -ne $existing -and `
    [string]$existing.sourceCommit -eq $SourceCommit -and `
    [string]$existing.sourceTree -eq $SourceTree -and `
    [string]$existing.branch -eq $Branch -and `
    [bool]$existing.worktreeClean -and `
    [string]$existing.configFingerprint -eq $fingerprint

  if ($sameIdentity) {
    return $existing
  }

  $createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($null -ne $existing -and $createdAt -le [long]$existing.createdAt) {
    $createdAt = [long]$existing.createdAt + 1
  }

  $manifest = [pscustomobject][ordered]@{
    version = 1
    deploymentId = [guid]::NewGuid().ToString('N').ToLowerInvariant()
    sourceCommit = $SourceCommit
    sourceTree = $SourceTree
    branch = $Branch
    worktreeClean = $true
    createdAt = [long]$createdAt
    configFingerprint = $fingerprint
  }
  Write-Phase7CRuntimeSourceAtomicJson -Path $path -Value $manifest
  return $manifest
}

function Write-Phase7CRuntimeSourceComponentAttestation {
  param(
    [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
    [Parameter(Mandatory = $true)] [ValidateSet('api','lifecycle-broker','supervisor','trend','sideway','telegram','regime-notifier')] [string]$Component,
    [Parameter(Mandatory = $true)] [int]$ProcessId,
    [Parameter(Mandatory = $true)] [string]$LauncherPath,
    [Parameter(Mandatory = $true)] $ConfigIdentity
  )

  if ($ProcessId -le 0) { throw "ProcessId must be positive." }
  $manifest = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $RuntimeRoot
  $launcherHash = Get-Phase7CRuntimeSourceFileSha256 -Path $LauncherPath
  $configFingerprint = Get-Phase7CRuntimeSourceConfigFingerprint -ConfigIdentity $ConfigIdentity

  $record = [pscustomobject][ordered]@{
    version = 1
    component = $Component
    deploymentId = [string]$manifest.deploymentId
    sourceCommit = [string]$manifest.sourceCommit
    sourceTree = [string]$manifest.sourceTree
    pid = [int]$ProcessId
    startedAt = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    launcherSha256 = $launcherHash
    configFingerprint = $configFingerprint
  }

  $componentsDir = Join-Path ([System.IO.Path]::GetFullPath($RuntimeRoot)) 'phase7c-source-attestation\components'
  $path = Join-Path $componentsDir ($Component + '.json')
  Write-Phase7CRuntimeSourceAtomicJson -Path $path -Value $record
  return $record
}

function Get-Phase7CRuntimeSourceGenerationAttestationStatus {
  param(
    [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
    [Parameter(Mandatory = $true)] $TargetDeployment
  )

  if (-not (Test-Phase7CRuntimeSourceDeploymentManifest -Manifest $TargetDeployment)) {
    throw "TargetDeployment failed runtime source V1 validation."
  }

  $canonicalComponents = @('api','lifecycle-broker','supervisor','trend','sideway','telegram','regime-notifier')
  $mismatchComponents = New-Object 'System.Collections.Generic.List[string]'
  $reasonCodes = New-Object 'System.Collections.Generic.List[string]'
  $componentsDir = Join-Path ([System.IO.Path]::GetFullPath($RuntimeRoot)) 'phase7c-source-attestation\components'

  foreach ($component in $canonicalComponents) {
    $componentReasons = New-Object 'System.Collections.Generic.List[string]'
    $path = Join-Path $componentsDir ($component + '.json')
    $attestation = $null
    $attestationUsable = $false

    if (Test-Path -LiteralPath $path -PathType Leaf) {
      try {
        $attestation = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $requiredProperties = @('version','component','deploymentId','sourceCommit','sourceTree')
        $attestationUsable = $true
        foreach ($name in $requiredProperties) {
          if ($null -eq $attestation.PSObject.Properties[$name]) {
            $attestationUsable = $false
            break
          }
        }
        if ($attestationUsable -and ([int]$attestation.version -ne 1 -or [string]$attestation.component -ne $component)) {
          $attestationUsable = $false
        }
      } catch {
        $attestationUsable = $false
      }
    }

    if (-not $attestationUsable) {
      [void]$componentReasons.Add('ATTESTATION_MISSING')
    } else {
      if (-not [string]::Equals([string]$attestation.deploymentId, [string]$TargetDeployment.deploymentId, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$componentReasons.Add('DEPLOYMENT_ID_MISMATCH')
      }
      if (-not [string]::Equals([string]$attestation.sourceCommit, [string]$TargetDeployment.sourceCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$componentReasons.Add('SOURCE_COMMIT_MISMATCH')
      }
      if (-not [string]::Equals([string]$attestation.sourceTree, [string]$TargetDeployment.sourceTree, [System.StringComparison]::OrdinalIgnoreCase)) {
        [void]$componentReasons.Add('SOURCE_TREE_MISMATCH')
      }
    }

    if ($componentReasons.Count -gt 0) {
      [void]$mismatchComponents.Add($component)
      foreach ($reason in $componentReasons) {
        if (-not $reasonCodes.Contains($reason)) {
          [void]$reasonCodes.Add($reason)
        }
      }
    }
  }

  return [pscustomobject][ordered]@{
    version = 1
    exactMatch = $mismatchComponents.Count -eq 0
    canonicalComponents = @($canonicalComponents)
    mismatchComponents = @($mismatchComponents)
    reasonCodes = @($reasonCodes)
  }
}

function Get-Phase7CRuntimeSourceGenerationReloadDecision {
  param(
    [Parameter(Mandatory = $true)] [string]$RuntimeRoot,
    $PreviousDeployment,
    [Parameter(Mandatory = $true)] $TargetDeployment
  )

  if (-not (Test-Phase7CRuntimeSourceDeploymentManifest -Manifest $TargetDeployment)) {
    throw "TargetDeployment failed runtime source V1 validation."
  }

  $previousDeploymentId = ""
  if ($null -ne $PreviousDeployment -and $null -ne $PreviousDeployment.PSObject.Properties['deploymentId']) {
    $previousDeploymentId = ([string]$PreviousDeployment.deploymentId).Trim()
  }
  $deploymentIdChanged = `
    [string]::IsNullOrWhiteSpace($previousDeploymentId) -or `
    -not [string]::Equals(
      $previousDeploymentId,
      [string]$TargetDeployment.deploymentId,
      [System.StringComparison]::OrdinalIgnoreCase
    )

  $attestationStatus = Get-Phase7CRuntimeSourceGenerationAttestationStatus `
    -RuntimeRoot $RuntimeRoot `
    -TargetDeployment $TargetDeployment

  $reloadReasons = New-Object 'System.Collections.Generic.List[string]'
  if ($deploymentIdChanged) {
    [void]$reloadReasons.Add('DEPLOYMENT_ID_CHANGED')
  }
  if (-not [bool]$attestationStatus.exactMatch) {
    [void]$reloadReasons.Add('CANONICAL_COMPONENT_ATTESTATION_MISMATCH')
  }

  return [pscustomobject][ordered]@{
    version = 1
    reloadRequired = $deploymentIdChanged -or -not [bool]$attestationStatus.exactMatch
    deploymentIdChanged = [bool]$deploymentIdChanged
    attestationExactMatch = [bool]$attestationStatus.exactMatch
    canonicalComponents = @($attestationStatus.canonicalComponents)
    mismatchComponents = @($attestationStatus.mismatchComponents)
    reasonCodes = @($attestationStatus.reasonCodes)
    reloadReasons = @($reloadReasons)
  }
}
