$ErrorActionPreference = "Stop"
$InspectorPath = Join-Path $PSScriptRoot "inspect-phase7c-live-runtime-local.ps1"
$MockPath = Join-Path $PSScriptRoot "test-phase7c-live-runtime-inspector-mock.py"
if (-not (Test-Path -LiteralPath $InspectorPath)) { throw "LIVE runtime inspector source not found: $InspectorPath" }
if (-not (Test-Path -LiteralPath $MockPath)) { throw "Mock server not found: $MockPath" }

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-live-runtime-inspector-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Force -Path $tempRoot)
$mock = $null
try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start(); $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
  $baseUrl = "http://127.0.0.1:$port"
  $envPath = Join-Path $tempRoot ".env.live"
  $accountPath = Join-Path $tempRoot "phase7c-account-mode.json"
  $armPath = Join-Path $tempRoot "phase7c-live-arm.json"
  $logPath = Join-Path $tempRoot "requests.log"

  @(
    "MT5_API_KEY=ci-test-key",
    "MT5_BRIDGE_HOST=127.0.0.1",
    "MT5_BRIDGE_PORT=$port"
  ) | Set-Content -LiteralPath $envPath -Encoding utf8
  @{ version = 1; accountMode = "LIVE"; liveExecutionEnabled = $true; envFile = $envPath } | ConvertTo-Json | Set-Content -LiteralPath $accountPath -Encoding utf8
  @{ version = 2; armed = $true; scope = "BRIDGE_SESSION"; accountMode = "LIVE"; bridgeSessionId = "ci-session"; accountLogin = 123456; server = "DBGMarkets-Live"; profileFingerprint = "ci"; armedAt = 1787970000000; armedBy = "ci" } | ConvertTo-Json | Set-Content -LiteralPath $armPath -Encoding utf8

  $before = @{}
  foreach ($path in @($envPath, $accountPath, $armPath)) { $before[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }

  $mock = Start-Process -FilePath "python" -ArgumentList @($MockPath, "--port", "$port", "--log", $logPath) -PassThru -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
    try { $client = [System.Net.Sockets.TcpClient]::new(); $client.Connect("127.0.0.1", $port); $client.Dispose(); $ready = $true } catch { Start-Sleep -Milliseconds 100 }
  }
  if (-not $ready) { throw "Mock server did not become ready." }

  $output = @(& $InspectorPath -WorkDir $tempRoot -ControlApiUrl $baseUrl -ExpectedRuntime LIVE -ExpectedMode AUTO -RequireArmed -Symbol XAUUSD -TimeoutSec 3 *>&1 | ForEach-Object { [string]$_ })
  $joined = $output -join "`n"
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_RESULT=PASS') { throw "Inspector did not PASS. Output:`n$joined" }
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_OBSERVATION_ONLY=TRUE') { throw "Inspector did not declare observation-only. Output:`n$joined" }
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_RUNTIME=LIVE') { throw "Runtime observation missing. Output:`n$joined" }
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_MODE=AUTO') { throw "Mode observation missing. Output:`n$joined" }
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_ARM=ARMED') { throw "ARM observation missing. Output:`n$joined" }
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_XAUUSD_POSITIONS=0') { throw "Position count missing. Output:`n$joined" }
  if ($joined -notmatch 'PHASE7C_LIVE_RUNTIME_INSPECTOR_XAUUSD_ORDERS=0') { throw "Order count missing. Output:`n$joined" }

  foreach ($path in @($envPath, $accountPath, $armPath)) {
    $after = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($before[$path] -ne $after) { throw "Inspector mutated fixture state: $path" }
  }

  $requests = @(Get-Content -LiteralPath $logPath | Where-Object { $_.Trim() })
  $expected = @(
    'GET /api/v1/phase7c/bot-mode',
    'GET /health?reconnect=false',
    'GET /v1/positions?symbol=XAUUSD&reconnect=false',
    'GET /v1/orders?symbol=XAUUSD&reconnect=false'
  )
  foreach ($item in $expected) { if ($requests -notcontains $item) { throw "Missing expected observation request: $item. Actual=$($requests -join ', ')" } }
  foreach ($request in $requests) { if ($request -notmatch '^GET ') { throw "Non-GET request observed: $request" } }

  Write-Host "PHASE7C_LIVE_RUNTIME_INSPECTOR_SYNTHETIC_TEST=PASS"
} finally {
  if ($null -ne $mock -and -not $mock.HasExited) { Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
