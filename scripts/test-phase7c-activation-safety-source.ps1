$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ActivationPath = Join-Path $ProjectRoot "scripts\activate-phase7c-local.ps1"
if (-not (Test-Path -LiteralPath $ActivationPath)) { throw "Missing activation script: $ActivationPath" }
$Text = Get-Content -LiteralPath $ActivationPath -Raw

function Assert-Text([string]$Pattern, [string]$Message) {
  if ($Text -notmatch $Pattern) { throw "Phase7C activation safety regression failed: $Message" }
}

function Assert-NotText([string]$Pattern, [string]$Message) {
  if ($Text -match $Pattern) { throw "Phase7C activation safety negative assertion failed: $Message" }
}

# Empty broker JSON arrays can become $null through Invoke-RestMethod in Windows
# PowerShell 5.1. The activation path must filter null before counting positions.
Assert-Text '\$positionsResponse\s*=\s*Invoke-RestMethod[^\r\n]+/v1/positions\?symbol=XAUUSD' "activation must query broker positions directly"
Assert-Text '\$positions\s*=\s*@\(\$positionsResponse\s*\|\s*Where-Object\s*\{\s*\$null\s+-ne\s*\$_\s*\}\)' "activation must filter null broker position responses before Count"
Assert-NotText '\$positions\s*=\s*@\(\$positionsResponse\)' "activation must not wrap a possible null position response directly"

# Auto Lot activation safety must follow the current read-only account-risk
# contract and must not depend on the retired phase7bFixedVolumeUnchanged field.
Assert-Text '\[string\]\$risk\.source\s+-ne\s+"MT5_ACCOUNT_READ_ONLY"' "activation must require the canonical read-only account-risk source"
Assert-Text '\[string\]\$risk\.safety\.mode\s+-ne\s+"ACCOUNT_RISK_PREVIEW"' "activation must require account-risk preview mode"
Assert-Text '\$risk\.safety\.executionMutation\s+-ne\s+\$false' "activation must require executionMutation=false"
Assert-Text '\[string\]\$risk\.safety\.orderPermission\s+-ne\s+"NONE"' "activation must require orderPermission=NONE"
Assert-Text '\[string\]\$risk\.safety\.accountMode\s+-ne\s+"DEMO"' "activation must require DEMO account mode"
Assert-Text '\$risk\.safety\.liveExecutionEnabled\s+-ne\s+\$false' "activation must require LIVE execution disabled"
Assert-Text '\$risk\.safety\.accountGuardValid\s+-ne\s+\$true' "activation must require valid account guard"
Assert-NotText 'phase7bFixedVolumeUnchanged' "activation must not reference retired Auto Lot safety field"

# Preserve observability for the operator and keep MT5 panel read-only.
Assert-Text 'PHASE7C_ACTIVATE_AUTO_LOT_SOURCE=' "activation must print Auto Lot source"
Assert-Text 'PHASE7C_ACTIVATE_AUTO_LOT_ORDER_PERMISSION=' "activation must print Auto Lot order permission"
Assert-Text 'PHASE7C_ACTIVATE_MT5_PANEL_ORDER_PERMISSION=' "activation must print MT5 panel permission"

$Tokens = $null
$Errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  $ActivationPath,
  [ref]$Tokens,
  [ref]$Errors
) | Out-Null
if ($Errors.Count -gt 0) {
  $Errors | Format-List
  throw "Activation PowerShell syntax validation failed."
}

Write-Host "PHASE7C_ACTIVATION_SAFETY_SOURCE_TEST=PASS"
