param(
  [string]$WorkDir = ".runtime",
  [string]$Reason = "operator-disarm"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary)) { throw "Phase7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason $Reason
Write-Host "PHASE7C_LIVE_ARM_STATUS=DISARMED"
