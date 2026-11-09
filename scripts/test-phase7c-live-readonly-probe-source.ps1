$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProbePath = Join-Path $PSScriptRoot "probe-phase7c-live-readonly-local.ps1"

if (-not (Test-Path -LiteralPath $ProbePath)) {
  throw "LIVE read-only probe source not found: $ProbePath"
}

$source = Get-Content -LiteralPath $ProbePath -Raw

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($source -notmatch $Pattern) { throw "Missing LIVE read-only probe safety assertion: $Label" }
}

function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($source -match $Pattern) { throw "Unsafe LIVE read-only probe pattern found: $Label" }
}

Assert-Contains 'selected runtime to remain DEMO' 'selected runtime must stay DEMO'
Assert-Contains 'bot mode PAUSE' 'bot must remain PAUSE'
Assert-Contains 'different terminal64\.exe paths' 'DEMO/LIVE terminal separation'
Assert-Contains 'Assert-Phase7CAccountEnv\s+-EnvFile\s+\$LiveEnvFile\s+-AccountMode\s+"LIVE"' 'LIVE env validated without RequireTrading'
Assert-Contains 'refuses MT5_TRADING_ENABLED=true' 'probe refuses LIVE trading capability'
Assert-Contains 'refuses XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=true' 'probe refuses compatibility gate'
Assert-Contains 'Assert-Phase7CLiveRiskProfileBinding' 'LIVE risk binding required'
Assert-Contains 'Clear-Phase7CLiveArmState' 'LIVE arm is cleared'
Assert-Contains 'Get-FreeLoopbackPort' 'probe uses isolated temporary loopback port'
Assert-Contains 'Set-ProbeEnvLine\s+\$lines\s+"MT5_TRADING_ENABLED"\s+"false"' 'temporary bridge is forced trading disabled'
Assert-Contains 'Set-ProbeEnvLine\s+\$lines\s+"XAUUSD_PHASE7C_ALLOW_LIVE_TRADING"\s+"false"' 'temporary bridge compatibility remains disabled'
Assert-Contains '"-AccountMode",\s+"LIVE"' 'temporary bridge is explicitly configured LIVE'
Assert-Contains 'accountMode -ne "real"' 'actual broker must be REAL'
Assert-Contains 'configuredAccountMode -ne "LIVE"' 'guarded bridge configured mode must be LIVE'
Assert-Contains 'tradingEnabled\) \{ throw' 'health must confirm trading disabled'
Assert-Contains 'liveExecutionArmed\) \{ throw' 'health must confirm not armed'
Assert-Contains 'liveArmStatus -ne "DISARMED"' 'health must confirm DISARMED'
Assert-Contains '/v1/positions\?symbol=XAUUSD' 'positions are read-only checked'
Assert-Contains '/v1/orders\?symbol=XAUUSD' 'pending orders are read-only checked'
Assert-Contains 'DEMO bridge session changed during LIVE read-only probe' 'DEMO bridge session must remain unchanged'
Assert-Contains 'Selected account mode changed during LIVE read-only probe' 'account selection unchanged proof'
Assert-Contains 'Bot mode changed during LIVE read-only probe' 'bot mode unchanged proof'
Assert-Contains 'taskkill\.exe.*\/PID\s+\$process\.Id\s+\/T\s+\/F' 'temporary process tree exact cleanup'
Assert-Contains 'PHASE7C_LIVE_READONLY_STATUS=PASS' 'explicit PASS marker'
Assert-Contains 'PHASE7C_LIVE_READONLY_LIVE_ARM=DISARMED' 'final DISARMED marker'

Assert-NotContains 'Start-ScheduledTask' 'probe must not start project scheduled tasks'
Assert-NotContains 'Stop-ScheduledTask' 'probe must not stop project scheduled tasks'
Assert-NotContains 'Write-Phase7CAccountJsonAtomic' 'probe must not rewrite selected account/runtime state'
Assert-NotContains 'switch-phase7c-account-mode-local\.ps1' 'probe must not invoke account switcher'
Assert-NotContains 'arm-phase7c-live-local\.ps1' 'probe must never arm LIVE'
Assert-NotContains '(?is)Invoke-RestMethod[^\r\n]*-Method\s+Post' 'probe must not issue REST POST mutations'
Assert-NotContains '(?is)Invoke-WebRequest[^\r\n]*-Method\s+Post' 'probe must not issue web POST mutations'

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $ProbePath), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
  throw "PowerShell parse failed for LIVE read-only probe: $($errors -join '; ')"
}

Write-Host "PHASE7C_LIVE_READONLY_PROBE_SOURCE_TEST=PASS"
