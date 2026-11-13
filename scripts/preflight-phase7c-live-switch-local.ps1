param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"
$BridgeVenvPython = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.venv\Scripts\python.exe"

foreach ($required in @($AccountLibrary, $AccountStatePath, $BridgeVenvPython)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "LIVE switch preflight required file not found: $required" }
}
. $AccountLibrary

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$DemoEnvFile = Resolve-ProjectPath $DemoEnvFile
$LiveEnvFile = Resolve-ProjectPath $LiveEnvFile

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "LIVE switch preflight requires PowerShell Administrator."
}

Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT=START"

$state = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
if ([int]$state.version -ne 1) { throw "Unsupported account-mode state version." }
$selectedMode = ConvertTo-Phase7CAccountMode ([string]$state.accountMode)
if ($selectedMode -ne "DEMO") { throw "LIVE switch preflight requires selected runtime DEMO. Actual=$selectedMode" }
if ($null -ne $state.PSObject.Properties["liveExecutionEnabled"] -and [bool]$state.liveExecutionEnabled) {
  throw "DEMO account state must not have liveExecutionEnabled=true."
}
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_SELECTED_RUNTIME=DEMO"

$bot = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$bot.state.mode -ne "PAUSE") { throw "LIVE switch preflight requires bot mode PAUSE." }
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_BOT_MODE=PAUSE"

$demoEnv = Assert-Phase7CAccountEnv -EnvFile $DemoEnvFile -AccountMode "DEMO" -RequireTrading
$liveEnv = Assert-Phase7CAccountEnv -EnvFile $LiveEnvFile -AccountMode "LIVE" -RequireTrading
if ($demoEnv.apiKey -ne $liveEnv.apiKey) { throw "DEMO and LIVE bridge API keys must match for account switching." }
if ($demoEnv.bridgeHost -ne $liveEnv.bridgeHost -or $demoEnv.bridgePort -ne $liveEnv.bridgePort) {
  throw "DEMO and LIVE bridge host/port must match for account switching."
}
if (-not (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING"))) {
  throw "LIVE compatibility capability must be explicitly enabled before account switch."
}
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_CAPABILITY=ENABLED"

$liveRiskPath = Get-Phase7CRiskProfilePath $WorkDir "LIVE"
if (-not (Test-Path -LiteralPath $liveRiskPath)) { throw "LIVE risk profile is missing: $liveRiskPath" }
$liveRiskRaw = Get-Content -LiteralPath $liveRiskPath -Raw | ConvertFrom-Json
$liveRisk = Assert-Phase7CLiveRiskProfileBinding $liveRiskRaw $LiveEnvFile "LIVE switch preflight risk profile"
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_RISK_BINDING=PASS"
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_TREND_FIXED_LOT=$($liveRisk.profile.trendFixedLot)"
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_SIDEWAY_RISK_PERCENT=$($liveRisk.profile.sidewayRiskPercent)"
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_SIDEWAY_MAX_LOT=$($liveRisk.profile.sidewayMaxLot)"

$terminalPath = ([string](Get-Phase7CEnvValue $LiveEnvFile "MT5_TERMINAL_PATH")).Trim()
$expectedLoginRaw = ([string](Get-Phase7CEnvValue $LiveEnvFile "MT5_LOGIN")).Trim()
$expectedServer = ([string](Get-Phase7CEnvValue $LiveEnvFile "MT5_SERVER")).Trim()
$expectedLogin = 0L
if ([string]::IsNullOrWhiteSpace($terminalPath) -or -not (Test-Path -LiteralPath $terminalPath)) {
  throw "LIVE MT5_TERMINAL_PATH is missing or does not exist."
}
if (-not [long]::TryParse($expectedLoginRaw, [ref]$expectedLogin) -or $expectedLogin -le 0) {
  throw "LIVE MT5_LOGIN is missing or invalid."
}
if ([string]::IsNullOrWhiteSpace($expectedServer)) { throw "LIVE MT5_SERVER is missing." }

$probePath = Join-Path $env:TEMP "phase7c-live-switch-terminal-preflight.$PID.$([guid]::NewGuid().ToString('N')).py"
$terminalLiteral = $terminalPath.Replace("'", "''")
$serverLiteral = $expectedServer.Replace("'", "''")
$python = @"
import MetaTrader5 as mt5
import sys

terminal = r'''$terminalLiteral'''
expected_login = $expectedLogin
expected_server = r'''$serverLiteral'''

if not mt5.initialize(path=terminal):
    print('PHASE7C_LIVE_SWITCH_TERMINAL_INITIALIZE=False')
    print(f'PHASE7C_LIVE_SWITCH_TERMINAL_ERROR={mt5.last_error()}')
    sys.exit(2)

try:
    terminal_info = mt5.terminal_info()
    account = mt5.account_info()
    if terminal_info is None or account is None:
        print('PHASE7C_LIVE_SWITCH_TERMINAL_INFO=False')
        print(f'PHASE7C_LIVE_SWITCH_TERMINAL_ERROR={mt5.last_error()}')
        sys.exit(3)

    print('PHASE7C_LIVE_SWITCH_TERMINAL_INITIALIZE=True')
    print(f'PHASE7C_LIVE_SWITCH_TERMINAL_LOGIN={account.login}')
    print(f'PHASE7C_LIVE_SWITCH_TERMINAL_SERVER={account.server}')
    print(f'PHASE7C_LIVE_SWITCH_TERMINAL_TRADE_ALLOWED={terminal_info.trade_allowed}')
    print(f'PHASE7C_LIVE_SWITCH_ACCOUNT_TRADE_ALLOWED={account.trade_allowed}')
    print(f'PHASE7C_LIVE_SWITCH_ACCOUNT_TRADE_EXPERT={account.trade_expert}')

    if int(account.login) != int(expected_login):
        print('PHASE7C_LIVE_SWITCH_TERMINAL_IDENTITY=FAIL_LOGIN')
        sys.exit(4)
    if str(account.server).strip().lower() != expected_server.strip().lower():
        print('PHASE7C_LIVE_SWITCH_TERMINAL_IDENTITY=FAIL_SERVER')
        sys.exit(5)
    if int(account.trade_mode) != int(getattr(mt5, 'ACCOUNT_TRADE_MODE_REAL', 2)):
        print('PHASE7C_LIVE_SWITCH_TERMINAL_IDENTITY=FAIL_MODE')
        sys.exit(6)

    print('PHASE7C_LIVE_SWITCH_TERMINAL_IDENTITY=PASS')

    if not bool(terminal_info.trade_allowed):
        print('PHASE7C_LIVE_SWITCH_TERMINAL_AUTOTRADING=DISABLED')
        sys.exit(20)
    if not bool(account.trade_allowed) or not bool(account.trade_expert):
        print('PHASE7C_LIVE_SWITCH_ACCOUNT_AUTOTRADING=DISABLED')
        sys.exit(21)

    positions = mt5.positions_get(symbol='XAUUSD.G')
    orders = mt5.orders_get(symbol='XAUUSD.G')
    if positions is None or orders is None:
        print(f'PHASE7C_LIVE_SWITCH_TERMINAL_ERROR={mt5.last_error()}')
        sys.exit(22)
    print(f'PHASE7C_LIVE_SWITCH_XAUUSD_POSITIONS={len(positions)}')
    print(f'PHASE7C_LIVE_SWITCH_XAUUSD_PENDING_ORDERS={len(orders)}')
    if len(positions) != 0 or len(orders) != 0:
        print('PHASE7C_LIVE_SWITCH_LIVE_FLAT=FAIL')
        sys.exit(23)

    print('PHASE7C_LIVE_SWITCH_TERMINAL_AUTOTRADING=ENABLED')
    print('PHASE7C_LIVE_SWITCH_LIVE_FLAT=PASS')
finally:
    mt5.shutdown()

print('PHASE7C_LIVE_SWITCH_TERMINAL_PREFLIGHT=PASS')
"@

[System.IO.File]::WriteAllText($probePath, $python, [System.Text.UTF8Encoding]::new($false))
try {
  & $BridgeVenvPython $probePath
  $probeExit = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
}
if ($probeExit -ne 0) {
  if ($probeExit -eq 20) {
    throw "LIVE MT5 terminal automated trading is disabled. Enable Algo Trading in the LIVE terminal before switching runtime; LIVE arm remains separate and DISARMED."
  }
  if ($probeExit -eq 21) {
    throw "LIVE account Expert trading permission is disabled. Account switch is blocked before runtime mutation."
  }
  throw "LIVE terminal switch preflight failed with exit code $probeExit."
}

$armPath = Get-Phase7CLiveArmPath $WorkDir
if (Test-Path -LiteralPath $armPath) { throw "LIVE arm state must be absent before account switch." }
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_STATUS=PASS"
Write-Host "PHASE7C_LIVE_SWITCH_PREFLIGHT_NEXT=EXPLICIT_ACCOUNT_SWITCH_ALLOWED"
