param(
  [string]$WorkDir = ".runtime",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary)) { throw "Phase7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

$WorkDir = Resolve-ProjectPath $WorkDir
$LiveEnvFile = Resolve-ProjectPath $LiveEnvFile
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
if (-not (Test-Path -LiteralPath $LiveEnvFile)) { throw "LIVE env file not found: $LiveEnvFile" }
$LiveEnvFile = (Resolve-Path -LiteralPath $LiveEnvFile).Path

$riskPath = Get-Phase7CRiskProfilePath $WorkDir "LIVE"
if (-not (Test-Path -LiteralPath $riskPath)) {
  Write-Host "PHASE7C_LIVE_RISK_CONFIGURED=False"
  Write-Host "PHASE7C_LIVE_RISK_PROFILE_BINDING=NOT_CONFIGURED"
  Write-Host "PHASE7C_LIVE_RISK_STATUS=NOT_CONFIGURED"
  return
}

try {
  $profile = Get-Content -LiteralPath $riskPath -Raw | ConvertFrom-Json
  $binding = Assert-Phase7CLiveRiskProfileBinding -Profile $profile -LiveEnvFile $LiveEnvFile -Label "Stored LIVE risk profile"

  Write-Host "PHASE7C_LIVE_RISK_CONFIGURED=True"
  Write-Host "PHASE7C_LIVE_RISK_ACCOUNT_MODE=LIVE"
  Write-Host "PHASE7C_LIVE_RISK_ACCOUNT_LOGIN=$($binding.login)"
  Write-Host "PHASE7C_LIVE_RISK_SERVER=$($binding.server)"
  Write-Host "PHASE7C_LIVE_RISK_TREND_FIXED_LOT=$($binding.profile.trendFixedLot)"
  Write-Host "PHASE7C_LIVE_RISK_SIDEWAY_RISK_PERCENT=$($binding.profile.sidewayRiskPercent)"
  Write-Host "PHASE7C_LIVE_RISK_SIDEWAY_MAX_LOT=$($binding.profile.sidewayMaxLot)"
  Write-Host "PHASE7C_LIVE_RISK_APPLIES_TO=NEW_POSITIONS_ONLY"
  Write-Host "PHASE7C_LIVE_RISK_MARTINGALE=False"
  Write-Host "PHASE7C_LIVE_RISK_RECOVERY_ESCALATION=False"
  Write-Host "PHASE7C_LIVE_RISK_PROFILE_BINDING=PASS"
  Write-Host "PHASE7C_LIVE_RISK_STATUS=PASS"
} catch {
  Write-Host "PHASE7C_LIVE_RISK_CONFIGURED=True"
  Write-Host "PHASE7C_LIVE_RISK_PROFILE_BINDING=FAIL"
  Write-Host "PHASE7C_LIVE_RISK_STATUS=FAIL"
  throw
}