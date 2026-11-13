$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Helper = Join-Path $PSScriptRoot "deploy-phase7c-live-canonical-recovery-runtime-local.ps1"

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

Assert-True (Test-Path -LiteralPath $Helper -PathType Leaf) "Missing LIVE canonical Daily Recovery runtime deploy helper: $Helper"
Assert-PowerShellSyntax $Helper

$text = (Get-Content -LiteralPath $Helper -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

# Exact source and account guards.
Assert-True ($text.Contains('[Parameter(Mandatory = $true)] [string]$ExpectedCommit')) "deploy helper must require exact ExpectedCommit"
Assert-True ($text.Contains('requires branch main')) "deploy helper must require branch main"
Assert-True ($text.Contains('requires a clean worktree')) "deploy helper must require clean worktree"
Assert-True ($text.Contains('exact commit mismatch')) "deploy helper must reject mismatched source SHA"
Assert-True ($text.Contains('requires configured LIVE account mode')) "deploy helper must require configured LIVE account mode"
Assert-True ($text.Contains('requires zero XAUUSD positions')) "deploy helper must require zero XAUUSD positions"
Assert-True ($text.Contains('requires zero pending XAUUSD orders')) "deploy helper must require zero pending XAUUSD orders"

# Deployment must freeze execution before touching lifecycle.
$pauseIndex = $text.IndexOf('mode = "PAUSE"', [System.StringComparison]::Ordinal)
$disarmIndex = $text.IndexOf('Invoke-LiveArmAction "DISARM_LIVE"', [System.StringComparison]::Ordinal)
$stopIndex = $text.IndexOf('"/api/v1/phase7c/lifecycle/stop"', [System.StringComparison]::Ordinal)
$startIndex = $text.IndexOf('"/api/v1/phase7c/lifecycle/start"', [System.StringComparison]::Ordinal)
$armIndex = $text.IndexOf('Invoke-LiveArmAction "ARM_LIVE"', [System.StringComparison]::Ordinal)
Assert-True ($pauseIndex -ge 0) "deploy helper must set PAUSE"
Assert-True ($disarmIndex -gt $pauseIndex) "deploy helper must DISARM only after PAUSE"
Assert-True ($stopIndex -gt $disarmIndex) "deploy helper must STOP only after DISARM"
Assert-True ($startIndex -gt $stopIndex) "deploy helper must START only after STOP"
Assert-True ($armIndex -gt $startIndex) "deploy helper must ARM only after START"

# Runtime replacement and Bridge preservation.
Assert-True ($text.Contains('did not replace all required runtime PIDs')) "deploy helper must require supervisor/trend/sideway PID replacement"
Assert-True ($text.Contains('bridge session changed')) "deploy helper must fail if Bridge session changes"
Assert-True ($text.Contains('BRIDGE_RESTART=NONE')) "deploy helper must explicitly preserve Bridge"
Assert-True ($text.Contains('WEB_API_RESTART=NONE')) "deploy helper must explicitly preserve Web/API"
Assert-True ($text.Contains('LIVE_TEST_ORDER=NONE')) "deploy helper must explicitly forbid LIVE test order"
Assert-True ($text.Contains('ORDER_MUTATION=NONE')) "deploy helper must explicitly forbid order mutation"

# Exact canonical source must be present on deployed main.
Assert-True ($text.Contains('phase7c-canonical-daily-recovery-executor.mjs')) "deploy helper must verify canonical Daily Recovery helper source exists"
Assert-True ($text.Contains('CANONICAL_DAILY_RECOVERY_SOURCE=PASS')) "deploy helper must report canonical source verification"

# Success remains fail-safe until operator explicitly resumes Web AUTO.
Assert-True ($text.Contains('FINAL_MODE=PAUSE')) "deploy helper success must remain PAUSE"
Assert-True ($text.Contains('FINAL_ARM=ARMED')) "deploy helper success must restore ARM"
Assert-True ($text.Contains('NEXT_ACTION=MANUAL_WEB_AUTO_ONLY')) "deploy helper must leave AUTO to Web Control Center"
Assert-True (-not $text.Contains('@{ mode = "AUTO"')) "deploy helper must never auto-enable AUTO"

# Any failed mutation must attempt PAUSE + DISARM fail-closed recovery.
Assert-True ($text.Contains('runtime-deploy-fail-closed')) "deploy helper catch path must persist PAUSE"
Assert-True ($text.Contains('FAIL_CLOSED_MODE=PAUSE')) "deploy helper must report fail-closed PAUSE"
Assert-True ($text.Contains('FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT')) "deploy helper must report fail-closed DISARM best effort"

Write-Host "PHASE7C_LIVE_CANONICAL_RECOVERY_RUNTIME_DEPLOY_SOURCE_TEST=PASS"
