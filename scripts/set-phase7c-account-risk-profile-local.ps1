param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [Parameter(Mandatory = $true)] [ValidateSet("DEMO", "LIVE")] [string]$AccountMode,
  [Parameter(Mandatory = $true)] [double]$TrendFixedVolume,
  [Parameter(Mandatory = $true)] [double]$SidewayRiskPercent,
  [Parameter(Mandatory = $true)] [double]$SidewayMaxLot
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Library = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $Library)) { throw "Phase7C account mode library not found: $Library" }
. $Library

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$mode = ConvertTo-Phase7CAccountMode $AccountMode

$profile = [pscustomobject]@{
  version = 1
  accountMode = $mode
  trendFixedLot = $TrendFixedVolume
  sidewayRiskPercent = $SidewayRiskPercent
  sidewayMaxLot = $SidewayMaxLot
  appliesTo = "NEW_POSITIONS_ONLY"
  martingale = $false
  recoveryLotEscalation = $false
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = "set-phase7c-account-risk-profile-local"
}
[void](Assert-Phase7CRiskProfile $profile "$mode risk profile")

$profilePath = Get-Phase7CRiskProfilePath $WorkDir $mode
Write-Phase7CAccountJsonAtomic -Path $profilePath -Value $profile -Depth 6

Write-Host "PHASE7C_RISK_PROFILE_MODE=$mode"
Write-Host "PHASE7C_RISK_PROFILE_PATH=$profilePath"
Write-Host "PHASE7C_RISK_PROFILE_TREND_FIXED_LOT=$TrendFixedVolume"
Write-Host "PHASE7C_RISK_PROFILE_SIDEWAY_RISK_PERCENT=$SidewayRiskPercent"
Write-Host "PHASE7C_RISK_PROFILE_SIDEWAY_MAX_LOT=$SidewayMaxLot"
Write-Host "PHASE7C_RISK_PROFILE_STATUS=PASS"
