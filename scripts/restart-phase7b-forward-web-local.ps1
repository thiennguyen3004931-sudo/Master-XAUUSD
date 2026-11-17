param(
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$apiUrl = "http://127.0.0.1:${ApiPort}"
$webUrl = "http://127.0.0.1:${WebPort}"
$expectedRule = "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"

try {
  $snapshot = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 5
} catch {
  throw "Phase 7B API $apiUrl is unavailable: $($_.Exception.Message)"
}

$actualRule = [string]$snapshot.entryDiagnostics.entry.rule
if ($actualRule -ne $expectedRule) {
  throw "API rule '$actualRule' does not match expected '$expectedRule'."
}
if ($snapshot.mt5.health.accountMode -ne "demo") {
  throw "Web restart requires DEMO API telemetry, got '$($snapshot.mt5.health.accountMode)'."
}

Write-Host "PHASE7B_WEB_RESTART_API=PASS"
Write-Host "PHASE7B_WEB_RESTART_API_RULE=$actualRule"
Write-Host "PHASE7B_WEB_RESTART_ACCOUNT_MODE=$($snapshot.mt5.health.accountMode)"
Write-Host "PHASE7B_WEB_RESTART_BOT_STATUS=$($snapshot.botStatus)"

Push-Location $Root
try {
  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B web build failed: $LASTEXITCODE" }
}
finally {
  Pop-Location
}
Write-Host "PHASE7B_WEB_RESTART_BUILD=PASS"

$listeners = Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue
$pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($processId in $pids) {
  Write-Host "PHASE7B_WEB_RESTART_STOP_PID=$processId"
  taskkill /PID $processId /T /F | Out-Null
}

$escapedRoot = $Root.Replace("'", "''")
$command = "Set-Location '$escapedRoot'; `$env:VITE_API_BASE_URL=''; `$env:VITE_DEV_API_PROXY_TARGET='$apiUrl'; Write-Host 'PHASE7B_WEB_API_TRANSPORT=SAME_ORIGIN_VITE_PROXY'; Write-Host 'PHASE7B_WEB_PROXY_TARGET=$apiUrl'; pnpm --filter @xauusd/web dev -- --host 127.0.0.1 --port $WebPort --strictPort"
$webProcess = Start-Process powershell.exe -PassThru -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-Command", $command
)

$ready = $false
for ($attempt = 1; $attempt -le 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -Uri "$webUrl/phase7b-pattern-check" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
      $ready = $true
      break
    }
  } catch {}
}
if (-not $ready) {
  throw "Web process started PID $($webProcess.Id) but port $WebPort did not become ready."
}

Write-Host "PHASE7B_WEB_RESTART=PASS"
Write-Host "PHASE7B_WEB_RESTART_PID=$($webProcess.Id)"
Write-Host "PHASE7B_WEB_API_TRANSPORT=SAME_ORIGIN_VITE_PROXY"
Write-Host "PHASE7B_WEB_FORWARD_MONITOR=$webUrl/phase7b-demo"
Write-Host "PHASE7B_WEB_LIVE_ENTRY_GATE=$webUrl/phase7b-pattern-check"
Write-Host "PHASE7B_WEB_BOT_RESTARTED=False"
Write-Host "PHASE7B_WEB_TELEGRAM_RESTARTED=False"

Start-Process "$webUrl/phase7b-pattern-check"
