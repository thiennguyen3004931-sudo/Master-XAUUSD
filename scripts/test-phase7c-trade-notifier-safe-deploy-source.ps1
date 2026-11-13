$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Deploy = Join-Path $PSScriptRoot 'deploy-phase7c-trade-notifier-local.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Assert-True (Test-Path -LiteralPath $Deploy -PathType Leaf) 'Safe trade notifier deploy script is missing.'

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Deploy, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "Deploy script syntax error: $($errors[0].Message)" }

$source = Get-Content -LiteralPath $Deploy -Raw

Assert-True ($source.Contains('[ValidateSet("DEMO", "LIVE")]')) 'Deploy script must require an explicit DEMO/LIVE account mode.'
Assert-True ($source.Contains('phase7c-scheduled-task-ownership.ps1')) 'Deploy script must load Scheduled Task ownership helper.'
Assert-True ($source.Contains('Test-Phase7CExecutorTaskActionOwnership')) 'Deploy script must prove exact Scheduled Task ownership.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_ADMIN=PASS')) 'Deploy script must require Administrator context.'

# Runtime mode is an invariant of notifier-only deploy. LIVE AUTO must remain AUTO.
Assert-True (-not $source.Contains('mode = "PAUSE"')) 'Notifier-only deploy must not force PAUSE.'
Assert-True (-not ($source -match '(?i)/api/v1/phase7c/bot-mode[^\r\n]*-Method\s+Post')) 'Notifier-only deploy must not mutate bot mode.'
Assert-True ($source.Contains('/api/v1/phase7c/bot-mode')) 'Deploy script must read bot mode before and after hot reload.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_MODE_BEFORE')) 'Deploy script must expose pre-deploy mode.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_MODE_UNCHANGED=PASS')) 'Deploy script must prove mode is unchanged.'

# LIVE ARM is a separate canonical bridge-session state from supervisor -Armed.
Assert-True ($source.Contains('/api/v1/phase7c-live-arm-control/capability')) 'LIVE deploy must inspect canonical LIVE ARM capability.'
Assert-True ($source.Contains('liveArmStatus')) 'LIVE deploy must inspect canonical liveArmStatus.'
Assert-True ($source.Contains('liveExecutionArmed')) 'LIVE deploy must inspect canonical liveExecutionArmed.'
Assert-True ($source.Contains('bridgeSessionId')) 'LIVE deploy must bind ARM to the current bridge session.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_LIVE_ARM_BEFORE=ARMED')) 'LIVE deploy must expose canonical ARMED precondition.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_LIVE_ARM_UNCHANGED=PASS')) 'LIVE deploy must prove canonical LIVE ARM state is unchanged.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_BRIDGE_SESSION_UNCHANGED=PASS')) 'LIVE deploy must prove bridge session is unchanged.'
Assert-True (-not ($source -match '(?i)phase7c-live-arm-control/(?:preflight|execute)')) 'Notifier-only deploy must never call LIVE ARM mutation endpoints.'

# Source deployment is pinned to an exact, clean main commit.
Assert-True ($source.Contains('[string]$ExpectedCommit')) 'Deploy script must require ExpectedCommit.'
Assert-True ($source.Contains('branch --show-current')) 'Deploy script must require branch main.'
Assert-True ($source.Contains('status --porcelain')) 'Deploy script must require a clean working tree.'
Assert-True ($source.Contains('rev-parse HEAD')) 'Deploy script must verify exact git HEAD.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_EXPECTED_COMMIT')) 'Deploy script must expose the verified commit.'

# Read-only broker guard remains in place; no order path is allowed.
Assert-True ($source.Contains('/v1/positions?symbol=XAUUSD')) 'Deploy script must read XAUUSD positions before hot reload.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_XAUUSD_POSITIONS=0')) 'Deploy script must expose the zero-position safety marker.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_ORDER_ACTION=NONE')) 'Deploy script must expose no-order marker.'

# Supervisor/executor/Telegram control children are invariants; only trade-notifier may restart.
foreach ($pidFile in @('supervisor.pid', 'trend.pid', 'sideway.pid', 'telegram-mode.pid', 'regime-notifier.pid', 'trade-notifier.pid')) {
  Assert-True ($source.Contains($pidFile)) "Deploy script must inspect $pidFile."
}
Assert-True ($source.Contains('active-lot-settings.json')) 'Deploy script must inspect armed state from active executor settings.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_ARMED_BEFORE')) 'Deploy script must expose pre-deploy armed state.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_ARMED_UNCHANGED=PASS')) 'Deploy script must prove armed state is unchanged.'
Assert-True ($source.Contains('function Assert-InvariantPid')) 'Deploy script must centralize invariant PID verification.'
Assert-True ($source.Contains('Write-Host "$Marker=PASS"')) 'Invariant PID guard must emit an explicit PASS marker only after equality/aliveness checks.'
foreach ($marker in @(
  'PHASE7C_TRADE_NOTIFIER_DEPLOY_SUPERVISOR_PID_UNCHANGED',
  'PHASE7C_TRADE_NOTIFIER_DEPLOY_TREND_PID_UNCHANGED',
  'PHASE7C_TRADE_NOTIFIER_DEPLOY_SIDEWAY_PID_UNCHANGED',
  'PHASE7C_TRADE_NOTIFIER_DEPLOY_TELEGRAM_MODE_PID_UNCHANGED',
  'PHASE7C_TRADE_NOTIFIER_DEPLOY_REGIME_NOTIFIER_PID_UNCHANGED'
)) {
  Assert-True ($source.Contains("-Marker `"$marker`"")) "Deploy script must prove invariant with marker $marker."
}
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_OLD_TRADE_NOTIFIER_PID')) 'Deploy script must expose old trade notifier PID.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_NEW_TRADE_NOTIFIER_PID')) 'Deploy script must prove a new trade notifier PID is running.'

$commandAsts = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.CommandAst]
}, $true))
$taskkillMatches = [regex]::Matches(
  $source,
  '(?im)^\s*&\s+\$taskkillExe\s+/PID\s+\$oldTradeNotifierPid\s+/T\s+/F(?:\s*\|\s*Out-Host)?\s*$'
)
Assert-True ($taskkillMatches.Count -eq 1) 'Deploy script must issue exactly one taskkill command targeting oldTradeNotifierPid with /T /F.'
Assert-True (-not ($source -match '(?im)^\s*&\s+\$taskkillExe\s+/PID\s+\$(?:oldSupervisorPid|oldTrendPid|oldSidewayPid|oldTelegramModePid|oldRegimeNotifierPid)\b')) 'Deploy script must never taskkill supervisor/executor/control child PIDs.'

# Supervisor must recreate a healthy read-only notifier child. Verification stays local to
# this helper because the legacy -DeploymentGate intentionally requires PAUSE.
Assert-True ($source.Contains('trade-notifier-runtime.json')) 'Deploy script must inspect trade notifier heartbeat runtime.'
Assert-True ($source.Contains('wrapperPid')) 'Deploy script must bind runtime heartbeat to the replacement wrapper PID.'
Assert-True ($source.Contains('orderPermission')) 'Deploy script must verify notifier order permission.'
Assert-True ($source.Contains('"NONE"')) 'Deploy script must require notifier orderPermission NONE.'
Assert-True ($source.Contains('heartbeatAt')) 'Deploy script must validate notifier heartbeat freshness.'
Assert-True ($source.Contains('accountMode')) 'Deploy script must validate notifier account mode.'
Assert-True (-not $source.Contains('-DeploymentGate')) 'Notifier-only deploy must not call the PAUSE-only deployment gate.'
Assert-True (-not $source.Contains('-RequireTelegram')) 'Notifier-only deploy must not invoke broad Telegram verification.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY=PASS')) 'Deploy script must emit an explicit final PASS marker.'
Assert-True ($source.Contains('PHASE7C_TRADE_NOTIFIER_DEPLOY_FINAL_MODE_UNCHANGED')) 'Final deploy marker must report the unchanged mode.'

$forbiddenTaskCommands = @('Start-ScheduledTask', 'Stop-ScheduledTask', 'Register-ScheduledTask', 'Set-ScheduledTask')
foreach ($commandAst in $commandAsts) {
  $commandName = $commandAst.GetCommandName()
  if (-not [string]::IsNullOrWhiteSpace($commandName)) {
    Assert-True ($forbiddenTaskCommands -notcontains $commandName) "Deploy script must not invoke Scheduled Task mutation command: $commandName"
  }
}

Assert-True (-not ($source -match '(?i)/v1/orders(?:/|\?|"|`)')) 'Deploy script must not contain broker order endpoints.'
Assert-True (-not ($source -match '(?i)mode\s*=\s*["'']AUTO["'']')) 'Deploy script must never enable AUTO.'
Assert-True (-not ($source -match '(?i)sendMessage|ZIQ_TELEGRAM_SEND_TEST')) 'Deploy script must not send Telegram test messages.'

Write-Host 'PHASE7C_TRADE_NOTIFIER_SAFE_DEPLOY_SOURCE_TEST=PASS'
