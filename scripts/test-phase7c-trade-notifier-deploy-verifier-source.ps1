$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Verifier = Join-Path $PSScriptRoot 'verify-phase7c-executors-local.ps1'
if (-not (Test-Path -LiteralPath $Verifier -PathType Leaf)) { throw "Missing verifier: $Verifier" }

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Verifier, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "Verifier syntax error: $($errors[0].Message)" }

$source = Get-Content -LiteralPath $Verifier -Raw

# Deployment gate must be account-mode aware without changing the legacy DEMO verifier default.
Assert-True ($source.Contains('[ValidateSet("DEMO", "LIVE")]')) 'Verifier must accept explicit DEMO/LIVE account mode.'
Assert-True ($source.Contains('[switch]$DeploymentGate')) 'Verifier must expose an explicit fail-closed deployment gate.'
Assert-True ($source.Contains('phase7b-live-forward')) 'LIVE Trend journal directory mapping is missing.'
Assert-True ($source.Contains('phase7c-sideway-live-forward')) 'LIVE Sideway journal directory mapping is missing.'
Assert-True ($source.Contains('phase7b-demo-forward')) 'DEMO Trend journal mapping must remain supported.'
Assert-True ($source.Contains('phase7c-sideway-forward')) 'DEMO Sideway journal mapping must remain supported.'
Assert-True ($source.Contains('phase7b-demo-events.jsonl')) 'Trend canonical journal filename must remain phase7b-demo-events.jsonl.'
Assert-True ($source.Contains('phase7c-sideway-events.jsonl')) 'Sideway canonical journal filename must remain phase7c-sideway-events.jsonl.'

# Trade notifier is a first-class supervised runtime and must be proven alive/fresh.
Assert-True ($source.Contains('trade-notifier-runtime.json')) 'Deployment gate must read trade notifier runtime status.'
Assert-True ($source.Contains('"trade-notifier"')) 'Trade notifier must be included in PID verification.'
Assert-True ($source.Contains('wrapperPid')) 'Deployment gate must compare notifier wrapper PID with the PID file.'
Assert-True ($source.Contains('heartbeatAt')) 'Deployment gate must verify notifier heartbeat freshness.'
Assert-True ($source.Contains('orderPermission')) 'Deployment gate must verify notifier order permission.'
Assert-True ($source -match '(?i)tradeNotifierOrderPermission\s+-ne\s+"NONE"') 'Deployment gate must fail unless notifier orderPermission=NONE.'
Assert-True ($source.Contains('trendJournal')) 'Deployment gate must verify the runtime Trend journal path.'
Assert-True ($source.Contains('sidewayJournal')) 'Deployment gate must verify the runtime Sideway journal path.'
Assert-True ($source.Contains('PHASE7C_VERIFY_TRADE_NOTIFIER_DEPLOYMENT=PASS')) 'Deployment gate must emit an explicit PASS marker.'

# Deployment gate must avoid unrelated runtime scans. Only supervisor + trade-notifier PID state is needed
# unless the caller explicitly asks for the broader Telegram verification contract.
Assert-True ($source.Contains('$pidNames = if ($DeploymentGate -and -not $RequireTelegram) { @("supervisor", "trade-notifier") } else { @("supervisor", "trend", "sideway", "telegram-mode", "regime-notifier", "trade-notifier") }')) 'Deployment gate must limit PID scanning to supervisor and trade-notifier unless Telegram verification is explicitly requested.'
Assert-True ($source.Contains('if (-not $DeploymentGate -or $RequireTelegram) {')) 'Deployment gate must skip telegram-mode heartbeat parsing unless Telegram verification is explicitly requested.'

# Deploy verification is fail-closed: bot remains PAUSE and LIVE never falls into DEMO-only deep checks.
Assert-True ($source.Contains('Deployment gate requires bot mode PAUSE')) 'Deployment gate must require PAUSE.'
Assert-True ($source.Contains('PHASE7C_VERIFY_DEPLOYMENT_ACCOUNT_MODE')) 'Deployment gate must report the requested account mode.'
Assert-True ($source.Contains('PHASE7C_VERIFY_DEPLOYMENT_GATE=PASS')) 'Deployment gate must emit a final PASS marker.'
Assert-True (-not $source.Contains('Deployment gate requires trade notifier runtime status RUNNING.')) 'Deployment gate must not duplicate the RUNNING check already enforced by tradeNotifierReady.'
Assert-True (-not $source.Contains('Deployment gate requires trade notifier orderPermission NONE.')) 'Deployment gate must not duplicate the orderPermission=NONE check already enforced by tradeNotifierReady.'
Assert-True ($source.Contains('if ($AccountMode -eq "LIVE")')) 'Verifier must explicitly handle LIVE mode.'
Assert-True (-not ($source -match '(?i)/v1/orders(?:/|\?|"|`)')) 'Verifier must not contain broker order endpoints.'
Assert-True (-not ($source -match '(?i)mode\s*=\s*["'']AUTO["'']')) 'Verifier must never force AUTO.'

Write-Host 'PHASE7C_TRADE_NOTIFIER_DEPLOY_VERIFIER_SOURCE_TEST=PASS'
