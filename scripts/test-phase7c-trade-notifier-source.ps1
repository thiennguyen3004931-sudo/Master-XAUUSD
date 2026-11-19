$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1"
$Wrapper = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-local.ps1"
$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier.mjs"

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

foreach ($path in @($Supervisor, $Wrapper, $Notifier)) {
  Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "Missing required source file: $path"
}

Assert-PowerShellSyntax $Supervisor
Assert-PowerShellSyntax $Wrapper

$supervisorText = Get-Content -LiteralPath $Supervisor -Raw
$wrapperText = Get-Content -LiteralPath $Wrapper -Raw
$notifierText = Get-Content -LiteralPath $Notifier -Raw

# Startup safety invariant: force PAUSE before either executor is launched.
Assert-True ($supervisorText.Contains('mode = "PAUSE"')) "startup supervisor must explicitly persist PAUSE"
Assert-True (-not $supervisorText.Contains('mode = "AUTO"')) "startup supervisor must never force AUTO"
$pauseInvocation = $supervisorText.LastIndexOf("  Set-Phase7CStartupPause")
$trendLaunch = $supervisorText.IndexOf('$trend = Start-Process', [Math]::Max(0, $pauseInvocation))
$sidewayLaunch = $supervisorText.IndexOf('$sideway = Start-Process', [Math]::Max(0, $pauseInvocation))
Assert-True ($pauseInvocation -ge 0) "startup supervisor must invoke Set-Phase7CStartupPause"
Assert-True ($trendLaunch -gt $pauseInvocation) "startup PAUSE must occur before Trend executor launch"
Assert-True ($sidewayLaunch -gt $pauseInvocation) "startup PAUSE must occur before Sideway executor launch"

# Supervisor ownership: dedicated launcher, PID, runtime heartbeat/status, logs, restart, and cleanup.
Assert-True ($supervisorText.Contains('run-phase7b-telegram-notifier-local.ps1')) "executor supervisor must own the trade notifier launcher"
Assert-True ($supervisorText.Contains('trade-notifier.pid')) "executor supervisor must maintain a dedicated trade notifier PID file"
Assert-True ($supervisorText.Contains('trade-notifier-runtime.json')) "executor supervisor must maintain a dedicated trade notifier runtime heartbeat/status file"
Assert-True ($supervisorText.Contains('trade-notifier.out.log')) "executor supervisor must maintain a dedicated trade notifier stdout log"
Assert-True ($supervisorText.Contains('trade-notifier.err.log')) "executor supervisor must maintain a dedicated trade notifier stderr log"
Assert-True ($supervisorText.Contains('Start-TradeNotifierChild')) "executor supervisor must launch the trade notifier"
Assert-True ($supervisorText.Contains('PHASE7C_TRADE_NOTIFIER_STATUS=RESTART_PENDING')) "executor supervisor must detect a stopped/stale trade notifier"
Assert-True ($supervisorText.Contains('PHASE7C_TRADE_NOTIFIER_STATUS=RESTARTED')) "executor supervisor must restart the trade notifier"
Assert-True ($supervisorText.Contains('run-phase7b-telegram-notifier.mjs')) "orphan cleanup must include the trade notifier node process"

# Restart startup race regression: the monitor loop wakes every 2 seconds, while initial
# notifier startup already receives a 3-second grace period. A restarted wrapper must
# receive the same bounded grace before the next heartbeat gate can kill it.
$restartPrefix = 'try { $tradeNotifier = Start-TradeNotifierChild; Write-Host "PHASE7C_TRADE_NOTIFIER_STATUS=RESTARTED"'
$restartIndex = $supervisorText.IndexOf($restartPrefix, [System.StringComparison]::Ordinal)
Assert-True ($restartIndex -ge 0) "trade notifier restart statement must remain explicit for restart-grace verification"
$restartWindowLength = [Math]::Min(500, $supervisorText.Length - $restartIndex)
$restartWindow = $supervisorText.Substring($restartIndex, $restartWindowLength)
Assert-True ($restartWindow -match 'Start-Sleep\s+-Seconds\s+3') "restarted trade notifier must receive at least the canonical 3-second startup grace before heartbeat enforcement"

# Wrapper account-mode mapping: directory names are account-specific, canonical journal filenames stay unchanged.
Assert-True ($wrapperText.Contains('[ValidateSet("DEMO", "LIVE")]')) "trade notifier wrapper must accept explicit DEMO/LIVE account mode"
Assert-True ($wrapperText.Contains('phase7b-live-forward')) "LIVE Trend notifier journal must resolve under phase7b-live-forward"
Assert-True ($wrapperText.Contains('phase7c-sideway-live-forward')) "LIVE Sideway notifier journal must resolve under phase7c-sideway-live-forward"
Assert-True ($wrapperText.Contains('phase7b-demo-forward')) "DEMO Trend notifier journal mapping must remain supported"
Assert-True ($wrapperText.Contains('phase7c-sideway-forward')) "DEMO Sideway notifier journal mapping must remain supported"
Assert-True ($wrapperText.Contains('phase7b-demo-events.jsonl')) "Trend notifier must preserve the controller canonical journal filename"
Assert-True ($wrapperText.Contains('phase7c-sideway-events.jsonl')) "Sideway notifier must preserve the controller canonical journal filename"
Assert-True ($wrapperText.Contains('PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL')) "trade notifier wrapper must remain read-only/orderPermission NONE"

# User-visible phase/account identity must be dynamic and must not retain legacy hard-coded DEMO banners.
Assert-True ($notifierText.Contains('PHASE 7C')) "trade notifier must identify Phase 7C"
Assert-True ($notifierText.Contains('ZIQ_PHASE7C_ACCOUNT_MODE')) "trade notifier must derive the account mode dynamically"
Assert-True (-not $notifierText.Contains('PHASE 7B · DEMO')) "trade notifier must not hard-code legacy PHASE 7B · DEMO banners"
Assert-True (-not $notifierText.Contains('Phase 7B DEMO')) "trade notifier startup/test banner must not hard-code Phase 7B DEMO"

# Synthetic regression must use the production journal parser/formatter without transport or broker mutation.
Assert-True ($notifierText.Contains('ZIQ_TELEGRAM_DRY_RUN')) "trade notifier must expose a transport-free dry-run mode for synthetic lifecycle regression"
Assert-True ($notifierText.Contains('ZIQ_TELEGRAM_DRY_RUN_SINK')) "dry-run mode must record production-formatted notifications in a local sink"
Assert-True (-not ($notifierText -match '(?i)/v1/orders(?:/|\?|"|`)')) "trade notifier must not contain broker order endpoints"

Write-Host "PHASE7C_TRADE_NOTIFIER_SOURCE_TEST=PASS"
