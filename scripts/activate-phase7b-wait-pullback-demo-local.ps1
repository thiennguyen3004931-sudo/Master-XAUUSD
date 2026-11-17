param(
  [string]$WorkDir = "F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward",
  [string]$BridgeTask = "XAUUSD-MT5-Bridge",
  [string]$BotTask = "XAUUSD-Phase7B-Bot",
  [switch]$ResetBotState,
  [switch]$StartBot
)

$ErrorActionPreference = "Stop"
$PullbackWaitMinutes = 15
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
$UpgradeScript = Join-Path $ProjectRoot "scripts\upgrade-phase7b-wait-pullback-demo-local.ps1"
$DemoDir = Join-Path $WorkDir "phase7b-demo-forward"
$StatePath = Join-Path $DemoDir "phase7b-demo-state.json"
$JournalPath = Join-Path $DemoDir "phase7b-demo-events.jsonl"

function Read-EnvValue([string]$File, [string]$Name) {
  if (-not (Test-Path $File)) { return $null }
  foreach ($raw in Get-Content -LiteralPath $File) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    $key = $line.Substring(0, $index).Trim()
    if ($key -ne $Name) { continue }
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
  }
  return $null
}

function Invoke-BridgeJson([string]$Method, [string]$Url, [string]$ApiKey) {
  $headers = @{ "x-mt5-api-key" = $ApiKey }
  return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -TimeoutSec 8
}

function Require-DemoHealth($Health) {
  if (-not $Health.connected -or $Health.status -ne "ok") {
    throw "MT5 bridge is not healthy/connected."
  }
  if ($Health.accountMode -ne "demo") {
    throw "Phase 7B WAIT_PULLBACK activation requires DEMO account. Current mode=$($Health.accountMode)."
  }
  if (-not $Health.tradingEnabled) {
    throw "MT5 bridge trading is disabled."
  }
  if (-not $Health.terminalTradeAllowed -or -not $Health.expertTradeAllowed) {
    throw "MT5 terminal/expert automated trading is not enabled."
  }
}

if (-not (Test-Path $BridgeEnv)) { throw "Phase 7B DEMO bridge env not found: $BridgeEnv" }
if (-not (Test-Path $UpgradeScript)) { throw "Phase 7B WAIT_PULLBACK upgrade script not found: $UpgradeScript" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $DemoDir | Out-Null

$apiKey = Read-EnvValue $BridgeEnv "MT5_API_KEY"
$bridgeHost = Read-EnvValue $BridgeEnv "MT5_BRIDGE_HOST"
$bridgePort = Read-EnvValue $BridgeEnv "MT5_BRIDGE_PORT"
$allowReal = Read-EnvValue $BridgeEnv "MT5_ALLOW_REAL_ACCOUNT"
if (-not $apiKey) { throw "MT5_API_KEY is missing from $BridgeEnv" }
if (-not $bridgeHost) { $bridgeHost = "127.0.0.1" }
if (-not $bridgePort) { $bridgePort = "8765" }
if ($allowReal -match '^(1|true|yes|on)$') {
  throw "Refusing activation because MT5_ALLOW_REAL_ACCOUNT=true in DEMO bridge env."
}
$bridgeBase = "http://${bridgeHost}:${bridgePort}"

$bridgeTaskInfo = Get-ScheduledTask -TaskName $BridgeTask -ErrorAction Stop
$botTaskInfo = Get-ScheduledTask -TaskName $BotTask -ErrorAction Stop

Write-Host "PHASE7B_WAIT_PULLBACK_ACTIVATION=START"
Write-Host "PHASE7B_WAIT_PULLBACK_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_WAIT_PULLBACK_EXPIRY=15_MIN_PROVISIONAL"
Write-Host "PHASE7B_WAIT_PULLBACK_WORK_DIR=$WorkDir"
Write-Host "PHASE7B_WAIT_PULLBACK_BRIDGE_TASK=$BridgeTask"
Write-Host "PHASE7B_WAIT_PULLBACK_BOT_TASK=$BotTask"

if ($botTaskInfo.State -eq "Running") {
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_STOP=START"
  Stop-ScheduledTask -TaskName $BotTask
  Start-Sleep -Seconds 2
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_STOP=PASS"
}

if ($bridgeTaskInfo.State -ne "Running") {
  Write-Host "PHASE7B_WAIT_PULLBACK_BRIDGE_START=START"
  Start-ScheduledTask -TaskName $BridgeTask
}

$health = $null
for ($attempt = 1; $attempt -le 20; $attempt++) {
  try {
    $health = Invoke-BridgeJson "GET" "$bridgeBase/health" $apiKey
    if ($health.connected -and $health.status -eq "ok") { break }
  } catch {
    if ($attempt -eq 20) { throw }
  }
  Start-Sleep -Seconds 1
}
if ($null -eq $health) { throw "MT5 bridge health did not become available." }
Require-DemoHealth $health

Write-Host "PHASE7B_WAIT_PULLBACK_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_WAIT_PULLBACK_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_WAIT_PULLBACK_SERVER=$($health.server)"
Write-Host "PHASE7B_WAIT_PULLBACK_BRIDGE_HEALTH=PASS"

$positions = @(Invoke-BridgeJson "GET" "$bridgeBase/v1/positions?symbol=XAUUSD" $apiKey)
if ($positions.Count -gt 0) {
  $tickets = ($positions | ForEach-Object { $_.ticket }) -join ","
  throw "Clean activation required: XAUUSD DEMO positions are still open. Count=$($positions.Count), tickets=$tickets. Close them before activation."
}
Write-Host "PHASE7B_WAIT_PULLBACK_OPEN_XAUUSD_POSITIONS=0"

if (Test-Path $StatePath) {
  $existingState = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  if ($null -ne $existingState.accountLogin -and [long]$existingState.accountLogin -ne [long]$health.accountLogin) {
    throw "Bot state belongs to account $($existingState.accountLogin), current DEMO account is $($health.accountLogin). Use -ResetBotState only after confirming this is intentional."
  }
  if (-not $ResetBotState) {
    if ($null -ne $existingState.managed) {
      throw "Bot state still contains a managed position. Clean it or rerun with -ResetBotState after confirming no broker position exists."
    }
    if ($existingState.PSObject.Properties.Name -contains "pendingPullback" -and $null -ne $existingState.pendingPullback) {
      throw "Bot state still contains a pending WAIT_PULLBACK setup. Let it resolve or rerun with -ResetBotState for a clean activation."
    }
  }
}

if ($ResetBotState) {
  if (Test-Path $StatePath) { Remove-Item -LiteralPath $StatePath -Force }
  if (Test-Path $JournalPath) { Remove-Item -LiteralPath $JournalPath -Force }
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_STATE_RESET=YES"
} else {
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_STATE_RESET=NO"
}

Write-Host "PHASE7B_WAIT_PULLBACK_UPGRADE_PREVIEW=START"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $UpgradeScript -WorkDir $WorkDir -WaitMinutes $PullbackWaitMinutes
if ($LASTEXITCODE -ne 0) {
  throw "Phase 7B WAIT_PULLBACK upgrade/preview failed with exit code $LASTEXITCODE"
}
Write-Host "PHASE7B_WAIT_PULLBACK_UPGRADE_PREVIEW=PASS"

if (-not (Test-Path $StatePath)) {
  throw "Phase 7B demo state was not created by the unarmed preview: $StatePath"
}
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
if ([int]$state.version -ne 2) { throw "Expected Phase 7B demo state version 2, got $($state.version)." }
if ($null -ne $state.managed) { throw "Activation refused: managed state is not null after preview." }
if ($null -ne $state.pendingPullback) { throw "Activation refused: pendingPullback is not null after clean preview." }
if ([long]$state.accountLogin -ne [long]$health.accountLogin) {
  throw "Activation refused: state account $($state.accountLogin) does not match DEMO account $($health.accountLogin)."
}

Write-Host "PHASE7B_WAIT_PULLBACK_STATE_VERSION=2"
Write-Host "PHASE7B_WAIT_PULLBACK_MANAGED_STATE=CLEAN"
Write-Host "PHASE7B_WAIT_PULLBACK_PENDING_STATE=CLEAN"
Write-Host "PHASE7B_WAIT_PULLBACK_ACTIVATION_READY=YES"

if ($StartBot) {
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_START=START"
  Start-ScheduledTask -TaskName $BotTask
  Start-Sleep -Seconds 2
  $botAfter = Get-ScheduledTask -TaskName $BotTask
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_TASK_STATE=$($botAfter.State)"
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_START=REQUESTED"
} else {
  Write-Host "PHASE7B_WAIT_PULLBACK_BOT_START=SKIPPED"
  Write-Host "PHASE7B_WAIT_PULLBACK_ORDER_SEND=DISABLED_UNTIL_STARTBOT"
}

Write-Host "PHASE7B_WAIT_PULLBACK_ACTIVATION=PASS"
Write-Host "PHASE7B_WAIT_PULLBACK_BRIDGE_LEFT_RUNNING=YES"
