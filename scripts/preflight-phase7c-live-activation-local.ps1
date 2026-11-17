param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [string]$ExecutorTaskName = "XAUUSD-Phase7C-Executors",
  [string]$BridgeTaskName = "XAUUSD-Phase7C-Bridge"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$ReadOnlyProbe = Join-Path $PSScriptRoot "probe-phase7c-live-readonly-local.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"
$TaskConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"

foreach ($required in @($AccountLibrary, $ReadOnlyProbe, $AccountStatePath, $TaskConfigPath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Phase7C LIVE activation preflight required file not found: $required"
  }
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
  throw "LIVE activation preflight requires PowerShell Administrator."
}

function Read-BridgeArray([string]$Base, [hashtable]$Headers, [string]$Path) {
  $response = Invoke-WebRequest -Uri "$Base$Path" -Headers $Headers -UseBasicParsing -TimeoutSec 5
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return @() }
  $parsed = $raw | ConvertFrom-Json
  return @($parsed | Where-Object { $null -ne $_ })
}

function Assert-FlatState([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $state = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ($null -ne $state.managed) { throw "$Label state contains a managed position." }
  if ($null -ne $state.PSObject.Properties["pendingEntry"] -and $null -ne $state.pendingEntry) {
    throw "$Label state contains a pending entry."
  }
  if ($null -ne $state.PSObject.Properties["pendingPullback"] -and $null -ne $state.pendingPullback) {
    throw "$Label state contains a pending pullback."
  }
}

Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT=START"

$accountState = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
if ([int]$accountState.version -ne 1) { throw "Unsupported account-mode state version." }
$selectedMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
$liveEnabledState = if ($null -ne $accountState.PSObject.Properties["liveExecutionEnabled"]) { [bool]$accountState.liveExecutionEnabled } else { $false }
if ($selectedMode -ne "DEMO") { throw "Preflight requires the selected runtime to remain DEMO. Actual=$selectedMode" }
if ($liveEnabledState) { throw "DEMO account state unexpectedly enables LIVE capability." }
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_SELECTED_RUNTIME=DEMO"

$apiBase = $ControlApiUrl.TrimEnd('/')
$bot = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$bot.state.mode -ne "PAUSE") { throw "Preflight requires bot mode PAUSE." }
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_BOT_MODE=PAUSE"

$demoEnv = Assert-Phase7CAccountEnv -EnvFile $DemoEnvFile -AccountMode "DEMO" -RequireTrading
$demoBase = "http://$($demoEnv.bridgeHost):$($demoEnv.bridgePort)"
$demoHeaders = @{ "x-mt5-api-key" = $demoEnv.apiKey }
$demoHealth = Invoke-RestMethod -Uri "$demoBase/health" -Headers $demoHeaders -Method Get -TimeoutSec 5
if (-not $demoHealth.connected -or [string]$demoHealth.status -ne "ok" -or [string]$demoHealth.accountMode -ne "demo") {
  throw "Current DEMO bridge is not healthy and verified."
}
if ($demoEnv.allowedLogins -notcontains [long]$demoHealth.accountLogin) {
  throw "Current DEMO login is not allow-listed."
}
$demoPositions = @(Read-BridgeArray $demoBase $demoHeaders "/v1/positions?symbol=XAUUSD")
$demoOrders = @(Read-BridgeArray $demoBase $demoHeaders "/v1/orders?symbol=XAUUSD")
if ($demoPositions.Count -ne 0) { throw "Current DEMO must be flat before LIVE activation preparation. Positions=$($demoPositions.Count)" }
if ($demoOrders.Count -ne 0) { throw "Current DEMO must have zero pending XAUUSD orders. Orders=$($demoOrders.Count)" }
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_DEMO_FLAT=PASS"

$liveIdentity = Get-Phase7CLiveProfileIdentity $LiveEnvFile
if (-not (Test-Path -LiteralPath $liveIdentity.terminalPath)) { throw "Configured LIVE terminal path does not exist." }
$demoTerminal = ([string](Get-Phase7CEnvValue $DemoEnvFile "MT5_TERMINAL_PATH")).Trim()
if (-not [string]::IsNullOrWhiteSpace($demoTerminal)) {
  $demoFull = [System.IO.Path]::GetFullPath($demoTerminal).TrimEnd('\\').ToLowerInvariant()
  $liveFull = [System.IO.Path]::GetFullPath($liveIdentity.terminalPath).TrimEnd('\\').ToLowerInvariant()
  if ($demoFull -eq $liveFull) { throw "DEMO and LIVE terminal64.exe paths must remain separate." }
}
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_TERMINAL_SEPARATE=PASS"

$liveEnv = Assert-Phase7CAccountEnv -EnvFile $LiveEnvFile -AccountMode "LIVE"
if ($liveEnv.tradingEnabled) { throw "Preflight requires MT5_TRADING_ENABLED=false until explicit operator approval." }
if (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING")) {
  throw "Preflight requires XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=false until explicit operator approval."
}
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_LIVE_CAPABILITY=DISABLED"

$liveRiskPath = Get-Phase7CRiskProfilePath $WorkDir "LIVE"
if (-not (Test-Path -LiteralPath $liveRiskPath)) { throw "LIVE risk profile is missing: $liveRiskPath" }
$liveRiskRaw = Get-Content -LiteralPath $liveRiskPath -Raw | ConvertFrom-Json
$liveRisk = Assert-Phase7CLiveRiskProfileBinding $liveRiskRaw $LiveEnvFile "LIVE activation preflight risk profile"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_RISK_BINDING=PASS"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_TREND_FIXED_LOT=$($liveRisk.profile.trendFixedLot)"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_SIDEWAY_RISK_PERCENT=$($liveRisk.profile.sidewayRiskPercent)"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_SIDEWAY_MAX_LOT=$($liveRisk.profile.sidewayMaxLot)"

Assert-FlatState (Join-Path $WorkDir "phase7b-live-forward\phase7b-demo-state.json") "LIVE Trend"
Assert-FlatState (Join-Path $WorkDir "phase7c-sideway-live-forward\phase7c-sideway-state.json") "LIVE Sideway"
$executionLock = Join-Path $WorkDir "phase7c-executors\phase7c-execution.lock"
if (Test-Path -LiteralPath $executionLock) { throw "Phase7C execution lock is present." }
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_LIVE_STATE_FLAT=PASS"

foreach ($taskSpec in @(
  [pscustomobject]@{ name = $BridgeTaskName; pattern = "run-phase7c-account-bridge-task-runner-local.ps1" },
  [pscustomobject]@{ name = $ExecutorTaskName; pattern = "run-phase7c-executor-task-runner-local.ps1" }
)) {
  $task = Get-ScheduledTask -TaskName $taskSpec.name -ErrorAction Stop
  $actions = @($task.Actions)
  $text = if ($actions.Count -eq 1) { "$($actions[0].Execute) $($actions[0].Arguments)" } else { "MULTIPLE_ACTIONS" }
  if ($actions.Count -ne 1 -or $text -notlike "*$($taskSpec.pattern)*") {
    throw "Scheduled Task is not bound to the verified startup runner: $($taskSpec.name)"
  }
}
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_TASK_OWNERSHIP=PASS"

# Re-run the isolated LIVE bridge proof immediately before reporting readiness.
# This helper itself never selects LIVE, enables capability, starts executors, or sends an order.
& $ReadOnlyProbe -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl -DemoEnvFile $DemoEnvFile -LiveEnvFile $LiveEnvFile
if ($LASTEXITCODE -ne 0) { throw "Isolated LIVE read-only proof failed during activation preflight." }
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_LIVE_READONLY_PROOF=PASS"

$accountFinal = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
$botFinal = Invoke-RestMethod -Uri "$apiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
$demoHealthFinal = Invoke-RestMethod -Uri "$demoBase/health" -Headers $demoHeaders -Method Get -TimeoutSec 5
if ((ConvertTo-Phase7CAccountMode ([string]$accountFinal.accountMode)) -ne "DEMO") { throw "Selected runtime changed during preflight." }
if ([string]$botFinal.state.mode -ne "PAUSE") { throw "Bot mode changed during preflight." }
if ([string]$demoHealthFinal.bridgeSessionId -ne [string]$demoHealth.bridgeSessionId) { throw "DEMO bridge session changed during preflight." }
if ([long]$demoHealthFinal.accountLogin -ne [long]$demoHealth.accountLogin) { throw "DEMO login changed during preflight." }
if (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "MT5_TRADING_ENABLED")) { throw "LIVE MT5_TRADING_ENABLED changed during preflight." }
if (Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING")) { throw "LIVE compatibility gate changed during preflight." }

Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_DEMO_SESSION_UNCHANGED=PASS"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_STATUS=PASS"
Write-Host "PHASE7C_LIVE_ACTIVATION_PREFLIGHT_NEXT=EXPLICIT_OPERATOR_APPROVAL_REQUIRED"
