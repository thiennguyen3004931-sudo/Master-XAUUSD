$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Verifier = Join-Path $PSScriptRoot 'verify-phase7c-executors-local.ps1'
if (-not (Test-Path -LiteralPath $Verifier -PathType Leaf)) { throw "Missing verifier: $Verifier" }

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-NoDrift { return }

# Production incident regression: deploy inherited StrictMode while verifier task drift was empty.
# Reproduce the failure mode: the array expression inside the if branch is emitted to the
# statement pipeline and becomes $null when it contains no items.
$legacyFailed = $false
try {
  $legacy = if ($true) { @(Get-NoDrift) } else { @() }
  [void]$legacy.Count
} catch {
  $legacyFailed = $_.Exception.Message -match 'Count'
}
Assert-True $legacyFailed 'Regression setup did not reproduce the inherited StrictMode .Count failure.'

# The whole conditional must be captured by an outer array expression.
$safe = @(if ($true) { Get-NoDrift } else { @() })
Assert-True ($safe.Count -eq 0) 'Outer array capture must preserve a zero-length array under StrictMode.'

$source = Get-Content -LiteralPath $Verifier -Raw
Assert-True ($source.Contains('$taskDrift = @(if ($startupRunner) { Get-Phase7CExecutorTaskDrift -Task $task } else { @() })')) `
  'Verifier must preserve taskDrift as an array when Scheduled Task drift is empty under inherited StrictMode.'

Write-Host 'PHASE7C_VERIFIER_STRICTMODE_ARRAY_TEST=PASS'
