$ErrorActionPreference = "Stop"
# Observation-only contract: health, positions, and pending-order reads must never initiate MT5 reconnect.
$InspectorPath = Join-Path $PSScriptRoot "inspect-phase7c-live-runtime-local.ps1"

if (-not (Test-Path -LiteralPath $InspectorPath)) {
  throw "LIVE runtime inspector source not found: $InspectorPath"
}

$source = Get-Content -LiteralPath $InspectorPath -Raw

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($source -notmatch $Pattern) { throw "Missing LIVE runtime inspector contract: $Label" }
}

function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($source -match $Pattern) { throw "Unsafe LIVE runtime inspector pattern found: $Label" }
}

Assert-Contains 'phase7c-account-mode\.json' 'canonical selected account state is observed'
Assert-Contains 'phase7c-live-arm\.json' 'canonical LIVE arm record is observed'
Assert-Contains '/api/v1/phase7c/bot-mode' 'bot mode is observed through control API'
Assert-Contains 'Invoke-RestMethod[^\r\n]*-Method\s+Get' 'REST observations are explicit GET'
Assert-Contains '/health\?reconnect=false' 'bridge health observation explicitly disables reconnect'
Assert-Contains '/v1/positions\?symbol=\$escapedSymbol&reconnect=false' 'positions observation explicitly disables reconnect'
Assert-Contains '/v1/orders\?symbol=\$escapedSymbol&reconnect=false' 'pending orders observation explicitly disables reconnect'
Assert-NotContains '"\$bridgeBaseUrl/health"' 'bridge health observation must not use reconnecting default'
Assert-NotContains '"\$bridgeBaseUrl/account"' 'unsupported Bridge /account route'
Assert-Contains 'PHASE7C_LIVE_RUNTIME_INSPECTOR_OBSERVATION_ONLY=TRUE' 'observation-only marker'
Assert-Contains 'PHASE7C_LIVE_RUNTIME_INSPECTOR_RESULT=PASS' 'explicit PASS marker'
Assert-Contains 'PHASE7C_LIVE_RUNTIME_INSPECTOR_RESULT=FAIL' 'explicit FAIL marker'
Assert-Contains 'ExpectedRuntime' 'runtime expectation is an assertion only'
Assert-Contains 'ExpectedMode' 'mode expectation is an assertion only'
Assert-Contains 'RequireArmed' 'armed expectation is an assertion only'

$forbidden = @(
  @{ pattern = '(?i)-Method\s+(Post|Patch|Put|Delete)'; label = 'HTTP mutation method' },
  @{ pattern = '(?i)\bRemove-Item\b'; label = 'file deletion' },
  @{ pattern = '(?i)\bSet-Content\b'; label = 'file write' },
  @{ pattern = '(?i)\bAdd-Content\b'; label = 'file append' },
  @{ pattern = '(?i)\bOut-File\b'; label = 'file output' },
  @{ pattern = '(?i)\bNew-Item\b'; label = 'filesystem creation' },
  @{ pattern = '(?i)\bStart-Process\b'; label = 'process start' },
  @{ pattern = '(?i)\bStop-Process\b'; label = 'process stop' },
  @{ pattern = '(?i)\btaskkill(?:\.exe)?\b'; label = 'taskkill' },
  @{ pattern = '(?i)\b(Start|Stop|Restart)-Service\b'; label = 'service mutation' },
  @{ pattern = '(?i)\b(Start|Stop)-ScheduledTask\b'; label = 'scheduled-task mutation' },
  @{ pattern = '(?i)\bClear-Phase7CLiveArmState\b'; label = 'LIVE arm clear' },
  @{ pattern = '(?i)\bWrite-Phase7CAccountJsonAtomic\b'; label = 'account state write' },
  @{ pattern = '(?i)switch-phase7c-account-mode-local\.ps1'; label = 'account switch invocation' },
  @{ pattern = '(?i)arm-phase7c-live-local\.ps1'; label = 'LIVE arm invocation' },
  @{ pattern = '(?i)probe-phase7c-live-readonly-local\.ps1'; label = 'legacy mutable probe invocation' },
  @{ pattern = '(?i)/v1/(order|orders)/(submit|modify|close|cancel)'; label = 'order mutation route' }
)
foreach ($rule in $forbidden) { Assert-NotContains $rule.pattern $rule.label }

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $InspectorPath), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
  throw "PowerShell parse failed for LIVE runtime inspector: $($errors -join '; ')"
}

Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_SOURCE_TEST=PASS"
