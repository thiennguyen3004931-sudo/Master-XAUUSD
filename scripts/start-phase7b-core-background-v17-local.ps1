param(
  [int]$BridgePort = 8765,
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root ".runtime"
$DemoDir = Join-Path $RuntimeDir "phase7b-demo-forward"
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$ApiEnv = Join-Path $Root ".env.phase7b-demo"
$BridgeScript = Join-Path $PSScriptRoot "run-phase7b-bridge-service.ps1"
$Log = Join-Path $RuntimeDir "phase7b-core-background.log"
$ApiLauncher = Join-Path $RuntimeDir "phase7b-api-background-run.ps1"
$WebLauncher = Join-Path $RuntimeDir "phase7b-web-background-run.ps1"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $DemoDir -Force | Out-Null

function Log([string]$Message) {
  $line = "{0} {1}" -f ([DateTimeOffset]::Now.ToString("o")), $Message
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  foreach ($raw in Get-Content $Path) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $idx = $line.IndexOf("=")
    $name = $line.Substring(0, $idx).Trim().TrimStart([char]0xFEFF)
    $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$Label) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    try { if (& $Test) { Log "$Label=PASS"; return $true } } catch {}
    Start-Sleep -Milliseconds 700
  } while ([DateTime]::UtcNow -lt $deadline)
  Log "$Label=FAIL"
  return $false
}

if (-not (Test-Path $BridgeEnv)) { throw "Bridge DEMO env missing: $BridgeEnv" }
if (-not (Test-Path $BridgeScript)) { throw "Bridge service script missing: $BridgeScript" }

Import-EnvFile $BridgeEnv
if ($env:MT5_ALLOW_REAL_ACCOUNT -match '^(?i:true|1|yes|on)$') {
  throw "Core startup refuses MT5_ALLOW_REAL_ACCOUNT=true."
}
$key = $env:MT5_API_KEY
if ([string]::IsNullOrWhiteSpace($key)) { throw "MT5_API_KEY missing in Bridge DEMO env." }

$bridgeHealth = "http://127.0.0.1:$BridgePort/health"
$bridgeOk = $false
try {
  $h = Invoke-RestMethod -Uri $bridgeHealth -Headers @{ "x-mt5-api-key" = $key } -TimeoutSec 3
  $bridgeOk = ($h.connected -eq $true -and $h.accountMode -eq "demo")
} catch {}

if (-not $bridgeOk) {
  Log "BRIDGE=STARTING"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BridgeScript, "-EnvFile", $BridgeEnv) `
    -WindowStyle Hidden | Out-Null
}

$bridgeReady = Wait-Until {
  $h = Invoke-RestMethod -Uri $bridgeHealth -Headers @{ "x-mt5-api-key" = $key } -TimeoutSec 2
  return ($h.connected -eq $true -and $h.accountMode -eq "demo")
} 45 "BRIDGE_READY"
if (-not $bridgeReady) { throw "Bridge DEMO did not become ready." }

$apiReady = $false
try {
  $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 3
  $apiReady = ($snapshot.mt5.health.accountMode -eq "demo")
} catch {}

if (-not $apiReady) {
  $apiScript = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$Root'
function Import-EnvFile([string]`$Path) {
  if (-not (Test-Path `$Path)) { return }
  foreach (`$raw in Get-Content `$Path) {
    `$line = `$raw.Trim()
    if (-not `$line -or `$line.StartsWith('#') -or -not `$line.Contains('=')) { continue }
    `$idx = `$line.IndexOf('=')
    `$name = `$line.Substring(0, `$idx).Trim().TrimStart([char]0xFEFF)
    `$value = `$line.Substring(`$idx + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable(`$name, `$value, 'Process')
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
`$env:WEB_ORIGIN = 'http://127.0.0.1:$WebPort'
pnpm --filter @xauusd/api dev
"@
  [System.IO.File]::WriteAllText($ApiLauncher, $apiScript, (New-Object System.Text.UTF8Encoding($false)))
  Log "API=STARTING"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ApiLauncher) `
    -WindowStyle Hidden | Out-Null
}

$apiReady = Wait-Until {
  $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 2
  return ($snapshot.mt5.health.accountMode -eq "demo")
} 45 "API_READY"
if (-not $apiReady) { throw "API did not become ready." }

$webReady = $false
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/phase7b-ops" -UseBasicParsing -TimeoutSec 3
  $webReady = ($response.StatusCode -eq 200)
} catch {}

if (-not $webReady) {
  $WebDir = Join-Path $Root "apps\web"
  $webScript = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$WebDir'
`$env:VITE_API_BASE_URL = ''
`$env:VITE_DEV_API_PROXY_TARGET = 'http://127.0.0.1:$ApiPort'
pnpm exec vite --host 127.0.0.1 --port $WebPort --strictPort
"@
  [System.IO.File]::WriteAllText($WebLauncher, $webScript, (New-Object System.Text.UTF8Encoding($false)))
  Log "WEB=STARTING"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $WebLauncher) `
    -WindowStyle Hidden | Out-Null
}

$webReady = Wait-Until {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/phase7b-ops" -UseBasicParsing -TimeoutSec 2
  return ($response.StatusCode -eq 200)
} 35 "WEB_READY"
if (-not $webReady) { throw "Web did not become ready." }

Log "PHASE7B_CORE_BACKGROUND=PASS"
Log "BRIDGE=http://127.0.0.1:$BridgePort"
Log "API=http://127.0.0.1:$ApiPort"
Log "WEB=http://127.0.0.1:$WebPort/phase7b-ops"
Log "BOT_AUTOSTART=False"
Log "TELEGRAM_AUTOSTART=False"
Log "REAL_ACCOUNT_ALLOWED=False"
