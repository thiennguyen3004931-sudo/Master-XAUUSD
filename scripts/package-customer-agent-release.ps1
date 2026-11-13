param(
  [string]$OutputRoot = "artifacts/customer-agent-release",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked {
  param([scriptblock]$Command, [string]$Failure)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw $Failure
  }
}

if (-not $SkipBuild) {
  Invoke-Checked { pnpm --filter @xauusd/copy-protocol build } "COPY_PROTOCOL_BUILD_FAILED"
  Invoke-Checked { pnpm --filter @xauusd/installation-proof build } "INSTALLATION_PROOF_BUILD_FAILED"
  Invoke-Checked { pnpm --filter @xauusd/customer-agent build } "CUSTOMER_AGENT_BUILD_FAILED"
}

$releaseRoot = Join-Path $repoRoot $OutputRoot
$releaseDir = Join-Path $releaseRoot "customer-agent-v1"
$zipPath = Join-Path $releaseRoot "customer-agent-v1.zip"

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

for ($attempt = 1; $attempt -le 10; $attempt++) {
  try {
    if (Test-Path $releaseDir) {
      Remove-Item -Recurse -Force $releaseDir
    }
    if (Test-Path $zipPath) {
      Remove-Item -Force $zipPath
    }
    break
  } catch {
    if ($attempt -eq 10) { throw }
    Start-Sleep -Milliseconds 200
  }
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $releaseDir "node_modules\@xauusd") | Out-Null

$packages = @(
  "customer-agent",
  "copy-protocol",
  "installation-proof"
)

foreach ($package in $packages) {
  $source = Join-Path $repoRoot "packages\$package"
  $target = Join-Path $releaseDir "node_modules\@xauusd\$package"

  if (-not (Test-Path (Join-Path $source "dist"))) {
    throw "MISSING_DIST=$package"
  }

  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -Force (Join-Path $source "package.json") (Join-Path $target "package.json")
  Copy-Item -Recurse -Force (Join-Path $source "dist") (Join-Path $target "dist")
}

Copy-Item -Recurse -Force (Join-Path $repoRoot "customer-release\bin") (Join-Path $releaseDir "bin")
Copy-Item -Recurse -Force (Join-Path $repoRoot "customer-release\config") (Join-Path $releaseDir "config")
Copy-Item -Force (Join-Path $repoRoot "customer-release\README.md") (Join-Path $releaseDir "README.md")
Copy-Item -Force (Join-Path $repoRoot "customer-release\acceptance-record.template.md") (Join-Path $releaseDir "acceptance-record.template.md")

@'
{
  "name": "xauusd-customer-agent-release",
  "private": true,
  "type": "module",
  "version": "1.0.0"
}
'@ | Set-Content -Encoding UTF8 (Join-Path $releaseDir "package.json")

Get-ChildItem -Path $releaseDir -Recurse -File -Filter "*.map" |
  Remove-Item -Force

$forbiddenPathPatterns = @(
  "[\\/]src[\\/]",
  "strategy-engine",
  "risk-engine",
  "execution-engine",
  "mt5-broker",
  "[\\/]\.git[\\/]",
  "\.env($|\.)",
  "\.pem$",
  "\.key$"
)

$files = Get-ChildItem -Path $releaseDir -Recurse -File
foreach ($file in $files) {
  $relative = $file.FullName.Substring($releaseDir.Length).TrimStart([char[]]"\\/")
  foreach ($pattern in $forbiddenPathPatterns) {
    if ($relative -match $pattern) {
      throw "FORBIDDEN_RELEASE_PATH=$relative"
    }
  }
}

$manifestPath = Join-Path $releaseDir "release-manifest.sha256"
$manifestLines = @()
foreach ($file in ($files | Sort-Object FullName)) {
  $relative = $file.FullName.Substring($releaseDir.Length).TrimStart([char[]]"\\/").Replace("\", "/")
  if ($relative -eq "release-manifest.sha256") { continue }
  $hash = (Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLowerInvariant()
  $manifestLines += "$hash  $relative"
}
$manifestLines | Set-Content -Encoding UTF8 $manifestPath

Compress-Archive -Path (Join-Path $releaseDir "*") -DestinationPath $zipPath -Force

Write-Host "CUSTOMER_RELEASE_PACKAGE=PASS"
Write-Host "CUSTOMER_RELEASE_DIR=$releaseDir"
Write-Host "CUSTOMER_RELEASE_ZIP=$zipPath"
Write-Host "MASTER_SOURCE_INCLUDED=NO"
Write-Host "PRIVATE_KEY_INCLUDED=NO"
Write-Host "API_TOKEN_INCLUDED=NO"
Write-Host "MT5_BRIDGE_INCLUDED=NO"
