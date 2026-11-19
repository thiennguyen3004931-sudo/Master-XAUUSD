$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SwitchPath = Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1"

if (-not (Test-Path -LiteralPath $SwitchPath)) {
  throw "Missing switch script: $SwitchPath"
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($SwitchPath, [ref]$tokens, [ref]$errors)
if (@($errors).Count -gt 0) {
  throw "PowerShell syntax errors in switch script: $(@($errors | ForEach-Object Message) -join ' | ')"
}

$text = Get-Content -LiteralPath $SwitchPath -Raw

function Assert-Text([string]$Pattern, [string]$Message) {
  if ($text -notmatch $Pattern) { throw "Assertion failed: $Message" }
}
function Assert-NotText([string]$Pattern, [string]$Message) {
  if ($text -match $Pattern) { throw "Negative assertion failed: $Message" }
}

Assert-Text 'function\s+Get-BridgePositionCount' "switch must use a dedicated raw position counter"
Assert-Text 'Invoke-WebRequest\s+-Uri\s+"\$base/v1/positions\?symbol=\$escapedSymbol"' "position counter must read raw HTTP content"
Assert-Text '\$raw\s+-eq\s+"\[\]"' "empty JSON array must map explicitly to zero positions"
Assert-Text '\$positionCount\s*=\s*Get-BridgePositionCount\s+"XAUUSD"\s+\$currentEnv' "current-account preflight must use raw position count"
Assert-Text '\$positionCount\s*=\s*Get-BridgePositionCount\s+"XAUUSD"\s+\$EnvInfo' "target bridge preflight must use raw position count"
Assert-NotText '@\(Bridge-Request\s+"/v1/positions\?symbol=XAUUSD"' "switch must not wrap Invoke-RestMethod positions in @()"

Write-Host "PHASE7C_SWITCH_POSITION_ARRAY_SOURCE_TEST=PASS"
