param(
  [Parameter(Mandatory = $true)] [double]$TrendFixedLot,
  [Parameter(Mandatory = $true)] [double]$SidewayRiskPercent,
  [Parameter(Mandatory = $true)] [double]$SidewayMaxLot,
  [string]$WorkDir = ".runtime",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [string]$ControlApiUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary)) { throw "Phase7C account-mode library not found: $AccountLibrary" }
. $AccountLibrary

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "LIVE risk configuration requires PowerShell Administrator."
}

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

$WorkDir = Resolve-ProjectPath $WorkDir
$LiveEnvFile = Resolve-ProjectPath $LiveEnvFile
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
if (-not (Test-Path -LiteralPath $LiveEnvFile)) { throw "LIVE env file not found: $LiveEnvFile" }
$LiveEnvFile = (Resolve-Path -LiteralPath $LiveEnvFile).Path

$accountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
if (-not (Test-Path -LiteralPath $accountStatePath)) { throw "Account state is missing: $accountStatePath" }
$accountState = Get-Content -LiteralPath $accountStatePath -Raw | ConvertFrom-Json
$currentMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
$currentLiveEnabled = [bool]$accountState.liveExecutionEnabled
Write-Host "PHASE7C_LIVE_RISK_CURRENT_ACCOUNT_MODE=$currentMode"
if ($currentMode -ne "DEMO" -or $currentLiveEnabled) {
  throw "LIVE risk must be prepared while runtime remains DEMO with LIVE execution disabled."
}

$api = $ControlApiUrl.TrimEnd('/')
$botMode = Invoke-RestMethod -Uri "$api/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$currentBotMode = ([string]$botMode.state.mode).Trim().ToUpperInvariant()
Write-Host "PHASE7C_LIVE_RISK_BOT_MODE=$currentBotMode"
if ($currentBotMode -ne "PAUSE") { throw "LIVE risk configuration requires bot mode PAUSE." }

$liveEnv = Assert-Phase7CAccountEnv -EnvFile $LiveEnvFile -AccountMode "LIVE"
if ($liveEnv.tradingEnabled) { throw "LIVE risk must be configured while MT5_TRADING_ENABLED=false." }
if (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING")) {
  throw "LIVE risk must be configured while XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=false."
}

$profileIdentity = Get-Phase7CLiveProfileIdentity $LiveEnvFile
if (-not [System.IO.Path]::IsPathRooted($profileIdentity.terminalPath)) {
  throw "Configured LIVE MT5_TERMINAL_PATH must be absolute."
}
if (-not (Test-Path -LiteralPath $profileIdentity.terminalPath)) {
  throw "Configured LIVE terminal64.exe does not exist: $($profileIdentity.terminalPath)"
}
if ([System.IO.Path]::GetFileName($profileIdentity.terminalPath) -notmatch '^(?i:terminal64\.exe)$') {
  throw "Configured LIVE MT5_TERMINAL_PATH must point to terminal64.exe."
}

$validated = Assert-Phase7CRiskProfile ([pscustomobject]@{
  version = 1
  trendFixedLot = $TrendFixedLot
  sidewayRiskPercent = $SidewayRiskPercent
  sidewayMaxLot = $SidewayMaxLot
}) "Requested LIVE risk profile"

Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "live-risk-profile-configured"

$profile = [pscustomobject]@{
  version = 1
  accountMode = "LIVE"
  accountLogin = [long]$profileIdentity.login
  server = [string]$profileIdentity.server
  profileFingerprint = [string]$profileIdentity.profileFingerprint
  trendFixedLot = [double]$validated.trendFixedLot
  sidewayRiskPercent = [double]$validated.sidewayRiskPercent
  sidewayMaxLot = [double]$validated.sidewayMaxLot
  appliesTo = "NEW_POSITIONS_ONLY"
  martingale = $false
  recoveryLotEscalation = $false
  updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  updatedBy = [Security.Principal.WindowsIdentity]::GetCurrent().Name
}

[void](Assert-Phase7CLiveRiskProfileBinding -Profile $profile -LiveEnvFile $LiveEnvFile -Label "Requested LIVE risk profile")
$riskPath = Get-Phase7CRiskProfilePath $WorkDir "LIVE"
Write-Phase7CAccountJsonAtomic -Path $riskPath -Value $profile -Depth 6

$stored = Get-Content -LiteralPath $riskPath -Raw | ConvertFrom-Json
$binding = Assert-Phase7CLiveRiskProfileBinding -Profile $stored -LiveEnvFile $LiveEnvFile -Label "Stored LIVE risk profile"

Write-Host "PHASE7C_LIVE_RISK_ACCOUNT_MODE=LIVE"
Write-Host "PHASE7C_LIVE_RISK_ACCOUNT_LOGIN=$($binding.login)"
Write-Host "PHASE7C_LIVE_RISK_SERVER=$($binding.server)"
Write-Host "PHASE7C_LIVE_RISK_TREND_FIXED_LOT=$($binding.profile.trendFixedLot)"
Write-Host "PHASE7C_LIVE_RISK_SIDEWAY_RISK_PERCENT=$($binding.profile.sidewayRiskPercent)"
Write-Host "PHASE7C_LIVE_RISK_SIDEWAY_MAX_LOT=$($binding.profile.sidewayMaxLot)"
Write-Host "PHASE7C_LIVE_RISK_APPLIES_TO=NEW_POSITIONS_ONLY"
Write-Host "PHASE7C_LIVE_RISK_MARTINGALE=False"
Write-Host "PHASE7C_LIVE_RISK_RECOVERY_ESCALATION=False"
Write-Host "PHASE7C_LIVE_RISK_PROFILE_BINDING=PASS"
Write-Host "PHASE7C_LIVE_RISK_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_LIVE_RISK_STATUS=PASS"