param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [switch]$ConfirmEnableLiveCapability
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$Preflight = Join-Path $PSScriptRoot "preflight-phase7c-live-activation-local.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"

foreach ($required in @($AccountLibrary, $Preflight, $AccountStatePath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Phase7C LIVE capability gate required file not found: $required"
  }
}

if (-not $ConfirmEnableLiveCapability) {
  throw "Explicit -ConfirmEnableLiveCapability is required. Capability enablement is never implicit."
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
  throw "Enabling Phase7C LIVE capability requires PowerShell Administrator."
}

function Get-SelectedState {
  $state = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
  if ([int]$state.version -ne 1) { throw "Unsupported account-mode state version." }
  return $state
}

function Get-BotMode {
  $api = $ControlApiUrl.TrimEnd('/')
  return Invoke-RestMethod -Uri "$api/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
}

function Set-EnvLine([System.Collections.Generic.List[string]]$Lines, [string]$Name, [string]$Value) {
  $replacement = "$Name=$Value"
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $raw = ([string]$Lines[$i]).TrimStart([char]0xFEFF)
    if ($raw -match ('^' + [regex]::Escape($Name) + '=')) {
      $Lines[$i] = $replacement
      return
    }
  }
  [void]$Lines.Add($replacement)
}

function Write-LiveCapabilityAtomic {
  $lines = [System.Collections.Generic.List[string]]::new()
  foreach ($line in Get-Content -LiteralPath $LiveEnvFile) { [void]$lines.Add([string]$line) }
  Set-EnvLine $lines "MT5_TRADING_ENABLED" "true"
  Set-EnvLine $lines "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "1"

  $token = "$PID.$([guid]::NewGuid().ToString('N'))"
  $temp = "$LiveEnvFile.$token.tmp"
  $backup = "$LiveEnvFile.$token.bak"
  try {
    [System.IO.File]::WriteAllText($temp, (($lines -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))
    if ([System.IO.File]::Exists($LiveEnvFile)) {
      [System.IO.File]::Replace($temp, $LiveEnvFile, $backup)
      if ([System.IO.File]::Exists($backup)) { [System.IO.File]::Delete($backup) }
    } else {
      [System.IO.File]::Move($temp, $LiveEnvFile)
    }
  } finally {
    foreach ($candidate in @($temp, $backup)) {
      if ([System.IO.File]::Exists($candidate)) {
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

Write-Host "PHASE7C_LIVE_CAPABILITY_ENABLE=START"

$stateBefore = Get-SelectedState
$modeBefore = ConvertTo-Phase7CAccountMode ([string]$stateBefore.accountMode)
$legacyBefore = if ($null -ne $stateBefore.PSObject.Properties["liveExecutionEnabled"]) { [bool]$stateBefore.liveExecutionEnabled } else { $false }
if ($modeBefore -ne "DEMO") { throw "LIVE capability enablement requires selected runtime DEMO. Actual=$modeBefore" }
if ($legacyBefore) { throw "DEMO account state unexpectedly has liveExecutionEnabled=true." }

$botBefore = Get-BotMode
if ([string]$botBefore.state.mode -ne "PAUSE") { throw "LIVE capability enablement requires bot PAUSE." }

$demoEnv = Assert-Phase7CAccountEnv -EnvFile $DemoEnvFile -AccountMode "DEMO" -RequireTrading
$demoBase = "http://$($demoEnv.bridgeHost):$($demoEnv.bridgePort)"
$demoHeaders = @{ "x-mt5-api-key" = $demoEnv.apiKey }
$demoHealthBefore = Invoke-RestMethod -Uri "$demoBase/health" -Headers $demoHeaders -Method Get -TimeoutSec 5
if (-not $demoHealthBefore.connected -or [string]$demoHealthBefore.status -ne "ok" -or [string]$demoHealthBefore.accountMode -ne "demo") {
  throw "Current DEMO bridge is not healthy before capability enablement."
}

# The canonical activation preflight must pass immediately before capability mutation.
& $Preflight -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl -DemoEnvFile $DemoEnvFile -LiveEnvFile $LiveEnvFile
if ($LASTEXITCODE -ne 0) { throw "LIVE activation preflight failed; capability was not enabled." }
Write-Host "PHASE7C_LIVE_CAPABILITY_PREFLIGHT=PASS"

# Re-validate exact LIVE risk/profile binding after the preflight and immediately before the write.
$liveRiskPath = Get-Phase7CRiskProfilePath $WorkDir "LIVE"
if (-not (Test-Path -LiteralPath $liveRiskPath)) { throw "LIVE risk profile is missing." }
$liveRiskRaw = Get-Content -LiteralPath $liveRiskPath -Raw | ConvertFrom-Json
$liveRisk = Assert-Phase7CLiveRiskProfileBinding $liveRiskRaw $LiveEnvFile "LIVE capability risk profile"

if (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "MT5_TRADING_ENABLED")) {
  throw "MT5_TRADING_ENABLED must still be false immediately before explicit enablement."
}
if (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING")) {
  throw "LIVE compatibility gate must still be false immediately before explicit enablement."
}

# Never inherit an old arm across capability changes.
Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "live-capability-enable"
Write-LiveCapabilityAtomic
Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "live-capability-enabled"

if (-not (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "MT5_TRADING_ENABLED"))) {
  throw "MT5_TRADING_ENABLED was not enabled successfully."
}
if (-not (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING"))) {
  throw "LIVE compatibility gate was not enabled successfully."
}

$stateAfter = Get-SelectedState
$botAfter = Get-BotMode
$demoHealthAfter = Invoke-RestMethod -Uri "$demoBase/health" -Headers $demoHeaders -Method Get -TimeoutSec 5
if ((ConvertTo-Phase7CAccountMode ([string]$stateAfter.accountMode)) -ne "DEMO") { throw "Selected runtime changed during capability enablement." }
if ([string]$botAfter.state.mode -ne "PAUSE") { throw "Bot mode changed during capability enablement." }
if ([string]$demoHealthAfter.bridgeSessionId -ne [string]$demoHealthBefore.bridgeSessionId) { throw "DEMO bridge session changed during capability enablement." }
if ([long]$demoHealthAfter.accountLogin -ne [long]$demoHealthBefore.accountLogin) { throw "DEMO login changed during capability enablement." }

Write-Host "PHASE7C_LIVE_CAPABILITY_SELECTED_RUNTIME=DEMO"
Write-Host "PHASE7C_LIVE_CAPABILITY_BOT_MODE=PAUSE"
Write-Host "PHASE7C_LIVE_CAPABILITY_DEMO_SESSION_UNCHANGED=PASS"
Write-Host "PHASE7C_LIVE_CAPABILITY_RISK_BINDING=PASS"
Write-Host "PHASE7C_LIVE_CAPABILITY_TREND_FIXED_LOT=$($liveRisk.profile.trendFixedLot)"
Write-Host "PHASE7C_LIVE_CAPABILITY_SIDEWAY_RISK_PERCENT=$($liveRisk.profile.sidewayRiskPercent)"
Write-Host "PHASE7C_LIVE_CAPABILITY_SIDEWAY_MAX_LOT=$($liveRisk.profile.sidewayMaxLot)"
Write-Host "PHASE7C_LIVE_CAPABILITY_MT5_TRADING_ENABLED=True"
Write-Host "PHASE7C_LIVE_CAPABILITY_COMPATIBILITY_GATE=True"
Write-Host "PHASE7C_LIVE_CAPABILITY_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_LIVE_CAPABILITY_STATUS=ENABLED_DISARMED"
Write-Host "PHASE7C_LIVE_CAPABILITY_NEXT=EXPLICIT_LIVE_ACCOUNT_SWITCH_APPROVAL_REQUIRED"
