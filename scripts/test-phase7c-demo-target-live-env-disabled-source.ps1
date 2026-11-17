$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SwitchPath = Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1"

if (-not (Test-Path -LiteralPath $SwitchPath)) {
  throw "Missing account switch script: $SwitchPath"
}

$text = Get-Content -LiteralPath $SwitchPath -Raw

if ($text -notmatch '\$liveEnv\s*=\s*\$null\s*\r?\nif\s*\(\$TargetMode\s+-eq\s+"LIVE"\)') {
  throw "DEMO target must not validate the LIVE env as a prerequisite."
}

if ($text -notmatch 'Assert-Phase7CAccountEnv\s+-EnvFile\s+\$LiveEnvFile\s+-AccountMode\s+"LIVE"\s+-RequireTrading') {
  throw "LIVE target must still require a trading-enabled LIVE env."
}

if ($text -match 'if\s*\(Test-Path\s+-LiteralPath\s+\$LiveEnvFile\)\s*\{\s*\r?\n\s*\$liveEnv\s*=\s*Assert-Phase7CAccountEnv[^\r\n]*-RequireTrading') {
  throw "Regression detected: merely having a disabled LIVE env must not block a DEMO migration."
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($SwitchPath, [ref]$tokens, [ref]$errors)
if (@($errors).Count -gt 0) {
  throw "PowerShell parse failed: $(@($errors | ForEach-Object Message) -join ' | ')"
}

Write-Host "PHASE7C_DEMO_TARGET_DISABLED_LIVE_ENV_SOURCE_TEST=PASS"
