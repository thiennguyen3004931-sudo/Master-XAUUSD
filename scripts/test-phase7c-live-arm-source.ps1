$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Assert-Text([string]$Path, [string]$Pattern, [string]$Message) {
  $full = Join-Path $ProjectRoot $Path
  if (-not (Test-Path -LiteralPath $full)) { throw "Missing source file: $Path" }
  $text = Get-Content -LiteralPath $full -Raw
  if ($text -notmatch $Pattern) { throw "LIVE arm source assertion failed: $Message [$Path]" }
}

function Assert-NotText([string]$Path, [string]$Pattern, [string]$Message) {
  $full = Join-Path $ProjectRoot $Path
  if (-not (Test-Path -LiteralPath $full)) { throw "Missing source file: $Path" }
  $text = Get-Content -LiteralPath $full -Raw
  if ($text -match $Pattern) { throw "LIVE arm negative source assertion failed: $Message [$Path]" }
}

Assert-Text "packages/mt5-broker/bridge/mt5_bridge/app.py" 'GuardedMt5Gateway' "bridge app must instantiate guarded gateway"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/guarded_gateway.py" 'LIVE_EXECUTION_DISARMED' "REAL mutation must fail with explicit disarmed guard"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/guarded_gateway.py" 'evaluate_live_arm' "mutation guard must evaluate session-bound arm"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/guarded_gateway.py" 'bridgeSessionId' "health must expose bridge process session id"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/guarded_gateway.py" 'pending_orders' "LIVE preflight must have a read-only pending-order snapshot"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/live_arm.py" 'ARM_BRIDGE_SESSION_MISMATCH' "stale bridge sessions must fail closed"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/live_arm.py" 'ARM_LOGIN_MISMATCH' "wrong login must fail closed"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/live_arm.py" 'ARM_SERVER_MISMATCH' "wrong server must fail closed"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/live_arm.py" 'ARM_PROFILE_MISMATCH' "wrong terminal/profile fingerprint must fail closed"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/live_arm.py" 'ARM_EXPIRED' "legacy v1 expired arms must still fail closed"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/live_arm.py" 'BRIDGE_SESSION' "v2 arm must be bridge-session scoped"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/config.py" 'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING' "legacy LIVE env gate must be capability-only input"
Assert-Text "packages/mt5-broker/bridge/mt5_bridge/config.py" 'MT5_LIVE_ARM_STATE_PATH' "bridge must receive arm file path separately"

Assert-Text "packages/mt5-broker/bridge/run.ps1" 'AccountMode = "DEMO"' "direct bridge starts must default to DEMO"
Assert-Text "packages/mt5-broker/bridge/run.ps1" 'MT5_ACCOUNT_MODE' "bridge child must receive trusted account selection"
Assert-Text "packages/mt5-broker/bridge/run.ps1" 'MT5_LIVE_ARM_STATE_PATH' "bridge child must receive live arm path"
Assert-Text "scripts/run-phase7c-account-bridge-task-runner-local.ps1" 'Clear-Phase7CLiveArmState' "every bridge launch/restart must auto-disarm LIVE"
Assert-Text "scripts/run-phase7c-account-bridge-task-runner-local.ps1" 'bridge-process-launch' "restart disarm reason must be explicit"
Assert-Text "scripts/run-phase7c-account-bridge-task-runner-local.ps1" 'LiveArmStatePath' "trusted runner must pass arm path to child"

Assert-Text "scripts/arm-phase7c-live-local.ps1" 'botMode\.state\.mode -ne "PAUSE"' "arm must require PAUSE"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'accountMode -ne "real"' "arm must require a real broker account"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'configuredAccountMode -ne "LIVE"' "arm must require selected LIVE profile"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'MT5_TERMINAL_PATH' "arm must bind explicit LIVE terminal"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'MT5_LOGIN' "arm must bind explicit LIVE login"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'MT5_SERVER' "arm must bind explicit LIVE server"
Assert-Text "scripts/arm-phase7c-live-local.ps1" '/v1/positions\?symbol=XAUUSD' "arm must require no XAUUSD position"
Assert-Text "scripts/arm-phase7c-live-local.ps1" '/v1/orders\?symbol=XAUUSD' "arm must require no broker pending XAUUSD order"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'phase7c-execution\.lock' "arm must reject active execution lock"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'bridgeSessionId -ne \[string\]\$health\.bridgeSessionId' "arm must recheck bridge session before persistence"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'Write-Phase7CLiveArmState' "arm command must use atomic arm helper"
Assert-Text "scripts/arm-phase7c-live-local.ps1" 'PHASE7C_LIVE_ARM_SCOPE=BRIDGE_SESSION' "operator output must state session lifetime"
Assert-NotText "scripts/arm-phase7c-live-local.ps1" 'ArmMinutes' "operator arm command must not expose a fixed TTL"
Assert-Text "scripts/lib/phase7c-account-mode.ps1" 'scope = "BRIDGE_SESSION"' "arm state writer must persist bridge-session scope"
Assert-Text "scripts/lib/phase7c-account-mode.ps1" 'version = 2' "arm state writer must use session-bound state version"
Assert-NotText "scripts/lib/phase7c-account-mode.ps1" 'expiresAt = \$now\.AddMinutes' "session-bound arm writer must not persist expiry"
Assert-NotText "scripts/lib/phase7c-account-mode.ps1" '\[int\]\$ArmMinutes' "session-bound arm writer must not accept a TTL"
Assert-Text "scripts/disarm-phase7c-live-local.ps1" 'Clear-Phase7CLiveArmState' "operator disarm must be idempotent"
Assert-Text "scripts/get-phase7c-live-arm-local.ps1" 'liveArmStatus' "status command must report bridge-confirmed arm status"

Assert-Text "scripts/configure-phase7c-mt5-terminal-profile-local.ps1" 'MT5_TRADING_ENABLED" "false"' "LIVE profile configuration must not enable trading"
Assert-Text "scripts/configure-phase7c-mt5-terminal-profile-local.ps1" 'XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "false"' "LIVE profile configuration must keep compatibility gate off"
Assert-Text "scripts/configure-phase7c-mt5-terminal-profile-local.ps1" 'Clear-Phase7CLiveArmState' "profile identity changes must disarm LIVE"
Assert-NotText "scripts/configure-phase7c-mt5-terminal-profile-local.ps1" 'trendFixedLot|sidewayRiskPercent|sidewayMaxLot' "terminal profile configuration must never copy DEMO/LIVE risk values"

Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_TERMINAL_PATH=\s*$' "source LIVE template must not commit a machine terminal path"
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_LOGIN=\s*$' "source LIVE template must not commit login"
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^MT5_SERVER=\s*$' "source LIVE template must not commit server"
Assert-Text "packages/mt5-broker/bridge/.env.phase7b-live.example" '(?m)^XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=false\s*$' "source LIVE template must remain compatibility-disabled"
Assert-NotText "packages/mt5-broker/bridge/.env.phase7b-live.example" 'trendFixedLot|sidewayRiskPercent|sidewayMaxLot' "LIVE terminal template must not contain risk defaults"

Write-Host "PHASE7C_LIVE_ARM_SOURCE_TEST=PASS"
