param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression",
  [int]$ApiPort = 3711,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$RouteRelative = "apps/api/src/routes/phase7b-ops.route.ts"
$RoutePath = Join-Path $Root "apps\api\src\routes\phase7b-ops.route.ts"
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$DemoDir = Join-Path $Root ".runtime\phase7b-demo-forward"

Push-Location $Root
try {
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

  $routeLines = @(& git show "${Remote}/${Branch}:$RouteRelative")
  if ($LASTEXITCODE -ne 0) { throw "git show failed for $RouteRelative" }
  [System.IO.File]::WriteAllText($RoutePath, (($routeLines -join "`n") + "`n"), $Utf8NoBom)

  $routeText = [System.IO.File]::ReadAllText($RoutePath)
  foreach ($token in @(
    "WINDOWS_POWERSHELL_START_PROCESS",
    "launchPowerShellViaWindowsHost",
    "phase7b-web-bot-launcher.ps1",
    "RUNTIME_PID_AND_HEARTBEAT"
  )) {
    if (-not $routeText.Contains($token)) { throw "Updated ops route missing token: $token" }
  }

  Write-Host "PHASE7B_WEB_CONTROL_V3_SYNC=PASS"
  Write-Host "PHASE7B_WEB_CONTROL_V3_LAUNCH=WINDOWS_POWERSHELL_START_PROCESS"
  Write-Host "PHASE7B_WEB_CONTROL_V3_VERIFY=RUNTIME_PID_AND_HEARTBEAT"

  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_WEB_CONTROL_V3_BUILD=PASS"

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
  if ([string]::IsNullOrWhiteSpace($ApiKey) -or $ApiKey.Length -lt 16) { throw "Invalid MT5_API_KEY in DEMO env." }
  if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "V3 helper refuses MT5_ALLOW_REAL_ACCOUNT=true." }

  $BridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
  $BridgeConfiguredPort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { [string]$BridgePort } else { [string]$values["MT5_BRIDGE_PORT"] }
  $BridgeBase = "http://${BridgeHost}:${BridgeConfiguredPort}"

  $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers @{ "x-mt5-api-key" = $ApiKey } -Method Get -TimeoutSec 8
  if (-not $health.connected -or $health.accountMode -ne "demo") { throw "Bridge is not connected DEMO." }
  if (-not $health.tradingEnabled -or -not $health.terminalTradeAllowed -or -not $health.expertTradeAllowed) {
    throw "DEMO trading guard is not ready."
  }
  Write-Host "PHASE7B_WEB_CONTROL_V3_BRIDGE=PASS"
  Write-Host "PHASE7B_WEB_CONTROL_V3_ACCOUNT_LOGIN=$($health.accountLogin)"
  Write-Host "PHASE7B_WEB_CONTROL_V3_ACCOUNT_MODE=$($health.accountMode)"

  $listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
  $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($processId in $pids) {
    Write-Host "PHASE7B_WEB_CONTROL_V3_STOP_API_PID=$processId"
    taskkill /PID $processId /T /F | Out-Null
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
`$env:WEB_ORIGIN = 'http://127.0.0.1:5717'
Write-Host 'PHASE7B_WEB_CONTROL_V3_API_PROCESS=STARTING'
pnpm --filter @xauusd/api dev
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ApiLauncher))
  $ApiProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $encoded)

  $ready = $false
  $ops = $null
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $ops = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-ops/status" -Method Get -TimeoutSec 3
      if ($ops.controlEnabled -eq $true -and $ops.safety.processLaunchMode -eq "WINDOWS_POWERSHELL_START_PROCESS") {
        $ready = $true
        break
      }
    } catch {}
  }
  if (-not $ready) { throw "Updated API did not become ready on port $ApiPort." }

  Write-Host "PHASE7B_WEB_CONTROL_V3_API=PASS"
  Write-Host "PHASE7B_WEB_CONTROL_V3_API_PID=$($ApiProcess.Id)"
  Write-Host "PHASE7B_WEB_CONTROL_V3_CONTROL_ENABLED=$($ops.controlEnabled)"
  Write-Host "PHASE7B_WEB_CONTROL_V3_PROCESS_LAUNCH=$($ops.safety.processLaunchMode)"
  Write-Host "PHASE7B_WEB_CONTROL_V3_BOT_RESTARTED=False"
  Write-Host "PHASE7B_WEB_CONTROL_V3_TELEGRAM_RESTARTED=False"
  Write-Host "PHASE7B_WEB_CONTROL_V3_WEB_RESTARTED=False"
  Write-Host "PHASE7B_WEB_CONTROL_V3_REAL_ACCOUNT_ALLOWED=False"
  Write-Host "PHASE7B_WEB_CONTROL_V3=PASS"
}
finally {
  Pop-Location
}
