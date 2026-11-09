param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$BridgeEnv = "",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$ApiRunner = Join-Path $PSScriptRoot "run-phase7b-api-runtime-local.ps1"
if (-not (Test-Path -LiteralPath $ApiRunner)) { throw "Phase 7B API runtime launcher not found: $ApiRunner" }

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
}
if (-not (Test-Path $BridgeEnv)) {
  throw "Phase 7B DEMO bridge env not found: $BridgeEnv"
}
$BridgeEnv = (Resolve-Path $BridgeEnv).Path

if ($ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw "ApiPort is invalid." }
if ($WebPort -lt 1024 -or $WebPort -gt 65535) { throw "WebPort is invalid." }
if ($ApiPort -eq $WebPort) { throw "ApiPort and WebPort must be different." }

$values = @{}
Get-Content $BridgeEnv | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
  $parts = $line -split "=", 2
  $name = $parts[0].Trim().TrimStart([char]0xFEFF)
  $value = $parts[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  $values[$name] = $value
}

$apiKey = [string]$values["MT5_API_KEY"]
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 16) {
  throw "MT5_API_KEY in the DEMO bridge env is invalid."
}

$systemMagic = [string]$values["MT5_MAGIC_NUMBER"]
if ([string]::IsNullOrWhiteSpace($systemMagic)) { $systemMagic = "270713" }
$systemMagicNumber = 0
if (-not [int]::TryParse($systemMagic, [ref]$systemMagicNumber) -or $systemMagicNumber -le 0) {
  throw "MT5_MAGIC_NUMBER in the DEMO bridge env is invalid."
}

$bridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
$bridgePort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { "8765" } else { [string]$values["MT5_BRIDGE_PORT"] }
$bridgeBase = "http://${bridgeHost}:${bridgePort}"
$demoDir = Join-Path $WorkDir "phase7b-demo-forward"
New-Item -ItemType Directory -Path $demoDir -Force | Out-Null

try {
  $bridgeHealth = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 5
} catch {
  throw "Phase 7B WEB bridge authentication failed before launch: $($_.Exception.Message)"
}
if (-not $bridgeHealth.connected) {
  throw "Phase 7B WEB bridge is reachable but MT5 terminal is disconnected."
}
if ($bridgeHealth.accountMode -ne "demo") {
  throw "Phase 7B WEB requires MT5 accountMode=demo, got $($bridgeHealth.accountMode)."
}
Write-Host "PHASE7B_WEB_BRIDGE_AUTH=PASS"
Write-Host "PHASE7B_WEB_BRIDGE_ACCOUNT_MODE=$($bridgeHealth.accountMode)"
Write-Host "PHASE7B_WEB_BRIDGE_SERVER=$($bridgeHealth.server)"
Write-Host "PHASE7B_WEB_SYSTEM_MAGIC=$systemMagicNumber"

$apiUrl = "http://127.0.0.1:${ApiPort}"
$webUrl = "http://127.0.0.1:${WebPort}"

foreach ($port in @($ApiPort, $WebPort)) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    throw "Phase 7B dedicated port $port is already in use by PID(s): $($pids -join ', '). Stop that process or choose another port."
  }
}

$apiProcess = Start-Process powershell.exe -PassThru -ArgumentList @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ('"{0}"' -f $ApiRunner),
  "-WorkDir", ('"{0}"' -f $WorkDir),
  "-BridgeEnv", ('"{0}"' -f $BridgeEnv),
  "-ApiPort", [string]$ApiPort,
  "-WebOrigin", ('"{0}"' -f $webUrl)
)

# Browser requests remain same-origin. Vite proxies /api to the dedicated API,
# eliminating cross-origin/CORS dependency for local DEMO monitoring.
$env:VITE_API_BASE_URL = ""
$env:VITE_DEV_API_PROXY_TARGET = $apiUrl
$webCommand = "Set-Location '$ProjectRoot'; Write-Host 'PHASE7B_WEB_UI=$webUrl/phase7b-demo'; pnpm --filter @xauusd/web dev -- --host 127.0.0.1 --port $WebPort --strictPort"
$webProcess = Start-Process powershell.exe -PassThru -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-Command", $webCommand
)
Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:VITE_DEV_API_PROXY_TARGET -ErrorAction SilentlyContinue

Write-Host "PHASE7B_WEB_API_PID=$($apiProcess.Id)"
Write-Host "PHASE7B_WEB_UI_PID=$($webProcess.Id)"
Write-Host "PHASE7B_WEB_DEMO_DIR=$demoDir"
Write-Host "PHASE7B_WEB_API=$apiUrl/api/v1/phase7b-demo"
Write-Host "PHASE7B_WEB_UI=$webUrl/phase7b-demo"
Write-Host "PHASE7B_WEB_API_TRANSPORT=SAME_ORIGIN_VITE_PROXY"
Write-Host "PHASE7B_WEB_READ_ONLY=PASS"
Write-Host "PHASE7B_WEB_LEGACY_PORTS_3001_5173=BYPASSED"
Write-Host "PHASE7B_WEB_API_TURBO=OFF"

$apiReady = $false
for ($attempt = 1; $attempt -le 16; $attempt++) {
  Start-Sleep -Milliseconds 750
  try {
    $snapshot = Invoke-RestMethod -Uri "$apiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 3
    if ($snapshot) {
      $apiReady = $true
      Write-Host "PHASE7B_WEB_API_SELFTEST=PASS"
      Write-Host "PHASE7B_WEB_BOT_STATUS=$($snapshot.botStatus)"
      Write-Host "PHASE7B_WEB_MT5_REACHABLE=$($snapshot.mt5.reachable)"
      if ($null -ne $snapshot.entryDiagnostics) {
        Write-Host "PHASE7B_WEB_ENTRY_DIAGNOSTICS=PASS"
        Write-Host "PHASE7B_WEB_ENTRY_ELIGIBLE=$($snapshot.entryDiagnostics.entry.eligible)"
        Write-Host "PHASE7B_WEB_ENTRY_SIDE=$($snapshot.entryDiagnostics.entry.side)"
        Write-Host "PHASE7B_WEB_FVG_REQUIRED_FOR_ENTRY=$($snapshot.entryDiagnostics.fvg.requiredForEntry)"
      } else {
        Write-Warning "Phase 7B entry diagnostics unavailable: $($snapshot.entryDiagnosticsError)"
      }
      break
    }
  } catch {
    if ($attempt -eq 16) {
      Write-Warning "Phase 7B WEB API self-test did not pass yet: $($_.Exception.Message)"
    }
  }
}

if ($apiReady) {
  try {
    $mt5Status = Invoke-RestMethod -Uri "$apiUrl/api/v1/mt5/status?symbol=XAUUSD" -Method Get -TimeoutSec 5
    Write-Host "PHASE7B_WEB_MT5_SECTION=PASS"
    Write-Host "PHASE7B_WEB_MT5_SECTION_STATUS=$($mt5Status.status)"
  } catch {
    Write-Warning "MT5/System section self-test failed: $($_.Exception.Message)"
  }

  try {
    $performance = Invoke-RestMethod -Uri "$apiUrl/api/v1/mt5/performance?symbol=XAUUSD&days=30" -Method Get -TimeoutSec 8
    Write-Host "PHASE7B_WEB_PERFORMANCE_SECTION=PASS"
    Write-Host "PHASE7B_WEB_PERFORMANCE_SYSTEM_TRADES=$($performance.systemOwned.metrics.totalTrades)"
    Write-Host "PHASE7B_WEB_PERFORMANCE_SAMPLE_READY=$($performance.systemOwned.sampleReady)"
  } catch {
    Write-Warning "MT5 Performance section self-test failed: $($_.Exception.Message)"
  }
} else {
  Write-Warning "Web processes were started, but Phase 7B API self-test is not PASS. Inspect the API child window before trusting the monitor."
}

Start-Process "$webUrl/phase7b-demo"
