param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [Parameter(Mandatory = $true)] [string]$TerminalPath,
  [Parameter(Mandatory = $true)] [long]$ExpectedLogin,
  [string]$ExpectedServer = "",
  [decimal]$FixedVolume = 0.03,
  [int]$IntervalSeconds = 5,
  [int]$BridgeWaitSeconds = 90
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$TerminalPath = (Resolve-Path $TerminalPath).Path
$BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
$DemoDir = Join-Path $WorkDir "phase7b-demo-forward"
$ArchiveRoot = Join-Path $WorkDir "phase7b-account-archives"
$BotTask = "XAUUSD-Phase7B-Bot"
$TelegramTask = "XAUUSD-Phase7B-Telegram"
$BridgeTask = "XAUUSD-Phase7B-Bridge"
$WebTask = "XAUUSD-Phase7B-Web"

if (-not (Test-Path $BridgeEnv)) { throw "Phase 7B bridge env not found: $BridgeEnv" }
if ($ExpectedLogin -le 0) { throw "ExpectedLogin must be positive." }
if ($FixedVolume -le 0) { throw "FixedVolume must be positive." }
if ($IntervalSeconds -lt 1) { throw "IntervalSeconds must be >= 1." }

function Read-EnvMap([string]$Path) {
  $map = @{}
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $parts = $line -split "=", 2
    $name = $parts[0].Trim().TrimStart([char]0xFEFF)
    $value = $parts[1].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$name] = $value
  }
  return $map
}

function Set-EnvKeys([string]$Path, [hashtable]$Updates) {
  $lines = [System.Collections.Generic.List[string]]::new()
  Get-Content $Path | ForEach-Object { [void]$lines.Add($_) }
  foreach ($key in $Updates.Keys) {
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i += 1) {
      if ($lines[$i] -match ('^\s*' + [regex]::Escape($key) + '\s*=')) {
        $lines[$i] = "$key=$($Updates[$key])"
        $found = $true
        break
      }
    }
    if (-not $found) { [void]$lines.Add("$key=$($Updates[$key])") }
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($Path, $lines, $utf8NoBom)
}

function Stop-TaskSafe([string]$Name) {
  try { Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue } catch {}
}

function Start-TaskSafe([string]$Name) {
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) { throw "Scheduled Task is missing: $Name" }
  Start-ScheduledTask -TaskName $Name
}

function Stop-BotProcess {
  $runtimePath = Join-Path $DemoDir "phase7b-demo-runtime.json"
  if (-not (Test-Path $runtimePath)) { return }
  try {
    $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
    if ($null -ne $runtime.pid -and [int]$runtime.pid -gt 0) {
      Stop-Process -Id ([int]$runtime.pid) -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Stop-TelegramProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*run-phase7b-telegram-notifier.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Stop-BridgeListener([int]$Port) {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($owner in $owners) {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
  }
}

function Get-BridgeHealth([string]$Base, [string]$ApiKey, [int]$TimeoutSec = 5) {
  return Invoke-RestMethod -Uri "$Base/health" -Headers @{ "x-mt5-api-key" = $ApiKey } -Method Get -TimeoutSec $TimeoutSec
}

function Assert-FlatBeforeSwitch([hashtable]$OldEnv) {
  $runtimePath = Join-Path $DemoDir "phase7b-demo-runtime.json"
  $statePath = Join-Path $DemoDir "phase7b-demo-state.json"
  if (Test-Path $statePath) {
    try {
      $state = Get-Content $statePath -Raw | ConvertFrom-Json
      if ($null -ne $state.managed) {
        throw "Phase 7B currently has a managed position. Close/manage it with the current bot before switching account."
      }
    } catch {
      if ($_.Exception.Message -like "*managed position*") { throw }
    }
  }

  if (Test-Path $runtimePath) {
    try {
      $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
      Write-Host "PHASE7B_SWITCH_CURRENT_RUNTIME_STATUS=$($runtime.status)"
      Write-Host "PHASE7B_SWITCH_CURRENT_RUNTIME_ARMED=$($runtime.armed)"
    } catch {}
  }

  $apiKey = [string]$OldEnv["MT5_API_KEY"]
  $hostName = if ([string]::IsNullOrWhiteSpace([string]$OldEnv["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$OldEnv["MT5_BRIDGE_HOST"] }
  $port = if ([string]::IsNullOrWhiteSpace([string]$OldEnv["MT5_BRIDGE_PORT"])) { 8765 } else { [int]$OldEnv["MT5_BRIDGE_PORT"] }
  if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
    try {
      $positions = Invoke-RestMethod -Uri "http://${hostName}:${port}/v1/positions?symbol=XAUUSD" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 5
      if (@($positions).Count -gt 0) {
        throw "Current bridge still has XAUUSD position(s). Switch is blocked until the account is flat."
      }
      Write-Host "PHASE7B_SWITCH_CURRENT_XAUUSD_POSITIONS=0"
    } catch {
      if ($_.Exception.Message -like "*position(s)*") { throw }
      Write-Host "PHASE7B_SWITCH_CURRENT_POSITION_CHECK=BRIDGE_UNAVAILABLE_STATE_CHECK_ONLY" -ForegroundColor Yellow
    }
  }
}

$oldEnv = Read-EnvMap $BridgeEnv
if ([string]$oldEnv["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') {
  throw "Existing Phase 7B env has MT5_ALLOW_REAL_ACCOUNT=true. Refusing switch."
}
if ([string]::IsNullOrWhiteSpace([string]$oldEnv["MT5_API_KEY"]) -or ([string]$oldEnv["MT5_API_KEY"]).Length -lt 16) {
  throw "Existing Phase 7B MT5_API_KEY is invalid."
}

Assert-FlatBeforeSwitch $oldEnv

$oldHost = if ([string]::IsNullOrWhiteSpace([string]$oldEnv["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$oldEnv["MT5_BRIDGE_HOST"] }
$oldPort = if ([string]::IsNullOrWhiteSpace([string]$oldEnv["MT5_BRIDGE_PORT"])) { 8765 } else { [int]$oldEnv["MT5_BRIDGE_PORT"] }
$bridgeBase = "http://${oldHost}:${oldPort}"
$apiKey = [string]$oldEnv["MT5_API_KEY"]
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$envBackup = "$BridgeEnv.before-switch-$stamp.bak"
Copy-Item $BridgeEnv $envBackup -Force

Write-Host "PHASE7B_SWITCH_TARGET_TERMINAL=$TerminalPath"
Write-Host "PHASE7B_SWITCH_TARGET_LOGIN=$ExpectedLogin"
Write-Host "PHASE7B_SWITCH_TARGET_SERVER=$(if ([string]::IsNullOrWhiteSpace($ExpectedServer)) { 'ANY_DEMO_SERVER' } else { $ExpectedServer })"
Write-Host "PHASE7B_SWITCH_REAL_ACCOUNT_ALLOWED=false"
Write-Host "PHASE7B_SWITCH_ENV_BACKUP=$envBackup"

Stop-TaskSafe $BotTask
Stop-TaskSafe $TelegramTask
Stop-TaskSafe $BridgeTask
Stop-BotProcess
Stop-TelegramProcesses
Start-Sleep -Seconds 1
Stop-BridgeListener $oldPort
Start-Sleep -Seconds 2

$quotedTerminal = '"' + $TerminalPath + '"'
Set-EnvKeys $BridgeEnv @{
  "MT5_TERMINAL_PATH" = $quotedTerminal
  "MT5_ALLOWED_LOGINS" = [string]$ExpectedLogin
  "MT5_LOGIN" = ""
  "MT5_PASSWORD" = ""
  "MT5_SERVER" = ""
  "MT5_TRADING_ENABLED" = "true"
  "MT5_ALLOW_REAL_ACCOUNT" = "false"
}

$validated = $false
try {
  Start-TaskSafe $BridgeTask
  $deadline = (Get-Date).AddSeconds([Math]::Max(30, $BridgeWaitSeconds))
  $health = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $probe = Get-BridgeHealth $bridgeBase $apiKey 5
      if ($probe.connected -and $probe.status -eq "ok") {
        $health = $probe
        break
      }
    } catch {}
    Start-Sleep -Seconds 3
  }

  if ($null -eq $health) { throw "New DBGMarkets bridge did not become healthy within $BridgeWaitSeconds seconds." }
  Write-Host "PHASE7B_SWITCH_NEW_ACCOUNT_LOGIN=$($health.accountLogin)"
  Write-Host "PHASE7B_SWITCH_NEW_ACCOUNT_MODE=$($health.accountMode)"
  Write-Host "PHASE7B_SWITCH_NEW_SERVER=$($health.server)"
  Write-Host "PHASE7B_SWITCH_NEW_TERMINAL_TRADE_ALLOWED=$($health.terminalTradeAllowed)"
  Write-Host "PHASE7B_SWITCH_NEW_EXPERT_TRADE_ALLOWED=$($health.expertTradeAllowed)"

  if ($health.accountMode -ne "demo") { throw "Target terminal is not a DEMO account. Bot remains blocked." }
  if ([long]$health.accountLogin -ne $ExpectedLogin) { throw "Target login mismatch. Expected $ExpectedLogin, got $($health.accountLogin)." }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedServer) -and [string]$health.server -ne $ExpectedServer) {
    throw "Target server mismatch. Expected '$ExpectedServer', got '$($health.server)'."
  }
  if (-not $health.tradingEnabled) { throw "Bridge tradingEnabled=false on target DEMO account." }
  if (-not $health.terminalTradeAllowed -or -not $health.expertTradeAllowed) {
    throw "DBGMarkets DEMO is connected, but Algo Trading / Expert trading is not enabled. Enable Algo Trading in MT5, then run this switch script again."
  }

  $targetPositions = Invoke-RestMethod -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 5
  if (@($targetPositions).Count -gt 0) {
    throw "Target DBGMarkets DEMO account already has XAUUSD position(s). Close them before switching Phase 7B."
  }
  Write-Host "PHASE7B_SWITCH_TARGET_XAUUSD_POSITIONS=0"

  $validated = $true
}
catch {
  Write-Host "PHASE7B_SWITCH_VALIDATION=FAIL" -ForegroundColor Red
  Write-Host "PHASE7B_SWITCH_ERROR=$($_.Exception.Message)" -ForegroundColor Red
  Stop-TaskSafe $BridgeTask
  Stop-BridgeListener $oldPort
  Copy-Item $envBackup $BridgeEnv -Force
  Write-Host "PHASE7B_SWITCH_ROLLBACK_ENV=PASS" -ForegroundColor Yellow
  try { Start-TaskSafe $BridgeTask } catch {}
  try { Start-TaskSafe $TelegramTask } catch {}
  try { Start-TaskSafe $BotTask } catch {}
  throw
}

if (-not $validated) { throw "Target account validation did not complete." }

if (Test-Path $DemoDir) {
  New-Item -ItemType Directory -Path $ArchiveRoot -Force | Out-Null
  $oldLogin = if ([string]::IsNullOrWhiteSpace([string]$oldEnv["MT5_ALLOWED_LOGINS"])) { "unknown" } else { ([string]$oldEnv["MT5_ALLOWED_LOGINS"]) -replace '[^0-9A-Za-z_-]', '_' }
  $archiveDir = Join-Path $ArchiveRoot "account-$oldLogin-$stamp"
  New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null
  Move-Item $DemoDir (Join-Path $archiveDir "phase7b-demo-forward") -Force
  Write-Host "PHASE7B_SWITCH_ARCHIVE=$archiveDir"
}

Start-TaskSafe $TelegramTask
Start-TaskSafe $BotTask
if ($null -ne (Get-ScheduledTask -TaskName $WebTask -ErrorAction SilentlyContinue)) {
  $webPortsReady = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3711,5717 }).Count -ge 2
  if (-not $webPortsReady) { Start-TaskSafe $WebTask }
}

Write-Host "PHASE7B_SWITCH_TARGET_VALIDATION=PASS"
Write-Host "PHASE7B_SWITCH_ACCOUNT_LOGIN=$ExpectedLogin"
Write-Host "PHASE7B_SWITCH_ACCOUNT_MODE=demo"
Write-Host "PHASE7B_SWITCH_REAL_ACCOUNT_ALLOWED=false"
Write-Host "PHASE7B_SWITCH_FORWARD_SAMPLE=RESET_FOR_NEW_ACCOUNT"
Write-Host "PHASE7B_SWITCH_AUTOSTART=PRESERVED"
Write-Host "PHASE7B_SWITCH_STATUS=PASS"
