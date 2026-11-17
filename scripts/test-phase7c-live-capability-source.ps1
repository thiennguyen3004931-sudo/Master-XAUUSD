$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $PSScriptRoot "enable-phase7c-live-capability-local.ps1"

if (-not (Test-Path -LiteralPath $Target)) { throw "LIVE capability script not found: $Target" }

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "PowerShell parse failed: $($errors -join '; ')" }

$source = Get-Content -LiteralPath $Target -Raw

function Assert-Contains([string]$Pattern, [string]$Message) {
  if ($source -notmatch $Pattern) { throw $Message }
}
function Assert-NotContains([string]$Pattern, [string]$Message) {
  if ($source -match $Pattern) { throw $Message }
}

Assert-Contains '\[switch\]\$ConfirmEnableLiveCapability' "Explicit capability confirmation switch is missing."
Assert-Contains 'if \(-not \$ConfirmEnableLiveCapability\)' "Capability confirmation is not fail-closed."
Assert-Contains 'preflight-phase7c-live-activation-local\.ps1' "Canonical LIVE activation preflight is not required."
Assert-Contains '& \$Preflight' "Capability script does not execute preflight before mutation."
Assert-Contains 'Assert-Phase7CLiveRiskProfileBinding' "LIVE risk/profile binding recheck is missing."
Assert-Contains 'MT5_TRADING_ENABLED\" \"true' "MT5 trading capability is not explicitly written true."
Assert-Contains 'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING\" \"1' "LIVE compatibility capability is not explicitly written true."
Assert-Contains 'Write-LiveCapabilityAtomic' "Capability update is not atomic."
Assert-Contains 'Clear-Phase7CLiveArmState.+live-capability-enable' "LIVE arm is not cleared before capability update."
Assert-Contains 'Clear-Phase7CLiveArmState.+live-capability-enabled' "LIVE arm is not cleared after capability update."
Assert-Contains 'PHASE7C_LIVE_CAPABILITY_SELECTED_RUNTIME=DEMO' "Final DEMO selection marker is missing."
Assert-Contains 'PHASE7C_LIVE_CAPABILITY_BOT_MODE=PAUSE' "Final PAUSE marker is missing."
Assert-Contains 'PHASE7C_LIVE_CAPABILITY_DEMO_SESSION_UNCHANGED=PASS' "DEMO bridge session preservation is not verified."
Assert-Contains 'PHASE7C_LIVE_CAPABILITY_LIVE_ARM=DISARMED' "Final DISARMED marker is missing."
Assert-Contains 'EXPLICIT_LIVE_ACCOUNT_SWITCH_APPROVAL_REQUIRED' "Separate account-switch approval boundary is missing."

Assert-NotContains 'switch-phase7c-account-mode-local\.ps1' "Capability helper must not invoke the account switcher."
Assert-NotContains 'arm-phase7c-live-local\.ps1' "Capability helper must not invoke LIVE arm."
Assert-NotContains 'Start-ScheduledTask|Stop-ScheduledTask' "Capability helper must not start/stop Scheduled Tasks."
Assert-NotContains 'order_send|/v1/orders/place|/v1/positions/close|/v1/positions/modify' "Capability helper must not contain broker mutation paths."

$preflightIndex = $source.IndexOf('& $Preflight')
# LastIndexOf targets the actual invocation, not the earlier function declaration.
$writeIndex = $source.LastIndexOf('Write-LiveCapabilityAtomic')
if ($preflightIndex -lt 0 -or $writeIndex -lt 0 -or $preflightIndex -gt $writeIndex) {
  throw "Activation preflight must occur before capability mutation."
}

Write-Host "PHASE7C_LIVE_CAPABILITY_SOURCE_TEST=PASS"
