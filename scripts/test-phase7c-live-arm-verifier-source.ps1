$ErrorActionPreference = "Stop"
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-live-arm-local.ps1"

if (-not (Test-Path -LiteralPath $Verifier)) {
  throw "Required LIVE ARM verifier source file not found: $Verifier"
}

$source = Get-Content -LiteralPath $Verifier -Raw

function Assert-Contains([string]$Text, [string]$Needle, [string]$Label) {
  if (-not $Text.Contains($Needle)) { throw "Missing LIVE ARM verifier assertion: $Label" }
}

function Assert-NotContains([string]$Text, [string]$Needle, [string]$Label) {
  if ($Text.Contains($Needle)) { throw "Forbidden LIVE ARM verifier side effect present: $Label" }
}

# Canonical account state must keep file and API schemas distinct.
Assert-Contains $source '$AccountFile.accountMode' 'file accountMode schema'
Assert-Contains $source '$AccountApi.state.accountMode' 'API accountMode schema'
Assert-Contains $source '$AccountApi.state.valid' 'API valid schema'
Assert-Contains $source 'ACCOUNT_FILE_API_MATCH=PASS' 'file/API consistency proof'

# Safety booleans must fail closed even if an API field drifts from JSON bool to string.
Assert-Contains $source 'function ConvertTo-StrictBoolean' 'strict boolean parser'
Assert-Contains $source '[bool]::TryParse' 'string boolean parser'
Assert-NotContains $source '[bool]$AccountApi.state.valid' 'unsafe initial valid cast'
Assert-NotContains $source '[bool]$FinalAccount.state.valid' 'unsafe final valid cast'
Assert-NotContains $source '[bool]$Life.' 'unsafe lifecycle boolean cast'
Assert-NotContains $source '[bool]$Health.' 'unsafe health boolean cast'
Assert-NotContains $source '[bool]$FinalLife.' 'unsafe final lifecycle boolean cast'
Assert-NotContains $source '[bool]$FinalHealth.' 'unsafe final health boolean cast'

# Git cleanliness is a safety gate only if git status itself succeeded.
Assert-Contains $source 'function Get-GitStatusLines' 'git status fail-closed helper'
Assert-Contains $source 'git -C $ProjectRoot status --porcelain' 'canonical git status command'
Assert-Contains $source 'Git status failed.' 'git status exit-code failure'

# Runtime must remain LIVE selected but fail closed and paused.
Assert-Contains $source '/api/v1/phase7c/account-mode' 'canonical account GET'
Assert-Contains $source '/api/v1/phase7c/bot-mode' 'bot-mode GET'
Assert-Contains $source '/api/v1/phase7c/lifecycle' 'lifecycle GET'
Assert-Contains $source 'phase7c-live-arm.json' 'canonical arm path'
Assert-Contains $source 'LIVE_RECONFIRM=PASS' 'LIVE paused/flat reconfirmation'
Assert-Contains $source 'CANONICAL_ARM_BINDING=PASS' 'bridge arm path binding proof'
Assert-Contains $source 'BRIDGE_RUNTIME_FAIL_CLOSED=PASS' 'runtime fail-closed proof'
Assert-Contains $source 'LIVE_EXECUTION_ARMED=' 'runtime arm state output'
Assert-Contains $source 'ARM_FILE_MISSING' 'missing arm reason requirement'

# Regression must use the existing fake-MT5 test suite and judge native process by exit code.
Assert-Contains $source 'test_live_arm.py' 'fake MT5 regression target'
Assert-Contains $source 'class RealFakeMt5' 'fake MT5 source contract'
Assert-Contains $source 'tempfile.TemporaryDirectory' 'temporary arm storage contract'
Assert-Contains $source '$ErrorActionPreference = "Continue"' 'native unittest stderr compatibility'
Assert-Contains $source '$LASTEXITCODE' 'native unittest exit-code gate'
Assert-Contains $source 'LIVE_ARM_REGRESSION_TESTS=PASS' 'regression completion marker'
Assert-Contains $source '$ExpectedLiveArmTests' 'dynamic expected LIVE ARM test count'
Assert-Contains $source '[regex]::Matches($TestSource' 'test-source method discovery'
Assert-Contains $source '$RanMatch' 'unittest summary count parser'
Assert-Contains $source '$RanCount -ne $ExpectedLiveArmTests' 'executed test count equality gate'
Assert-Contains $source 'DISCOVERED_LIVE_ARM_TEST_COUNT=' 'discovered test count evidence'
Assert-Contains $source 'LIVE_ARM_TEST_COUNT=$RanCount' 'executed test count evidence'
Assert-NotContains $source "Ran\\s+4\\s+tests" 'hard-coded four-test summary gate'
Assert-NotContains $source 'LIVE_ARM_TEST_COUNT=4' 'hard-coded four-test count evidence'
Assert-NotContains $source 'Expected exactly 4 LIVE ARM regression tests.' 'hard-coded four-test failure message'

# Mutation boundary must be verified from source.
Assert-Contains $source 'self\._require_trading\(\)' 'mutation guard source scan'
Assert-Contains $source 'super()._require_trading()' 'base trading guard proof'
Assert-Contains $source 'decision = self._live_arm_decision(account)' 'dynamic LIVE arm decision proof'
Assert-Contains $source '"LIVE_EXECUTION_DISARMED"' 'LIVE disarm block proof'
Assert-Contains $source '"ACCOUNT_MODE_MISMATCH"' 'account mismatch block proof'
Assert-Contains $source 'EXECUTION_BOUNDARY_SOURCE=PASS' 'source boundary completion marker'

# Final state must prove that the verifier itself did not mutate broker/runtime/git state.
Assert-Contains $source 'POST_TEST_LIVE_SAFETY=PASS' 'post-test LIVE safety proof'
Assert-Contains $source 'NO_LIVE_ARM_CREATED=PASS' 'no arm creation proof'
Assert-Contains $source 'NO_BROKER_MUTATION=PASS' 'no broker mutation proof'
Assert-Contains $source 'WORKTREE_CLEAN=PASS' 'clean worktree proof'
Assert-Contains $source 'PHASE7C_LIVE_ARM_VERIFY_STATUS=PASS' 'canonical final marker'

# This verifier is audit-only. Mutation primitives are forbidden.
Assert-NotContains $source '-Method Post' 'POST request'
Assert-NotContains $source '-Method Put' 'PUT request'
Assert-NotContains $source '-Method Patch' 'PATCH request'
Assert-NotContains $source '-Method Delete' 'DELETE request'
Assert-NotContains $source 'Clear-Phase7CLiveArmState' 'arm state clearing'
Assert-NotContains $source 'arm-phase7c-live-local.ps1' 'LIVE arm invocation'
Assert-NotContains $source 'switch-phase7c-account-mode-local.ps1' 'account switch invocation'
Assert-NotContains $source 'Start-ScheduledTask' 'scheduled task start'
Assert-NotContains $source 'Stop-ScheduledTask' 'scheduled task stop'
Assert-NotContains $source 'New-ScheduledTask' 'scheduled task creation'
Assert-NotContains $source 'Set-Content' 'file mutation via Set-Content'
Assert-NotContains $source 'Out-File' 'file mutation via Out-File'
Assert-NotContains $source 'Remove-Item' 'file deletion'
Assert-NotContains $source 'order_send' 'direct MT5 mutation'

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Verifier, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "PowerShell parse failed: $($errors -join '; ')" }

Write-Host "PHASE7C_LIVE_ARM_VERIFIER_SOURCE_TEST=PASS"
