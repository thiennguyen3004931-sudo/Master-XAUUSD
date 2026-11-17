$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Read-Source([string]$RelativePath) {
  $full = Join-Path $ProjectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing source file: $RelativePath" }
  return Get-Content -LiteralPath $full -Raw
}
function Assert-Text([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -notmatch $Pattern) { throw "Source assertion failed: $Message" }
}
function Assert-NotText([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -match $Pattern) { throw "Negative source assertion failed: $Message" }
}

$diag = Read-Source 'scripts/get-phase7c-trend-diagnostics-v2.mjs'
$canonical = Read-Source 'scripts/run-phase7b-demo-controller.ts'
$restore = Read-Source 'scripts/restore-phase7c-executor-task-local.ps1'
$telegram = Read-Source 'scripts/test-phase7c-telegram-notifications-local.ps1'
$register = Read-Source 'scripts/register-phase7c-executor-task-local.ps1'
$rootPackage = Read-Source 'package.json'

# Diagnostics V2 must mirror the canonical Trend priority and constants without mutation capability.
Assert-Text $canonical 'Pattern Rule V2 priority: THREE -> TWO -> ENGULFING' 'canonical Trend pattern priority changed unexpectedly'
Assert-Text $canonical 'ENGULF_BODY_TOLERANCE_PRICE\s*=\s*0\.1' 'canonical engulf tolerance changed unexpectedly'
Assert-Text $canonical 'MIN_INITIAL_SL_PRICE\s*=\s*6' 'canonical minimum SL changed unexpectedly'
Assert-Text $canonical 'MAX_INITIAL_SL_PRICE\s*=\s*10' 'canonical maximum SL changed unexpectedly'
Assert-Text $diag 'THREE_CANDLE_BODY_DOMINANCE' 'diagnostics must inspect 3-candle pattern'
Assert-Text $diag 'TWO_CANDLE_BODY_DOMINANCE' 'diagnostics must inspect 2-candle pattern'
Assert-Text $diag 'ENGULFING' 'diagnostics must inspect engulfing pattern'
Assert-Text $diag 'phase7BSupertrend\(m15\.slice\(0, index \+ 1\), 10, 3\)' 'diagnostics must use canonical M15 Supertrend 10/3'
Assert-Text $diag 'phase7BSupertrend\(m5\.slice\(0, m5SignalIndex \+ 1\), 10, 3\)' 'diagnostics must use canonical M5 Supertrend 10/3'
Assert-Text $diag 'WAIT_PULLBACK_STOP_GT_10' 'diagnostics must expose >10 pullback reason'
Assert-Text $diag 'readOnly:\s*true' 'diagnostics must identify read-only safety'
Assert-NotText $diag '/v1/orders' 'diagnostics must not access broker order endpoint'
Assert-NotText $diag '/v1/positions/.+close' 'diagnostics must not close broker positions'

# Diagnostics runtime contract must remain aligned with the canonical persisted account-mode schema.
Assert-Text $rootPackage '"@xauusd/risk-engine"\s*:\s*"workspace:\*"' 'root workspace must expose risk-engine for diagnostics import'
Assert-Text $diag 'const version = Number\(state\?\.version\);' 'diagnostics must read persisted account-mode version'
Assert-Text $diag 'if \(version !== 1\)' 'diagnostics must fail closed on unsupported account-mode version'
Assert-Text $diag 'accountMode !== "DEMO" && accountMode !== "LIVE"' 'diagnostics must accept only canonical DEMO/LIVE account modes'
Assert-Text $diag 'accountMode === "DEMO" && liveExecutionEnabled' 'diagnostics must reject DEMO state with LIVE execution enabled'
Assert-Text $diag 'accountMode === "LIVE" && !liveExecutionEnabled' 'diagnostics must reject LIVE state without LIVE execution enabled'
Assert-Text $diag 'const resolvedEnvFile = path\.resolve\(envFile\);' 'diagnostics must resolve the persisted env file'
Assert-Text $diag 'fs\.existsSync\(resolvedEnvFile\)' 'diagnostics must require the selected env file to exist'
Assert-NotText $diag 'state\?\.valid' 'diagnostics must not depend on derived service-only valid field'

# Missing canonical task restore is definition-only and guarded by PAUSE + flat checks.
Assert-Text $register "TaskName = 'XAUUSD-Phase7C-Executors'" 'canonical executor task name must remain fixed'
Assert-Text $register 'New-ScheduledTaskTrigger -AtStartup' 'canonical task must retain startup trigger'
Assert-Text $register 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' 'canonical task must use trusted PowerShell executable'
Assert-Text $restore 'ConfirmCreate' 'task restore must require explicit confirmation'
Assert-Text $restore "state\.mode -ne 'PAUSE'" 'task restore must require PAUSE'
Assert-Text $restore 'openXauusdPositions' 'task restore must require flat XAUUSD state'
Assert-Text $restore 'TASK_START_PERFORMED=False' 'task restore must explicitly prove no task start'
Assert-NotText $restore 'Start-ScheduledTask' 'task restore must not start executors'
Assert-NotText $restore '/v1/orders' 'task restore must not send broker orders'

# Telegram test is notification-only, uses existing local secret file, and cannot touch the trading plane.
Assert-Text $telegram 'ConfirmNotificationOnly' 'Telegram test must require explicit notification-only confirmation'
Assert-Text $telegram 'api\.telegram\.org/bot\$Token/sendMessage' 'Telegram test must only call Telegram sendMessage'
Assert-Text $telegram 'ZIQ_TELEGRAM_BOT_TOKEN' 'Telegram test must reuse canonical local Telegram token setting'
Assert-Text $telegram 'ZIQ_TELEGRAM_CHAT_ID' 'Telegram test must reuse canonical local Telegram chat setting'
Assert-Text $telegram 'TEST ONLY - NOT A REAL TRADE' 'all sample lifecycle messages must be clearly marked as tests'
Assert-Text $telegram 'BROKER_ORDER_SEND=False' 'Telegram test must declare no broker order send'
Assert-Text $telegram 'POSITION_MUTATION=False' 'Telegram test must declare no position mutation'
Assert-Text $telegram 'ACCOUNT_SWITCH=False' 'Telegram test must declare no account switch'
Assert-Text $telegram 'BOT_MODE_MUTATION=False' 'Telegram test must declare no bot-mode mutation'
Assert-Text $telegram 'LIVE_ARM_MUTATION=False' 'Telegram test must declare no LIVE arm mutation'
Assert-NotText $telegram '127\.0\.0\.1:8765' 'Telegram test must not access broker bridge'
Assert-NotText $telegram '/v1/orders' 'Telegram test must not access order endpoint'
Assert-NotText $telegram 'Start-ScheduledTask' 'Telegram test must not start tasks'

Write-Host 'PHASE7C_TREND_DIAGNOSTICS_V2_OPS_SOURCE_TEST=PASS'
