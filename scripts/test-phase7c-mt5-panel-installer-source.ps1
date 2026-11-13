$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Installer = Join-Path $ProjectRoot "scripts\install-phase7c-mt5-decision-panel-local.ps1"

if (-not (Test-Path -LiteralPath $Installer)) {
  throw "Installer source not found: $Installer"
}

$Source = Get-Content -LiteralPath $Installer -Raw
[void][scriptblock]::Create($Source)

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($Source -notmatch $Pattern) {
    throw "Missing installer regression marker: $Label"
  }
}

function Assert-LiteralContains([string]$Needle, [string]$Label) {
  if ($Source.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing installer literal marker: $Label"
  }
}

function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($Source -match $Pattern) {
    throw "Forbidden installer regression pattern detected: $Label"
  }
}

Assert-Contains 'function\s+Normalize-PathForCompare' 'path normalization helper'
Assert-Contains '\$terminalInstallDir\s*=\s*Split-Path\s+-Parent\s+\$TerminalPath' 'terminal install directory'
Assert-Contains '\$terminalPathNormalized\s*=\s*Normalize-PathForCompare\s+\$TerminalPath' 'terminal exe normalization'
Assert-Contains '\$terminalDirNormalized\s*=\s*Normalize-PathForCompare\s+\$terminalInstallDir' 'terminal directory normalization'
Assert-Contains '\$originNormalized\s*=\s*Normalize-PathForCompare\s+\$originPath' 'origin normalization'
Assert-Contains '\$matchesTerminalExe\s*=\s*\[string\]::Equals' 'legacy exe origin compatibility'
Assert-Contains '\$matchesInstallDir\s*=\s*\[string\]::Equals' 'install directory origin compatibility'
Assert-Contains 'if\s*\(\$matchesTerminalExe\s+-or\s+\$matchesInstallDir\)' 'either origin form accepted'
Assert-Contains '\$matches\s*=\s*@\(\$matches\s*\|\s*Sort-Object\s+-Unique\)' 'unique data folder match'
Assert-Contains 'PHASE7C_MT5_PANEL_DATA_PATH_AUTODETECT=PASS' 'autodetect success marker'
Assert-LiteralContains "('/compile:`"{0}`"' -f `$Destination)" 'MetaEditor compile quoting'
Assert-LiteralContains "('/log:`"{0}`"' -f `$CompileLog)" 'MetaEditor log quoting'
Assert-NotContains '\[string\]::Equals\(\s*\$originPath\s*,\s*\$TerminalPath' 'exact-only origin comparison'

# Structured entry checklist is now the canonical compact WAITING contract.
Assert-LiteralContains 'FirstEntryBlocker' 'structured blocker selector'
Assert-LiteralContains 'DrawEntryCheckSummary' 'structured blocker renderer'
Assert-LiteralContains 'prefix + "Check" + suffix + "Status"' 'entry check status binding'
Assert-LiteralContains 'prefix + "Check" + suffix + "Label"' 'entry check label binding'
Assert-LiteralContains 'prefix + "Check" + suffix + "Actual"' 'entry check actual binding'
Assert-LiteralContains 'trendCheck1Status=' 'Trend checklist API contract'
Assert-LiteralContains 'sidewayCheck1Status=' 'Sideway checklist API contract'
Assert-NotContains 'Field\(payload,\s*"trendWaitReason1"\)' 'stale direct Trend wait reason binding'
Assert-NotContains 'Field\(payload,\s*"sidewayWaitReason1"\)' 'stale direct Sideway wait reason binding'

Write-Host "PHASE7C_MT5_PANEL_INSTALLER_SOURCE_TEST=PASS"
