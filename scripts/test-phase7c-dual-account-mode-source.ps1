$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Assert-Text([string]$Path, [string]$Pattern, [string]$Message) {
  $full = Join-Path $ProjectRoot $Path
  if (-not (Test-Path -LiteralPath $full)) { throw "Missing source file: $Path" }
  $text = Get-Content -LiteralPath $full -Raw
  if ($text -notmatch $Pattern) { throw "Static source assertion failed: $Message [$Path]" }
}
function Assert-NotText([string]$Path, [string]$Pattern, [string]$Message) {
  $full = Join-Path $ProjectRoot $Path
  $text = Get-Content -LiteralPath $full -Raw
  if ($text -match $Pattern) { throw "Static source negative assertion failed: $Message [$Path]" }
}

Assert-Text "apps/api/src/services/phase7c-decision-monitor.service.ts" 'accountModeAllowsBroker' "decision monitor must use selected account-mode broker guard"
Assert-Text "apps/api/src/services/phase7c-decision-monitor.service.ts" 'mt5PanelOrderPermission:\s*"NONE"' "MT5 decision monitor must remain read-only"
Assert-Text "apps/api/src/services/phase7c-decision-monitor.service.ts" 'phase7b-live-forward' "LIVE managed Trend state must be isolated"
Assert-Text "apps/api/src/services/phase7c-decision-monitor.service.ts" 'phase7c-sideway-live-forward' "LIVE managed Sideway state must be isolated"
Assert-Text "apps/api/src/services/phase7c-decision-monitor.service.ts" 'decision-observability' "decision journals must remain observable"

Assert-Text "apps/api/src/services/phase7c-ui-contract.service.ts" 'orderPermission:\s*"NONE"' "semantic UI must remain read-only"
Assert-Text "apps/api/src/services/phase7c-ui-contract.service.ts" 'accountMode:\s*"DEMO"\s*\|\s*"LIVE"' "semantic UI must expose account mode"

# Web lifecycle may cold-start a previously authorized LIVE account, but must
# never grant first-time LIVE execution permission from the web. The dedicated
# start policy requires durable/legacy explicit authorization and fails closed
# with LIVE_NOT_PREAUTHORIZED otherwise. Lifecycle startup itself must end in
# PAUSE; AUTO is a distinct manual action from the Web control center.
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'liveColdStartFromWeb:\s*true' "web may cold-start only a preauthorized LIVE runtime"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'firstTimeLiveArmFromWeb:\s*false' "web must never perform first-time LIVE ARM"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'resolvePhase7CWebStartAccount' "web lifecycle must route account selection through the guarded start policy"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'LIVE_NOT_PREAUTHORIZED' "web lifecycle must fail closed when LIVE lacks prior authorization"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'phase7CBotModeService\.set\("PAUSE",\s*"web-control-center-preflight"\)' "web start must freeze bot mode before account/start preflight"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" '!liveAuthorization\.valid\s*\|\|\s*!liveAuthorization\.identity' "LIVE launcher must revalidate prior LIVE authorization"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'startMode:\s*"PAUSE_UNTIL_MANUAL_WEB_AUTO"' "lifecycle safety contract must require manual Web AUTO"
Assert-Text "apps/api/src/services/phase7c-lifecycle.service.ts" 'phase7CBotModeService\.set\("PAUSE",\s*"web-control-center-ready-pause"\)' "ready lifecycle must remain PAUSE"
Assert-NotText "apps/api/src/services/phase7c-lifecycle.service.ts" 'phase7CBotModeService\.set\("AUTO"' "lifecycle must never activate AUTO as a side effect"
Assert-Text "apps/api/src/services/phase7c-web-account-start-policy.ts" 'durableLiveAuthorizationValid' "LIVE web start must require durable prior authorization"
Assert-Text "apps/api/src/services/phase7c-web-account-start-policy.ts" 'DURABLE_LIVE_AUTHORIZATION' "LIVE web start must expose durable authorization provenance"
Assert-Text "apps/api/src/services/phase7c-web-account-start-policy.ts" 'LEGACY_EXPLICIT_LIVE_STATE' "legacy explicit LIVE authorization migration must remain explicit"
Assert-Text "apps/api/src/services/phase7c-web-account-start-policy.ts" 'LIVE_NOT_PREAUTHORIZED' "unapproved LIVE web start must remain blocked"
Assert-Text "apps/api/src/routes/phase7c.route.ts" 'router\.get\("/account-mode"' "API must expose read-only account mode"
Assert-Text "apps/api/src/routes/phase7c.route.ts" 'webCanSwitchAccount:\s*false' "API must not switch MT5 account from web"
Assert-Text "apps/api/src/routes/phase7c.route.ts" 'accountModeAllowsBroker' "lot settings must bind selected account"
Assert-Text "apps/api/src/services/phase7c-lot-settings.service.ts" 'phase7c-lot-settings\.\$\{accountMode\.toLowerCase\(\)\}\.json' "lot settings must persist per account"
Assert-Text "apps/api/src/services/phase7c-lot-settings.service.ts" 'active\.accountMode !== accountModeState\.accountMode' "active lot state must match selected account"
Assert-Text "apps/api/src/services/phase7c-account-risk.service.ts" 'executionMutation:\s*false' "account risk preview must remain read-only"
Assert-Text "apps/api/src/services/phase7c-account-risk.service.ts" 'orderPermission:\s*"NONE"' "account risk preview cannot send orders"

Assert-Text "scripts/phase7c-account-runtime-guard.mjs" 'url\.pathname !== "/v1/orders"' "account guard must specifically gate new orders"
Assert-Text "scripts/phase7c-account-runtime-guard.mjs" 'ACCOUNT_LOGIN_NOT_ALLOWLISTED' "final account gate must enforce allowlist"
Assert-Text "scripts/run-phase7c-sideway-locked.mjs" 'fetchHealthUnderLock' "Sideway must recheck account under execution lock"
Assert-Text "scripts/run-phase7c-sideway-locked.mjs" 'POSITION_PRESENT_UNDER_LOCK' "Sideway must retain single-position final check"
Assert-Text "scripts/run-phase7c-trend-account-mode.mjs" 'installPhase7CAccountOrderFetchGuard' "Trend must install final account gate"
Assert-Text "scripts/phase7c-sideway-logic.mjs" 'MIN_INITIAL_STOP_DISTANCE\s*=\s*6' "Sideway minimum initial stop must remain 6"
Assert-Text "scripts/phase7c-sideway-logic.mjs" 'MAX_INITIAL_STOP_DISTANCE\s*=\s*10' "Sideway maximum initial stop must remain 10"
Assert-Text "scripts/phase7c-sideway-logic.mjs" 'WAIT_PULLBACK_STOP_GT_10' "Sideway stop wider than 10 must wait pullback"

# Runtime-verifier hardening: PowerShell can wrap an empty REST array as one
# pipeline object in some call sites. Parse the raw JSON so [] is always zero.
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'Invoke-WebRequest\s+-Uri\s+"\$bridgeBase/v1/positions\?symbol=XAUUSD"' "account verifier must inspect raw position JSON"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" '\$positionRaw\s+-eq\s+"\[\]"' "empty broker position array must map to zero positions"
Assert-NotText "scripts/verify-phase7c-account-runtime-local.ps1" '\$positions\s*=\s*@\(Invoke-RestMethod\s+-Uri\s+"\$bridgeBase/v1/positions\?symbol=XAUUSD"' "account verifier must not use ambiguous REST array wrapping"

# Runtime topology may be either a verified executor Scheduled Task or a
# still-running startup runner created by Windows Task Scheduler. Fallback is
# allowed only for a true NOT_FOUND result; access/provider failures stay
# fail-closed. When process CommandLine is unavailable, identity is proved by
# Schedule-service ancestry + fresh runner status + singleton lock + exact
# supervisor PID/parent relationship + selected account/config consistency.
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'phase7c-scheduled-task-ownership\.ps1' "runtime verifier must load Scheduled Task ownership helpers"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'Get-Phase7CScheduledTaskErrorClassification' "task lookup failures must be classified"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'Test-Phase7CExecutorTaskActionOwnership' "existing executor task must use exact ownership verification"
Assert-NotText "scripts/verify-phase7c-account-runtime-local.ps1" 'Get-ScheduledTask\s+-TaskName\s+\$TaskName\s+-ErrorAction\s+SilentlyContinue' "task lookup must not hide access/provider failures"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_TASK_LOOKUP=' "task lookup classification must be observable"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_EXECUTOR_TOPOLOGY=TASK' "verifier must expose Scheduled Task topology"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_EXECUTOR_TOPOLOGY=STARTUP_RUNNER' "verifier must expose startup-runner topology"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'Win32_Service' "startup-runner fallback must inspect Windows Task Scheduler service"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_RUNNER_PARENT_IS_SCHEDULE=' "runner must be directly owned by Schedule service"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_SYSTEM_BROKER_SUPERVISOR_MATCH=' "SYSTEM lifecycle broker supervisor PID must match active supervisor"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_SUPERVISOR_PARENT_IS_RUNNER=' "supervisor must be direct runner child"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_STARTUP_RUNNER_IDENTITY=TOPOLOGY_PROOF' "fallback identity proof must be explicit"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'PHASE7C_ACCOUNT_VERIFY_TASK_FALLBACK=PASS' "verified task-missing fallback marker"
Assert-NotText "scripts/verify-phase7c-account-runtime-local.ps1" 'Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask' "runtime verifier must remain read-only"

# Telegram starts with lastTelegramSuccessAt=null. The verifier must not cast
# null to zero and report an enormous fake heartbeat age while STARTING.
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" '\$null\s+-ne\s+\$lastTelegramSuccessAt' "Telegram verifier must guard null heartbeat"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'TELEGRAM_HEARTBEAT_AGE_MS=NO_SUCCESS_YET' "Telegram verifier must expose startup-without-success explicitly"
Assert-Text "scripts/verify-phase7c-account-runtime-local.ps1" 'telegramRuntime\.status\s+-eq\s+"READY"' "Telegram readiness must require READY status"

# Scheduled Tasks must use a deterministic trusted PowerShell executable rather
# than relying on PATH resolution in Task Scheduler service contexts.
Assert-Text "scripts/register-phase7c-account-bridge-task-local.ps1" 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' "account bridge task must use absolute Windows PowerShell"
Assert-Text "scripts/register-phase7c-executor-task-local.ps1" 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' "executor task must use absolute Windows PowerShell"

# The bridge env parser must remove matching quotes/BOM before passing paths to
# MetaTrader5.initialize(), otherwise quoted terminal paths fail IPC creation.
Assert-Text "packages/mt5-broker/bridge/run.ps1" 'TrimStart\(\[char\]0xFEFF\)' "bridge env parser must strip UTF-8 BOM"
Assert-Text "packages/mt5-broker/bridge/run.ps1" 'value\.Substring\(1,\s*\$value\.Length\s*-\s*2\)' "bridge env parser must remove matching outer quotes"

# The source-controlled LIVE env is a template only. Login, password, server and
# allowlist must remain blank so no broker credential can enter Git history.
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_LOGIN=\s*$' "LIVE example login must be blank"
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_PASSWORD=\s*$' "LIVE example password must be blank"
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_SERVER=\s*$' "LIVE example server must be blank"
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_ALLOWED_LOGINS=\s*$' "LIVE example allowlist must be blank"
Assert-NotText "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_API_KEY=(?!CHANGE_ME_TO_A_LONG_RANDOM_SECRET\s*$).+' "LIVE example must not contain a real API key"
Assert-Text ".gitignore" '/phase7b-live-forward/' "LIVE Trend state must be ignored locally"
Assert-Text ".gitignore" '/phase7c-sideway-live-forward/' "LIVE Sideway state must be ignored locally"
Assert-Text ".gitignore" '/phase7c-lot-settings\.live\.json' "LIVE risk profile must remain local"

Write-Host "PHASE7C_DUAL_ACCOUNT_SOURCE_TEST=PASS"
