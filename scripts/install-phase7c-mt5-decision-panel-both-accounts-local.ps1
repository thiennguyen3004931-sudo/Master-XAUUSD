param(
  [string]$DemoBridgeEnv = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveBridgeEnv = "packages/mt5-broker/bridge/.env.phase7b-live",
  [switch]$SkipCompile
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $PSScriptRoot "install-phase7c-mt5-decision-panel-local.ps1"

if (-not (Test-Path -LiteralPath $Installer)) {
  throw "MT5 decision panel installer missing: $Installer"
}

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

$demoEnvPath = Resolve-ProjectPath $DemoBridgeEnv
$liveEnvPath = Resolve-ProjectPath $LiveBridgeEnv
foreach ($entry in @(
  [pscustomobject]@{ Mode = "DEMO"; Path = $demoEnvPath },
  [pscustomobject]@{ Mode = "LIVE"; Path = $liveEnvPath }
)) {
  if (-not (Test-Path -LiteralPath $entry.Path)) {
    throw "$($entry.Mode) bridge env not found: $($entry.Path)"
  }
}

Write-Host "PHASE7C_MT5_PANEL_SYNC=START"
Write-Host "PHASE7C_MT5_PANEL_SYNC_ORDER_PERMISSION=NONE"
Write-Host "PHASE7C_MT5_PANEL_SYNC_ACCOUNT_SWITCH=False"
Write-Host "PHASE7C_MT5_PANEL_SYNC_EXECUTION_MUTATION=False"

foreach ($entry in @(
  [pscustomobject]@{ Mode = "DEMO"; Path = $demoEnvPath },
  [pscustomobject]@{ Mode = "LIVE"; Path = $liveEnvPath }
)) {
  Write-Host "PHASE7C_MT5_PANEL_SYNC_INSTALL=START|MODE=$($entry.Mode)"
  $args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $Installer,
    "-BridgeEnv", $entry.Path
  )
  if ($SkipCompile) { $args += "-SkipCompile" }
  & powershell.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "MT5 decision panel install failed for $($entry.Mode). ExitCode=$LASTEXITCODE"
  }
  Write-Host "PHASE7C_MT5_PANEL_SYNC_INSTALL=PASS|MODE=$($entry.Mode)"
}

Write-Host "PHASE7C_MT5_PANEL_SYNC=PASS"
Write-Host "PHASE7C_MT5_PANEL_SYNC_DEMO=PASS"
Write-Host "PHASE7C_MT5_PANEL_SYNC_LIVE=PASS"
Write-Host "PHASE7C_MT5_PANEL_SYNC_ORDER_PERMISSION=NONE"
