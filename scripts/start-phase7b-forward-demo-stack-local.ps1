param(
  [string]$WorkDir = "",
  [string]$TelegramEnv = ".env.phase7b-telegram",
  [decimal]$FixedVolume = 0.03,
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkDir)) { $WorkDir = Join-Path $Root ".runtime" }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path

$bridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
if (-not (Test-Path $bridgeEnv)) { throw "Missing DEMO bridge env: $bridgeEnv" }

$values = @{}
foreach ($raw in Get-Content $bridgeEnv) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $i = $line.IndexOf("=")
  $name = $line.Substring(0, $i).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
  $values[$name] = $value
}

$key = [string]$values["MT5_API_KEY"]
if ([string]::IsNullOrWhiteSpace($key) -or $key.Length -lt 16) { throw "Invalid MT5_API_KEY in DEMO env." }
if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "DEMO launcher refuses MT5_ALLOW_REAL_ACCOUNT=true." }
$hostName = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
$port = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { "8765" } else { [string]$values["MT5_BRIDGE_PORT"] }
$bridgeBase = "http://${hostName}:${port}"

try {
  $health = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers @{ "x-mt5-api-key" = $key } -Method Get -TimeoutSec 8
} catch {
  throw "DEMO bridge preflight failed: $($_.Exception.Message)"
}

Write-Host "PHASE7B_FORWARD_BRIDGE=PASS"
Write-Host "PHASE7B_FORWARD_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_FORWARD_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_FORWARD_SERVER=$($health.server)"
Write-Host "PHASE7B_FORWARD_TRADING_ENABLED=$($health.tradingEnabled)"
Write-Host "PHASE7B_FORWARD_TERMINAL_TRADE_ALLOWED=$($health.terminalTradeAllowed)"
Write-Host "PHASE7B_FORWARD_EXPERT_TRADE_ALLOWED=$($health.expertTradeAllowed)"

if (-not $health.connected -or $health.status -ne "ok") { throw "MT5 bridge/terminal is not healthy." }
if ($health.accountMode -ne "demo") { throw "Forward launcher requires DEMO account, got $($health.accountMode)." }
if (-not $health.tradingEnabled) { throw "Bridge trading is disabled in .env.phase7b-demo." }
if (-not $health.terminalTradeAllowed -or -not $health.expertTradeAllowed) { throw "Enable Algo/Expert Trading in MT5 before starting DEMO forward." }

$allowed = @(([string]$values["MT5_ALLOWED_LOGINS"] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($allowed.Count -eq 0 -or -not ($allowed -contains [string]$health.accountLogin)) {
  throw "Current DEMO login $($health.accountLogin) is not present in MT5_ALLOWED_LOGINS in .env.phase7b-demo."
}

if (-not [System.IO.Path]::IsPathRooted($TelegramEnv)) { $TelegramEnv = Join-Path $Root $TelegramEnv }
if (-not (Test-Path $TelegramEnv)) {
  throw "Telegram env missing: $TelegramEnv. Configure ZIQ_TELEGRAM_BOT_TOKEN and ZIQ_TELEGRAM_CHAT_ID before starting the full stack."
}

& (Join-Path $PSScriptRoot "run-phase7b-demo-local.ps1") -WorkDir $WorkDir -FixedVolume $FixedVolume -Once
if ($LASTEXITCODE -ne 0) { throw "Phase 7B read-only preflight failed." }

& (Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-local.ps1") -WorkDir $WorkDir -EnvFile $TelegramEnv -SendTest -Once
if ($LASTEXITCODE -ne 0) { throw "Telegram connectivity test failed." }
Write-Host "PHASE7B_FORWARD_TELEGRAM_TEST=PASS"

$apiUrl = "http://127.0.0.1:${ApiPort}"
$webUrl = "http://127.0.0.1:${WebPort}"
$expectedRule = "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"
$apiListener = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue
$webListener = Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue

if ($apiListener) {
  try {
    $snapshot = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 5
    $actualRule = [string]$snapshot.entryDiagnostics.entry.rule
    if ($actualRule -ne $expectedRule) {
      throw "Existing API rule '$actualRule' does not match '$expectedRule'."
    }
    Write-Host "PHASE7B_FORWARD_EXISTING_API=VALIDATED"
    Write-Host "PHASE7B_FORWARD_EXISTING_API_RULE=$actualRule"
  } catch {
    throw "Port $ApiPort is already in use but is not a validated Phase 7B forward API: $($_.Exception.Message)"
  }
}

if (-not $apiListener -and -not $webListener) {
  & (Join-Path $PSScriptRoot "run-phase7b-demo-web-local.ps1") -WorkDir $WorkDir -BridgeEnv $bridgeEnv -ApiPort $ApiPort -WebPort $WebPort
} elseif ($apiListener -and -not $webListener) {
  $escapedRootForWeb = $Root.Replace("'", "''")
  $webCommand = "Set-Location '$escapedRootForWeb'; `$env:VITE_API_BASE_URL=''; `$env:VITE_DEV_API_PROXY_TARGET='$apiUrl'; Write-Host 'PHASE7B_WEB_API_TRANSPORT=SAME_ORIGIN_VITE_PROXY'; Write-Host 'PHASE7B_WEB_UI=$webUrl/phase7b-demo'; pnpm --filter @xauusd/web dev -- --host 127.0.0.1 --port $WebPort --strictPort"
  $webProcess = Start-Process powershell.exe -PassThru -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", $webCommand
  )
  Write-Host "PHASE7B_FORWARD_EXISTING_API_REUSED=True"
  Write-Host "PHASE7B_FORWARD_WEB_STARTED=True"
  Write-Host "PHASE7B_FORWARD_WEB_WINDOW_PID=$($webProcess.Id)"
} elseif (-not $apiListener -and $webListener) {
  throw "Web port $WebPort is already active but API port $ApiPort is not. Stop the stale web process and rerun."
} else {
  Write-Host "PHASE7B_FORWARD_EXISTING_API_REUSED=True"
  Write-Host "PHASE7B_FORWARD_EXISTING_WEB_REUSED=True"
}

$escapedRoot = $Root.Replace("'", "''")
$escapedWork = $WorkDir.Replace("'", "''")
$escapedTelegram = $TelegramEnv.Replace("'", "''")

$notifierCmd = "Set-Location '$escapedRoot'; & '.\scripts\run-phase7b-telegram-notifier-local.ps1' -WorkDir '$escapedWork' -EnvFile '$escapedTelegram'"
$notifierWindow = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $notifierCmd)

$onlineCmd = "Set-Location '$escapedRoot'; & '.\scripts\run-phase7b-bot-online-telegram.ps1' -WorkDir '$escapedWork' -EnvFile '$escapedTelegram' -FixedVolume $FixedVolume"
$onlineWindow = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $onlineCmd)

$botCmd = "Set-Location '$escapedRoot'; & '.\scripts\run-phase7b-demo-local.ps1' -WorkDir '$escapedWork' -FixedVolume $FixedVolume -ArmDemoTrading"
$botWindow = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $botCmd)

Write-Host "PHASE7B_FORWARD_STACK_START=PASS"
Write-Host "PHASE7B_FORWARD_ENTRY=DUAL_PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"
Write-Host "PHASE7B_FORWARD_FVG=CONTEXT_ONLY_NOT_ENTRY_GATE"
Write-Host "PHASE7B_FORWARD_MANAGEMENT=PLUS6_BE_PLUS10_ONE_THIRD_CANONICAL_RUNNER"
Write-Host "PHASE7B_FORWARD_BUY_SELL=DEMO_FORWARD_OBSERVATION"
Write-Host "PHASE7B_FORWARD_FIXED_VOLUME=$FixedVolume"
Write-Host "PHASE7B_FORWARD_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_FORWARD_BOT_WINDOW_PID=$($botWindow.Id)"
Write-Host "PHASE7B_FORWARD_TELEGRAM_WINDOW_PID=$($notifierWindow.Id)"
Write-Host "PHASE7B_FORWARD_ONLINE_WATCHER_PID=$($onlineWindow.Id)"
Write-Host "PHASE7B_FORWARD_WEB=$webUrl/phase7b-demo"
Write-Host "PHASE7B_FORWARD_API=$apiUrl/api/v1/phase7b-demo"
