param(
  [int]$ApiPort = 3711,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$RoutePath = Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts"
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$DemoDir = Join-Path $Root ".runtime\phase7b-demo-forward"

function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing file: $Path" }
  return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

Push-Location $Root
try {
  $route = Read-Text $RoutePath

  foreach ($required in @(
    "PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT",
    "const m5DirectionAligned = Boolean",
    "const m15Reaction =",
    "const m5Reaction =",
    "const confidenceLevel =",
    "function phase7bTrendlineReaction("
  )) {
    if (-not $route.Contains($required)) {
      throw "Route is missing expected partially-applied V2 marker: $required"
    }
  }

  $runtimeMarker = "m15SupertrendLine: m15Reaction?.line ?? null"
  if (-not $route.Contains($runtimeMarker)) {
    $payloadPattern = '(?ms)(^[ \t]*m5FlipAgeBars:[ \t]*flipAge,[ \t]*\r?\n^[ \t]*m5FreshAligned,[ \t]*\r?\n)(^[ \t]*},[ \t]*\r?\n^[ \t]*fvg:)'
    $match = [regex]::Match($route, $payloadPattern)
    if (-not $match.Success) {
      throw "Could not locate trend runtime payload after m5FreshAligned."
    }

    $fields = @'
      m15SupertrendLine: m15Reaction?.line ?? null,
      m5SupertrendLine: m5Reaction?.line ?? null,
      m15TrendlineDistance: m15Reaction?.distance ?? null,
      m5TrendlineDistance: m5Reaction?.distance ?? null,
      m15TrendlineReaction: Boolean(m15Reaction?.reaction),
      m5TrendlineReaction: Boolean(m5Reaction?.reaction),
      confidenceLevel,
'@

    $replacement = $match.Groups[1].Value + $fields + "`r`n" + $match.Groups[2].Value
    $route = $route.Substring(0, $match.Index) + $replacement + $route.Substring($match.Index + $match.Length)
    Write-Text $RoutePath $route
  }

  $verify = Read-Text $RoutePath
  foreach ($required in @(
    "m15SupertrendLine: m15Reaction?.line ?? null",
    "m5SupertrendLine: m5Reaction?.line ?? null",
    "m15TrendlineDistance: m15Reaction?.distance ?? null",
    "m5TrendlineDistance: m5Reaction?.distance ?? null",
    "m15TrendlineReaction: Boolean(m15Reaction?.reaction)",
    "m5TrendlineReaction: Boolean(m5Reaction?.reaction)",
    "confidenceLevel,"
  )) {
    if (-not $verify.Contains($required)) {
      throw "Trend runtime payload repair missing: $required"
    }
  }

  if ($verify -match 'flipAge\s*>\s*1\s*\)\s*return\s+null') {
    throw "Flip age is still blocking entry in API route."
  }

  Write-Host "PHASE7B_ALIGNMENT_V4_PAYLOAD_REPAIR=PASS"
  Write-Host "PHASE7B_ALIGNMENT_V4_FLIP_AGE=INFO_ONLY_NOT_GATE"

  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_ALIGNMENT_V4_API_BUILD=PASS"

  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_ALIGNMENT_V4_WEB_BUILD=PASS"

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
  if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "V4 refuses MT5_ALLOW_REAL_ACCOUNT=true." }

  $BridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
  $BridgeConfiguredPort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { [string]$BridgePort } else { [string]$values["MT5_BRIDGE_PORT"] }
  $BridgeBase = "http://${BridgeHost}:${BridgeConfiguredPort}"

  $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers @{ "x-mt5-api-key" = $ApiKey } -Method Get -TimeoutSec 8
  if (-not $health.connected -or $health.accountMode -ne "demo") { throw "Bridge is not connected to DEMO." }
  Write-Host "PHASE7B_ALIGNMENT_V4_BRIDGE=PASS"
  Write-Host "PHASE7B_ALIGNMENT_V4_ACCOUNT_LOGIN=$($health.accountLogin)"

  $listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($processId -and $processId -ne $PID) {
      Write-Host "PHASE7B_ALIGNMENT_V4_STOP_API_PID=$processId"
      & taskkill /PID $processId /T /F | Out-Null
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
`$env:WEB_ORIGIN = 'http://127.0.0.1:5717'
pnpm --filter @xauusd/api dev
"@

  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ApiLauncher))
  $ApiProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $encoded)

  $snapshot = $null
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -Method Get -TimeoutSec 3
      if ($null -ne $snapshot) { break }
    } catch {}
  }
  if ($null -eq $snapshot) { throw "Repaired API did not become ready on port $ApiPort." }

  Write-Host "PHASE7B_ALIGNMENT_V4_API=PASS"
  if ($null -ne $snapshot.entryDiagnostics) {
    $trend = $snapshot.entryDiagnostics.trend
    Write-Host "PHASE7B_ALIGNMENT_V4_ENTRY_RULE=$($snapshot.entryDiagnostics.entry.rule)"
    Write-Host "PHASE7B_ALIGNMENT_V4_M15_ST=$($trend.m15Supertrend)"
    Write-Host "PHASE7B_ALIGNMENT_V4_M5_ST=$($trend.m5Supertrend)"
    Write-Host "PHASE7B_ALIGNMENT_V4_FLIP_AGE_VALUE=$($trend.m5FlipAgeBars)"
    Write-Host "PHASE7B_ALIGNMENT_V4_CONFIDENCE=$($trend.confidenceLevel)"
    Write-Host "PHASE7B_ALIGNMENT_V4_M15_REACTION=$($trend.m15TrendlineReaction)"
    Write-Host "PHASE7B_ALIGNMENT_V4_M5_REACTION=$($trend.m5TrendlineReaction)"
  } else {
    Write-Host "PHASE7B_ALIGNMENT_V4_DIAGNOSTICS=TEMPORARILY_UNAVAILABLE"
  }
  Write-Host "PHASE7B_ALIGNMENT_V4_BOT_RESTARTED=False"
  Write-Host "PHASE7B_ALIGNMENT_V4_TELEGRAM_RESTARTED=False"
  Write-Host "PHASE7B_ALIGNMENT_V4_WEB_RESTARTED=False"
  Write-Host "PHASE7B_ALIGNMENT_V4_REAL_ACCOUNT_ALLOWED=False"
  Write-Host "PHASE7B_ALIGNMENT_V4=PASS"
}
finally {
  Pop-Location
}
