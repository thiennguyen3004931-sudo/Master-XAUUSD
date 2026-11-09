param(
  [int]$ApiPort = 3711,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$ApiEnv = Join-Path $Root ".env.phase7b-demo"
$DemoDir = Join-Path $Root ".runtime\phase7b-demo-forward"

function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
    }
  }
}

if (-not (Test-Path $BridgeEnv)) { throw "Bridge DEMO env missing: $BridgeEnv" }
$keyLine = Get-Content $BridgeEnv | Where-Object { $_ -match '^\s*MT5_API_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw "MT5_API_KEY missing from $BridgeEnv" }
$key = (($keyLine -split '=', 2)[1]).Trim()

$health = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/health" -Headers @{ 'x-mt5-api-key' = $key } -TimeoutSec 5
if (-not $health.connected -or $health.accountMode -ne 'demo') {
  throw "DEMO bridge preflight failed. connected=$($health.connected) mode=$($health.accountMode)"
}
Write-Host "PHASE7B_DAY_RECOVERY_V8_BRIDGE=PASS"
Write-Host "PHASE7B_DAY_RECOVERY_V8_ACCOUNT_LOGIN=$($health.accountLogin)"

$listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
  if ($processId -and $processId -ne $PID) {
    Write-Host "PHASE7B_DAY_RECOVERY_V8_STOP_API_PID=$processId"
    & taskkill /PID $processId /T /F | Out-Null
  }
}
Start-Sleep -Seconds 1

$launcher = @"
Set-Location '$Root'
function Import-EnvFile([string]`$Path) {
  if (-not (Test-Path `$Path)) { return }
  Get-Content `$Path | ForEach-Object {
    if (`$_ -match '^\s*([^#][^=]*)=(.*)$') {
      [Environment]::SetEnvironmentVariable(`$matches[1].Trim(), `$matches[2].Trim(), 'Process')
    }
  }
}
Import-EnvFile '$ApiEnv'
Import-EnvFile '$BridgeEnv'
`$env:PORT = '$ApiPort'
`$env:HOST = '127.0.0.1'
`$env:MT5_BRIDGE_ENABLED = 'true'
`$env:MT5_BRIDGE_BASE_URL = 'http://127.0.0.1:$BridgePort'
`$env:MT5_BRIDGE_API_KEY = '$key'
`$env:EXECUTION_WORKER_ENABLED = 'false'
`$env:PHASE7B_DEMO_WORK_DIR = '$DemoDir'
`$env:PHASE7B_LOCAL_CONTROL_ENABLED = 'true'
`$env:PHASE7B_FIXED_VOLUME = '0.03'
`$env:WEB_ORIGIN = 'http://127.0.0.1:5717'
pnpm --filter @xauusd/api dev
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcher))
$apiProcess = Start-Process powershell.exe -PassThru -ArgumentList @('-NoExit', '-EncodedCommand', $encoded)

$snapshot = $null
for ($attempt = 1; $attempt -le 40; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 2
    if ($snapshot) { break }
  } catch {}
}

if (-not $snapshot) { throw "API PID $($apiProcess.Id) did not become ready on port $ApiPort." }
if ($snapshot.mt5.health.accountMode -ne 'demo') { throw "API account mode is not demo." }
if (-not $snapshot.PSObject.Properties.Name.Contains('dailyManagement')) { throw "API dailyManagement field is missing." }

Write-Host "PHASE7B_DAY_RECOVERY_V8_API=PASS"
if ($snapshot.dailyManagement) {
  Write-Host "PHASE7B_DAY_RECOVERY_V8_MODE=$($snapshot.dailyManagement.mode)"
  Write-Host "PHASE7B_DAY_RECOVERY_V8_REALIZED_PNL=$($snapshot.dailyManagement.realizedPnl)"
} else {
  Write-Host "PHASE7B_DAY_RECOVERY_V8_MODE=UNAVAILABLE"
  Write-Host "PHASE7B_DAY_RECOVERY_V8_ERROR=$($snapshot.dailyManagementError)"
}
Write-Host "PHASE7B_DAY_RECOVERY_V8_BOT_RESTARTED=False"
Write-Host "PHASE7B_DAY_RECOVERY_V8_TELEGRAM_RESTARTED=False"
Write-Host "PHASE7B_DAY_RECOVERY_V8_WEB_RESTARTED=False"
Write-Host "PHASE7B_DAY_RECOVERY_V8_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_DAY_RECOVERY_V8_API_RESTART=PASS"
