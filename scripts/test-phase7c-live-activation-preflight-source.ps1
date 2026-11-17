$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Preflight = Join-Path $PSScriptRoot "preflight-phase7c-live-activation-local.ps1"
$Probe = Join-Path $PSScriptRoot "probe-phase7c-live-readonly-local.ps1"

foreach ($path in @($Preflight, $Probe)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required source file not found: $path" }
}

$source = Get-Content -LiteralPath $Preflight -Raw

function Assert-Contains([string]$Text, [string]$Needle, [string]$Label) {
  if (-not $Text.Contains($Needle)) { throw "Missing safety assertion: $Label" }
}

function Assert-NotContains([string]$Text, [string]$Needle, [string]$Label) {
  if ($Text.Contains($Needle)) { throw "Forbidden activation side effect present: $Label" }
}

Assert-Contains $source 'selected runtime to remain DEMO' 'DEMO selection requirement'
Assert-Contains $source 'bot mode PAUSE' 'PAUSE requirement'
Assert-Contains $source 'MT5_TRADING_ENABLED=false until explicit operator approval' 'LIVE trading disabled requirement'
Assert-Contains $source 'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=false until explicit operator approval' 'compatibility gate disabled requirement'
Assert-Contains $source 'Assert-Phase7CLiveRiskProfileBinding' 'exact LIVE risk binding'
Assert-Contains $source 'DEMO and LIVE terminal64.exe paths must remain separate' 'dual-terminal requirement'
Assert-Contains $source '/v1/positions?symbol=XAUUSD' 'DEMO positions check'
Assert-Contains $source '/v1/orders?symbol=XAUUSD' 'DEMO pending orders check'
Assert-Contains $source 'phase7b-live-forward\phase7b-demo-state.json' 'LIVE Trend flat-state check'
Assert-Contains $source 'phase7c-sideway-live-forward\phase7c-sideway-state.json' 'LIVE Sideway flat-state check'
Assert-Contains $source 'phase7c-execution.lock' 'execution lock check'
Assert-Contains $source 'run-phase7c-account-bridge-task-runner-local.ps1' 'bridge task ownership proof'
Assert-Contains $source 'run-phase7c-executor-task-runner-local.ps1' 'executor task ownership proof'
Assert-Contains $source '& $ReadOnlyProbe' 'isolated read-only LIVE proof'
Assert-Contains $source 'PHASE7C_LIVE_ACTIVATION_PREFLIGHT_NEXT=EXPLICIT_OPERATOR_APPROVAL_REQUIRED' 'explicit approval boundary'

Assert-NotContains $source 'switch-phase7c-account-mode-local.ps1' 'account switcher invocation'
Assert-NotContains $source 'arm-phase7c-live-local.ps1' 'LIVE arm invocation'
Assert-NotContains $source 'Start-ScheduledTask' 'scheduled task start'
Assert-NotContains $source 'Stop-ScheduledTask' 'scheduled task stop'
Assert-NotContains $source 'MT5_TRADING_ENABLED" "true' 'enable MT5 trading'
Assert-NotContains $source 'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "true' 'enable compatibility gate'
Assert-NotContains $source 'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "1' 'enable compatibility gate numeric'
Assert-NotContains $source 'order_send' 'direct MT5 mutation'
Assert-NotContains $source 'Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Post' 'bot-mode mutation'

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Preflight, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "PowerShell parse failed: $($errors -join '; ')" }

Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_SOURCE_TEST=PASS"
