param(
  [string]$OutputDir = "artifacts",
  [string]$RequiredCommit = "",
  [string]$ReleaseName = "XAUUSD_AI_MASTER_PORTABLE"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Git([string[]]$Arguments) {
  $git = Get-Command git -ErrorAction Stop
  $output = & $git.Source @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
  return $output
}

function Test-ForbiddenPortablePath([string]$RelativePath) {
  $normalized = $RelativePath.Replace('\', '/').TrimStart('/')
  $segments = @($normalized.Split('/') | Where-Object { $_ -ne '' })
  foreach ($segment in $segments) {
    if ($segment -in @('.runtime', 'node_modules', 'dist', '.next', '.turbo', 'coverage', 'logs')) {
      return $true
    }
  }

  $leaf = [System.IO.Path]::GetFileName($normalized)
  if ($leaf -eq '.env') { return $true }
  if ($leaf -like '.env.*' -and $leaf -notlike '*.example') { return $true }
  if ($leaf -match '\.(?:db|db-shm|db-wal|sqlite|sqlite3|log)$') { return $true }
  return $false
}

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7C_PORTABLE_PACKAGE=START"

  [void](Get-Command git -ErrorAction Stop)
  $dirty = @(Invoke-Git @('status', '--porcelain'))
  if ($dirty.Count -gt 0) {
    throw "Portable packaging requires a clean tracked working tree. Commit or stash changes first."
  }
  Write-Host "PHASE7C_PORTABLE_PACKAGE_GIT_CLEAN=PASS"

  $commitRaw = Invoke-Git @('rev-parse', 'HEAD')
  $commit = ([string]($commitRaw | Select-Object -First 1)).Trim()
  if ([string]::IsNullOrWhiteSpace($commit)) { throw "Could not resolve HEAD commit." }

  $branchRaw = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
  $branch = ([string]($branchRaw | Select-Object -First 1)).Trim()
  if ([string]::IsNullOrWhiteSpace($branch) -or $branch -eq 'HEAD') { $branch = 'DETACHED_HEAD' }

  if (-not [string]::IsNullOrWhiteSpace($RequiredCommit)) {
    & git cat-file -e "$RequiredCommit^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Required commit does not exist locally: $RequiredCommit" }
    & git merge-base --is-ancestor $RequiredCommit $commit 2>$null
    if ($LASTEXITCODE -ne 0) { throw "HEAD does not contain required commit: $RequiredCommit" }
  }

  $trackedPaths = @(Invoke-Git @('ls-tree', '-r', '--name-only', $commit))
  $forbidden = @($trackedPaths | Where-Object { Test-ForbiddenPortablePath ([string]$_) })
  if ($forbidden.Count -gt 0) {
    throw "Tracked source contains forbidden runtime/secret artifacts: $($forbidden -join ', ')"
  }
  Write-Host "PHASE7C_PORTABLE_PACKAGE_SECRETS_EXCLUDED=PASS"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_RUNTIME_EXCLUDED=PASS"

  if (-not [System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir = Join-Path $ProjectRoot $OutputDir
  }
  [System.IO.Directory]::CreateDirectory($OutputDir) | Out-Null
  $OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

  $shortSha = $commit.Substring(0, [Math]::Min(12, $commit.Length))
  $safeReleaseName = ($ReleaseName -replace '[^A-Za-z0-9_.-]', '_').Trim('_')
  if ([string]::IsNullOrWhiteSpace($safeReleaseName)) { throw "ReleaseName is invalid." }
  $baseName = "${safeReleaseName}_${shortSha}"
  $finalZip = Join-Path $OutputDir "$baseName.zip"
  $shaFile = Join-Path $OutputDir "$baseName.sha256.txt"

  $manifest = [ordered]@{
    schemaVersion = 1
    project = 'XAUUSD_AI_MASTER'
    sourceCommit = $commit
    sourceBranch = $branch
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    packageManager = 'pnpm@10.18.0'
    recommendedNode = '24.x'
    recommendedPython = '3.12.x'
    executionHost = 'Windows with MetaTrader 5'
    mobileDevelopment = 'GitHub Codespaces/browser development only; MT5 execution remains on Windows.'
    containsRuntimeState = $false
    containsLocalEnv = $false
    containsCredentials = $false
    containsMt5DataDirectories = $false
    safety = [ordered]@{
      liveArmIncluded = $false
      accountSwitchPerformed = $false
      orderSendPerformed = $false
      portablePackageIsSourceOnly = $true
    }
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6

  if (Test-Path -LiteralPath $finalZip) { Remove-Item -LiteralPath $finalZip -Force }
  & git archive --format=zip --output=$finalZip $commit
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $finalZip)) {
    throw "git archive failed."
  }

  Add-Type -AssemblyName System.IO.Compression
  $stream = [System.IO.File]::Open($finalZip, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Update, $false)
    try {
      $existing = $archive.GetEntry('PORTABLE-RELEASE-MANIFEST.json')
      if ($null -ne $existing) { $existing.Delete() }
      $entry = $archive.CreateEntry('PORTABLE-RELEASE-MANIFEST.json', [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        $writer = New-Object System.IO.StreamWriter($entryStream, $encoding)
        try { $writer.Write($manifestJson) } finally { $writer.Dispose() }
      } finally {
        if ($null -ne $entryStream) { $entryStream.Dispose() }
      }
    } finally {
      if ($null -ne $archive) { $archive.Dispose() }
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }

  $hash = Get-FileHash -LiteralPath $finalZip -Algorithm SHA256
  "$($hash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($finalZip))" | Set-Content -LiteralPath $shaFile -Encoding ASCII

  Write-Host "PHASE7C_PORTABLE_PACKAGE_SOURCE_COMMIT=$commit"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_SOURCE_BRANCH=$branch"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_ZIP=$finalZip"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_SHA256=$($hash.Hash.ToLowerInvariant())"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_LIVE_ARM=False"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_ACCOUNT_SWITCH=False"
  Write-Host "PHASE7C_PORTABLE_PACKAGE_ORDER_SEND=False"
  Write-Host "PHASE7C_PORTABLE_PACKAGE=PASS"
}
finally {
  Pop-Location
}
