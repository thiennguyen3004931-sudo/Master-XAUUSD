param(
  [string]$WorkDir = "",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($WorkDir)) { $WorkDir = Join-Path $Root ".runtime" }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path
$DemoDir = Join-Path $WorkDir "phase7b-demo-forward"
New-Item -ItemType Directory -Path $DemoDir -Force | Out-Null

$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
if (-not (Test-Path $BridgeEnv)) { throw "Missing DEMO bridge env: $BridgeEnv" }

$values = @{}
foreach ($raw in Get-Content $BridgeEnv) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $i = $line.IndexOf("=")
  $name = $line.Substring(0, $i).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
  $values[$name] = $value
}

$ApiKey = [string]$values["MT5_API_KEY"]
if ([string]::IsNullOrWhiteSpace($ApiKey) -or $ApiKey.Length -lt 16) { throw "Invalid MT5_API_KEY in DEMO bridge env." }
if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "DEMO console refuses MT5_ALLOW_REAL_ACCOUNT=true." }

$BridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
$BridgePort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { "8765" } else { [string]$values["MT5_BRIDGE_PORT"] }
$BridgeBase = "http://${BridgeHost}:${BridgePort}"
$ApiUrl = "http://127.0.0.1:${ApiPort}"
$WebUrl = "http://127.0.0.1:${WebPort}"

try {
  $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers @{ "x-mt5-api-key" = $ApiKey } -Method Get -TimeoutSec 8
} catch {
  throw "DEMO bridge preflight failed: $($_.Exception.Message)"
}
if (-not $health.connected -or $health.accountMode -ne "demo") {
  throw "DEMO console requires connected accountMode=demo. Current=$($health.accountMode)"
}

Write-Host "PHASE7B_CONSOLE_BRIDGE=PASS"
Write-Host "PHASE7B_CONSOLE_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7B_CONSOLE_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_CONSOLE_BOT_RESTARTED=False"
Write-Host "PHASE7B_CONSOLE_TELEGRAM_RESTARTED=False"

Push-Location $Root
try {
  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }
}
finally {
  Pop-Location
}
Write-Host "PHASE7B_CONSOLE_BUILD=PASS"

foreach ($port in @($ApiPort, $WebPort)) {
  $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($processId in $pids) {
    Write-Host "PHASE7B_CONSOLE_STOP_PORT_${port}_PID=$processId"
    taskkill /PID $processId /T /F | Out-Null
  }
}
Start-Sleep -Seconds 1

$ApiLauncher = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$Root'
`$env:PORT = '$ApiPort'
`$env:HOST = '127.0.0.1'
`$env:MT5_BRIDGE_ENABLED = 'true'
`$env:MT5_BRIDGE_BASE_URL = '$BridgeBase'
`$env:MT5_BRIDGE_API_KEY = '$ApiKey'
`$env:MT5_BRIDGE_REQUEST_TIMEOUT_MS = '3000'
`$env:MT5_BRIDGE_HEALTH_TIMEOUT_MS = '1500'
`$env:EXECUTION_WORKER_EXECUTION_ENABLED = 'false'
`$env:PHASE7B_DEMO_WORK_DIR = '$DemoDir'
`$env:PHASE7B_LOCAL_CONTROL_ENABLED = 'true'
`$env:PHASE7B_FIXED_VOLUME = '0.03'
`$env:WEB_ORIGIN = '$WebUrl'
Write-Host 'PHASE7B_CONSOLE_API=http://127.0.0.1:$ApiPort'
Write-Host 'PHASE7B_CONSOLE_LOCAL_CONTROL=true'
pnpm --filter @xauusd/api dev
"@
$ApiEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ApiLauncher))
$ApiProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $ApiEncoded)

$ApiReady = $false
$Ops = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $Ops = Invoke-RestMethod -Uri "$ApiUrl/api/v1/phase7b-ops/status" -Method Get -TimeoutSec 3
    if ($Ops -and $Ops.controlEnabled -eq $true) {
      $ApiReady = $true
      break
    }
  } catch {}
}
if (-not $ApiReady) { throw "API started PID $($ApiProcess.Id) but local DEMO control did not become ready." }
if ($Ops.bridge.accountMode -ne "demo") { throw "Ops API is not reporting DEMO mode." }

Write-Host "PHASE7B_CONSOLE_API=PASS"
Write-Host "PHASE7B_CONSOLE_CONTROL_ENABLED=$($Ops.controlEnabled)"
Write-Host "PHASE7B_CONSOLE_BOT_ALIVE=$($Ops.bot.alive)"
Write-Host "PHASE7B_CONSOLE_TELEGRAM_ALIVE=$($Ops.telegram.alive)"

$WebLauncher = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$Root'
`$env:VITE_API_BASE_URL = ''
`$env:VITE_DEV_API_PROXY_TARGET = '$ApiUrl'
Write-Host 'PHASE7B_CONSOLE_WEB=$WebUrl'
Write-Host 'PHASE7B_CONSOLE_PROXY=$ApiUrl'
pnpm --filter @xauusd/web dev -- --host 127.0.0.1 --port $WebPort --strictPort
"@
$WebEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($WebLauncher))
$WebProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $WebEncoded)

$WebReady = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -Uri "$WebUrl/phase7b-ops" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
      $WebReady = $true
      break
    }
  } catch {}
}
if (-not $WebReady) { throw "Web started PID $($WebProcess.Id) but port $WebPort did not become ready." }

Write-Host "PHASE7B_CONSOLE_REFRESH=PASS"
Write-Host "PHASE7B_CONSOLE_API_PID=$($ApiProcess.Id)"
Write-Host "PHASE7B_CONSOLE_WEB_PID=$($WebProcess.Id)"
Write-Host "PHASE7B_CONSOLE_HOME=$WebUrl/"
Write-Host "PHASE7B_CONSOLE_CONTROLS=$WebUrl/phase7b-ops"
Write-Host "PHASE7B_CONSOLE_BOT_RESTARTED=False"
Write-Host "PHASE7B_CONSOLE_TELEGRAM_RESTARTED=False"
Write-Host "PHASE7B_CONSOLE_REAL_ACCOUNT_ALLOWED=False"

Start-Process "$WebUrl/phase7b-ops"
