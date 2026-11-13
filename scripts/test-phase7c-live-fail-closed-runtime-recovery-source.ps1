$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $PSScriptRoot "recover-phase7c-live-fail-closed-runtime-local.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

Assert-True (Test-Path -LiteralPath $Helper -PathType Leaf) "Missing LIVE fail-closed runtime recovery helper: $Helper"
Assert-PowerShellSyntax $Helper

$text = (Get-Content -LiteralPath $Helper -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

# Exact-source and state gates.
Assert-True ($text.Contains('[Parameter(Mandatory = $true)] [string]$ExpectedCommit')) "recovery helper must require an exact ExpectedCommit"
Assert-True ($text.Contains('requires branch main')) "recovery helper must require branch main"
Assert-True ($text.Contains('requires a clean worktree')) "recovery helper must require a clean worktree"
Assert-True ($text.Contains('exact commit mismatch')) "recovery helper must reject a mismatched source SHA"
Assert-True ($text.Contains('current bot mode PAUSE')) "recovery helper must require fail-closed PAUSE before mutation"
Assert-True ($text.Contains('canonical LIVE ARM=DISARMED')) "recovery helper must require canonical LIVE ARM=DISARMED before mutation"
Assert-True ($text.Contains('requires configured LIVE account mode')) "recovery helper must require configured LIVE account mode"
Assert-True ($text.Contains('requires zero XAUUSD positions')) "recovery helper must fail closed if XAUUSD positions exist"
Assert-True ($text.Contains('requires zero pending XAUUSD orders')) "recovery helper must fail closed if pending XAUUSD orders exist"

# Recovery order must be STOP -> START -> ARM, never AUTO.
$stopIndex = $text.IndexOf('"/api/v1/phase7c/lifecycle/stop"', [System.StringComparison]::Ordinal)
$startIndex = $text.IndexOf('"/api/v1/phase7c/lifecycle/start"', [System.StringComparison]::Ordinal)
$armIndex = $text.IndexOf('Invoke-LiveArmAction "ARM_LIVE"', [System.StringComparison]::Ordinal)
Assert-True ($stopIndex -ge 0) "recovery helper must call lifecycle STOP"
Assert-True ($startIndex -gt $stopIndex) "recovery helper must START only after STOP"
Assert-True ($armIndex -gt $startIndex) "recovery helper must ARM only after START"
Assert-True (-not $text.Contains('@{ mode = "AUTO"')) "recovery helper must never set AUTO"

# Runtime replacement and Bridge identity guards.
Assert-True ($text.Contains('Controlled executor recovery did not replace all required runtime PIDs')) "recovery helper must require supervisor/trend/sideway PID replacement"
Assert-True ($text.Contains('bridge session changed')) "recovery helper must fail if Bridge session changes"
Assert-True ($text.Contains('BRIDGE_RESTART=NONE')) "recovery helper must explicitly preserve Bridge"
Assert-True ($text.Contains('LIVE_TEST_ORDER=NONE')) "recovery helper must explicitly forbid LIVE test orders"
Assert-True ($text.Contains('ORDER_MUTATION=NONE')) "recovery helper must explicitly forbid order mutation"

# Final success stays PAUSE + ARMED for manual Web AUTO only.
Assert-True ($text.Contains('FINAL_MODE=PAUSE')) "recovery helper success must remain PAUSE"
Assert-True ($text.Contains('FINAL_ARM=ARMED')) "recovery helper success must restore canonical ARM"
Assert-True ($text.Contains('NEXT_ACTION=MANUAL_WEB_AUTO_ONLY')) "recovery helper must hand final AUTO transition back to Web Control Center"

# Any failed mutation must try to restore fail-closed PAUSE + DISARMED.
Assert-True ($text.Contains('fail-closed-recovery')) "recovery helper catch path must persist PAUSE with a dedicated fail-closed source"
Assert-True ($text.Contains('Invoke-LiveArmAction "DISARM_LIVE"')) "recovery helper catch path must best-effort canonical DISARM"
Assert-True ($text.Contains('FAIL_CLOSED_MODE=PAUSE')) "recovery helper must report fail-closed PAUSE"
Assert-True ($text.Contains('FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT')) "recovery helper must report fail-closed DISARM best effort"

Write-Host "PHASE7C_LIVE_FAIL_CLOSED_RUNTIME_RECOVERY_SOURCE_TEST=PASS"
