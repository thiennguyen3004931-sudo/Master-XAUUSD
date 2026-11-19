param(
  [int]$WebPort = 5717,
  [int]$ApiPort = 3711
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$WebDir = Join-Path $Root "apps\web"

try {
  $api = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 4
  if (-not $api) { throw "API returned no snapshot." }
  Write-Host "PHASE7B_WEB_V11_API=PASS"
  Write-Host "PHASE7B_WEB_V11_ACCOUNT_MODE=$($api.mt5.health.accountMode)"
  Write-Host "PHASE7B_WEB_V11_ACCOUNT_LOGIN=$($api.mt5.health.accountLogin)"
  Write-Host "PHASE7B_WEB_V11_BALANCE=$($api.mt5.health.accountBalance)"
  Write-Host "PHASE7B_WEB_V11_EQUITY=$($api.mt5.health.accountEquity)"
  if ($api.dailyManagement) {
    Write-Host "PHASE7B_WEB_V11_DAILY_MODE=$($api.dailyManagement.mode)"
    Write-Host "PHASE7B_WEB_V11_DAILY_PNL=$($api.dailyManagement.realizedPnl)"
  }
} catch {
  throw "API preflight failed: $($_.Exception.Message)"
}

$listeners = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
  if ($processId -and $processId -ne $PID) {
    Write-Host "PHASE7B_WEB_V11_STOP_PID=$processId"
    & taskkill /PID $processId /T /F | Out-Null
  }
}
Start-Sleep -Milliseconds 700

$env:VITE_API_BASE_URL = ""
$env:VITE_DEV_API_PROXY_TARGET = "http://127.0.0.1:$ApiPort"

$web = Start-Process -FilePath "pnpm.cmd" `
  -ArgumentList @("exec", "vite", "--host", "127.0.0.1", "--port", "$WebPort", "--strictPort") `
  -WorkingDirectory $WebDir `
  -PassThru

$ready = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/phase7b-pattern-check" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
}

if (-not $ready) {
  throw "Web PID $($web.Id) started but port $WebPort did not become ready."
}

Write-Host "PHASE7B_WEB_V11=PASS"
Write-Host "PHASE7B_WEB_V11_PID=$($web.Id)"
Write-Host "PHASE7B_WEB_V11_URL=http://127.0.0.1:$WebPort/"
Write-Host "PHASE7B_WEB_V11_GATE=http://127.0.0.1:$WebPort/phase7b-pattern-check"
Write-Host "PHASE7B_WEB_V11_API_PROXY=http://127.0.0.1:$ApiPort"
Write-Host "PHASE7B_WEB_V11_BOT_RESTARTED=False"
Write-Host "PHASE7B_WEB_V11_TELEGRAM_RESTARTED=False"
Write-Host "PHASE7B_WEB_V11_BRIDGE_RESTARTED=False"
