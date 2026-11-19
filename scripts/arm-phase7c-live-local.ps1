param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary)) { throw "Phase7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Arming Phase7C LIVE requires PowerShell Administrator."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$AccountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
if (-not (Test-Path -LiteralPath $AccountStatePath)) { throw "Account-mode state not found: $AccountStatePath" }

$accountState = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
if ([int]$accountState.version -ne 1) { throw "Unsupported account-mode state version." }
if ((ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)) -ne "LIVE") {
  throw "LIVE arm requires the selected account mode to be LIVE."
}
if ($null -ne $accountState.PSObject.Properties["liveExecutionEnabled"] -and -not [bool]$accountState.liveExecutionEnabled) {
  throw "Legacy LIVE capability gate is disabled in account-mode state."
}

if ([string]::IsNullOrWhiteSpace($EnvFile)) { $EnvFile = [string]$accountState.envFile }
if ([string]::IsNullOrWhiteSpace($EnvFile)) { throw "LIVE env file is missing from account-mode state." }
if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode "LIVE" -RequireTrading

if (-not (Test-Phase7CTruthy (Get-Phase7CEnvValue $EnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING"))) {
  throw "LIVE compatibility gate XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=1 is required locally, but it never arms LIVE by itself."
}

$terminalPath = Get-Phase7CEnvValue $EnvFile "MT5_TERMINAL_PATH"
$expectedServer = Get-Phase7CEnvValue $EnvFile "MT5_SERVER"
$expectedLoginRaw = Get-Phase7CEnvValue $EnvFile "MT5_LOGIN"
$expectedLogin = 0L
if ([string]::IsNullOrWhiteSpace($terminalPath)) { throw "LIVE arm requires an explicit MT5_TERMINAL_PATH in the local LIVE env." }
if (-not (Test-Path -LiteralPath $terminalPath)) { throw "Configured LIVE terminal64.exe path does not exist: $terminalPath" }
if ([string]::IsNullOrWhiteSpace($expectedServer)) { throw "LIVE arm requires an explicit MT5_SERVER in the local LIVE env." }
if (-not [long]::TryParse($expectedLoginRaw, [ref]$expectedLogin) -or $expectedLogin -le 0) {
  throw "LIVE arm requires an explicit positive MT5_LOGIN in the local LIVE env."
}
if ($envInfo.allowedLogins -notcontains $expectedLogin) { throw "Configured MT5_LOGIN is not in MT5_ALLOWED_LOGINS." }

function Invoke-BridgeJson([string]$Path) {
  $base = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
  return Invoke-RestMethod -Uri "$base$Path" -Headers @{ "x-mt5-api-key" = $envInfo.apiKey } -Method Get -TimeoutSec 5
}

function Read-BridgeArray([string]$Path) {
  $base = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
  $response = Invoke-WebRequest -Uri "$base$Path" -Headers @{ "x-mt5-api-key" = $envInfo.apiKey } -UseBasicParsing -TimeoutSec 5
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return @() }
  $parsed = $raw | ConvertFrom-Json
  return @($parsed | Where-Object { $null -ne $_ })
}

$health = Invoke-BridgeJson "/health"
if (-not [bool]$health.connected -or [string]$health.status -ne "ok") { throw "LIVE bridge is not healthy/connected." }
if ([string]$health.configuredAccountMode -ne "LIVE") { throw "Bridge is not bound to selected account mode LIVE." }
if ([string]$health.accountMode -ne "real") { throw "Connected MT5 account is not REAL." }
if (-not [bool]$health.tradingEnabled) { throw "MT5 bridge trading capability is disabled." }
if ([string]::IsNullOrWhiteSpace([string]$health.bridgeSessionId)) { throw "Bridge session id is unavailable; cannot bind LIVE arm." }
if ([long]$health.accountLogin -ne $expectedLogin) { throw "Connected LIVE login does not match local LIVE profile." }
if (([string]$health.server).Trim().ToLowerInvariant() -ne $expectedServer.Trim().ToLowerInvariant()) {
  throw "Connected LIVE server does not match local LIVE profile."
}
if ($envInfo.allowedLogins -notcontains [long]$health.accountLogin) { throw "Connected LIVE login is not allow-listed." }

$apiBase = $ControlApiUrl.TrimEnd('/')
$botMode = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$botMode.state.mode -ne "PAUSE") { throw "LIVE arm requires bot mode PAUSE." }

$positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
if ($positions.Count -ne 0) { throw "LIVE arm requires zero open XAUUSD positions. Current=$($positions.Count)" }
$pendingOrders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
if ($pendingOrders.Count -ne 0) { throw "LIVE arm requires zero broker pending XAUUSD orders. Current=$($pendingOrders.Count)" }

function Assert-StateFlat([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ($null -ne $state.managed) { throw "$Label state contains a managed position; LIVE arm is blocked." }
  if ($null -ne $state.PSObject.Properties["pendingEntry"] -and $null -ne $state.pendingEntry) { throw "$Label state contains a pending entry; LIVE arm is blocked." }
  if ($null -ne $state.PSObject.Properties["pendingPullback"] -and $null -ne $state.pendingPullback) { throw "$Label state contains a pending pullback; LIVE arm is blocked." }
}
Assert-StateFlat (Join-Path $WorkDir "phase7b-live-forward\phase7b-demo-state.json") "Trend"
Assert-StateFlat (Join-Path $WorkDir "phase7c-sideway-live-forward\phase7c-sideway-state.json") "Sideway"

$executionLock = Join-Path $WorkDir "phase7c-executors\phase7c-execution.lock"
if (Test-Path -LiteralPath $executionLock) { throw "Phase7C execution lock is present; LIVE arm is blocked." }

# Re-read health immediately before persistence. The session id/account identity
# must remain identical across the full safety preflight.
$healthFinal = Invoke-BridgeJson "/health"
if ([string]$healthFinal.bridgeSessionId -ne [string]$health.bridgeSessionId) { throw "Bridge restarted during LIVE arm preflight; retry from DISARMED state." }
if ([long]$healthFinal.accountLogin -ne $expectedLogin -or ([string]$healthFinal.server).Trim().ToLowerInvariant() -ne $expectedServer.Trim().ToLowerInvariant()) {
  throw "LIVE account identity changed during arm preflight."
}
if ([string]$healthFinal.accountMode -ne "real" -or [string]$healthFinal.configuredAccountMode -ne "LIVE") {
  throw "LIVE account mode changed during arm preflight."
}

$arm = Write-Phase7CLiveArmState `
  -WorkDir $WorkDir `
  -BridgeSessionId ([string]$healthFinal.bridgeSessionId) `
  -Login $expectedLogin `
  -Server $expectedServer `
  -TerminalPath $terminalPath `
  -ArmedBy "$env:USERDOMAIN\$env:USERNAME"

$confirmed = Invoke-BridgeJson "/health"
if (-not [bool]$confirmed.liveExecutionArmed -or [string]$confirmed.liveArmStatus -ne "ARMED") {
  Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "bridge-did-not-confirm-arm"
  throw "Bridge did not confirm the new LIVE arm; state was DISARMED. Reason=$($confirmed.liveArmReason)"
}

Write-Host "PHASE7C_LIVE_ARM_ACCOUNT_MODE=LIVE"
Write-Host "PHASE7C_LIVE_ARM_ACCOUNT_LOGIN=$expectedLogin"
Write-Host "PHASE7C_LIVE_ARM_SERVER=$expectedServer"
Write-Host "PHASE7C_LIVE_ARM_BRIDGE_SESSION=$($arm.bridgeSessionId)"
Write-Host "PHASE7C_LIVE_ARM_SCOPE=BRIDGE_SESSION"
Write-Host "PHASE7C_LIVE_ARM_STATUS=ARMED"
