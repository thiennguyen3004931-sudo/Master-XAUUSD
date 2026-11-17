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
$LogPath = Join-Path $RuntimeDir "phase7b-core-background-v19.log"
$ApiLauncher = Join-Path $RuntimeDir "phase7b-api-background-v19.ps1"
$WebLauncher = Join-Path $RuntimeDir "phase7b-web-background-v19.ps1"
$RuntimeState = Join-Path $RuntimeDir "phase7b-core-runtime-v19.json"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $DemoDir -Force | Out-Null

function Write-CoreLog([string]$Message) {
  $line = "{0} {1}" -f ([DateTimeOffset]::Now.ToString("o")), $Message
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
  Write-Host $Message
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

function Stop-ListeningPort([int]$Port, [string]$Label) {
  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($processId -and $processId -ne $PID) {
      Write-CoreLog "$Label`_STOP_OLD_PID=$processId"
      & taskkill.exe /PID $processId /T /F | Out-Null
    }
  }
}

function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$Label) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      if (& $Test) {
        Write-CoreLog "$Label=PASS"
        return $true
      }
    } catch {}
    Start-Sleep -Milliseconds 700
  } while ([DateTime]::UtcNow -lt $deadline)
  Write-CoreLog "$Label=FAIL"
  return $false
}

if (-not (Test-Path $BridgeEnv)) { throw "Bridge DEMO env missing: $BridgeEnv" }
if (-not (Test-Path $BridgeScript)) { throw "Bridge service script missing: $BridgeScript" }
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source

Import-EnvFile $BridgeEnv
if ($env:MT5_ALLOW_REAL_ACCOUNT -match '^(?i:true|1|yes|on)$') {
  throw "V19 core startup refuses MT5_ALLOW_REAL_ACCOUNT=true."
}
$key = $env:MT5_API_KEY
if ([string]::IsNullOrWhiteSpace($key)) { throw "MT5_API_KEY missing in Bridge DEMO env." }

$bridgeHealthUrl = "http://127.0.0.1:$BridgePort/health"
$bridgeReady = $false
try {
  $h = Invoke-RestMethod -Uri $bridgeHealthUrl -Headers @{ "x-mt5-api-key" = $key } -TimeoutSec 3
  $bridgeReady = ($h.connected -eq $true -and $h.accountMode -eq "demo")
} catch {}

if (-not $bridgeReady) {
  Stop-ListeningPort $BridgePort "BRIDGE"
  Write-CoreLog "BRIDGE_STARTING=TRUE"
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
    "-File", $BridgeScript, "-EnvFile", $BridgeEnv
  ) -WindowStyle Hidden | Out-Null
}

$bridgeReady = Wait-Until {
  $h = Invoke-RestMethod -Uri $bridgeHealthUrl -Headers @{ "x-mt5-api-key" = $key } -TimeoutSec 2
  return ($h.connected -eq $true -and $h.accountMode -eq "demo")
} 45 "PHASE7B_V19_BRIDGE_READY"
if (-not $bridgeReady) { throw "Bridge DEMO did not become ready." }

# The API imports workspace packages through their built dist exports. Rebuild the
# strategy engine before API startup so a source update can never be paired with
# stale dist output (for example a newly exported RangeBoundaryUtils symbol).
Write-CoreLog "STRATEGY_ENGINE_BUILD_STARTING=TRUE"
Push-Location $Root
try {
  & $pnpm --filter '@xauusd/strategy-engine' build
  $strategyBuildExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($strategyBuildExit -ne 0) {
  Write-CoreLog "PHASE7B_V19_STRATEGY_ENGINE_BUILD=FAIL"
  throw "Strategy engine build failed with exit code $strategyBuildExit."
}
Write-CoreLog "PHASE7B_V19_STRATEGY_ENGINE_BUILD=PASS"

# Force a fresh API process on each logon/start so PHASE7B_DEMO_WORK_DIR can never
# inherit an old historical-replay work folder.
Stop-ListeningPort $ApiPort "API"
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
& '$pnpm' --filter '@xauusd/api' dev
"@
[System.IO.File]::WriteAllText($ApiLauncher, $apiScript, (New-Object System.Text.UTF8Encoding($false)))
Write-CoreLog "API_STARTING=TRUE"
$apiProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $ApiLauncher
) -WindowStyle Hidden -PassThru

$apiReady = Wait-Until {
  $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 2
  return ($snapshot.mt5.health.accountMode -eq "demo")
} 45 "PHASE7B_V19_API_READY"
if (-not $apiReady) { throw "API did not become ready." }

# Force a fresh Web process too. This avoids stale Vite instances after reboot or
# previous manual sessions.
Stop-ListeningPort $WebPort "WEB"
$WebDir = Join-Path $Root "apps\web"
$webScript = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$WebDir'
`$env:VITE_API_BASE_URL = ''
`$env:VITE_DEV_API_PROXY_TARGET = 'http://127.0.0.1:$ApiPort'
& '$pnpm' exec vite --host 127.0.0.1 --port $WebPort --strictPort
"@
[System.IO.File]::WriteAllText($WebLauncher, $webScript, (New-Object System.Text.UTF8Encoding($false)))
Write-CoreLog "WEB_STARTING=TRUE"
$webProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $WebLauncher
) -WindowStyle Hidden -PassThru

$webReady = Wait-Until {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/phase7b-ops" -UseBasicParsing -TimeoutSec 2
  return ($response.StatusCode -eq 200)
} 35 "PHASE7B_V19_WEB_READY"
if (-not $webReady) { throw "Web did not become ready." }

$state = [ordered]@{
  version = 19
  generatedAt = [DateTimeOffset]::Now.ToString("o")
  root = $Root
  demoDir = $DemoDir
  bridgePort = $BridgePort
  apiPort = $ApiPort
  webPort = $WebPort
  apiLauncherPid = $apiProcess.Id
  webLauncherPid = $webProcess.Id
  botAutostart = $false
  telegramAutostart = $false
  realAccountAllowed = $false
}
$state | ConvertTo-Json -Depth 4 | Set-Content -Path $RuntimeState -Encoding UTF8

Write-CoreLog "PHASE7B_V19_DEMO_WORK_DIR=$DemoDir"
Write-CoreLog "PHASE7B_V19_CORE_BACKGROUND=PASS"
Write-CoreLog "PHASE7B_V19_BOT_AUTOSTART=False"
Write-CoreLog "PHASE7B_V19_TELEGRAM_AUTOSTART=False"
Write-CoreLog "PHASE7B_V19_REAL_ACCOUNT_ALLOWED=False"
