param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [decimal]$FixedVolume = 0.03,
  [int]$IntervalSeconds = 5,
  [string]$BridgeEnv = "",
  [string]$TelegramEnvFile = ".env.phase7b-telegram",
  [int]$BridgeWaitSeconds = 600
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$demoDir = if ((Split-Path -Leaf $WorkDir) -eq "phase7b-demo-forward") { $WorkDir } else { Join-Path $WorkDir "phase7b-demo-forward" }
$runtimePath = Join-Path $demoDir "phase7b-demo-runtime.json"

if (Test-Path $runtimePath) {
  try {
    $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
    if ($runtime.armed -and $runtime.status -eq "RUNNING" -and $null -ne $runtime.pid) {
      Get-Process -Id ([int]$runtime.pid) -ErrorAction Stop | Out-Null
      Write-Host "PHASE7B_AUTOSTART_BOT=ALREADY_RUNNING"
      Write-Host "PHASE7B_AUTOSTART_BOT_PID=$($runtime.pid)"
      exit 0
    }
  } catch {}
}

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
}
if (-not (Test-Path $BridgeEnv)) { throw "Phase 7B bridge env not found: $BridgeEnv" }
$BridgeEnv = (Resolve-Path $BridgeEnv).Path

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
$bridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
$bridgePort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { "8765" } else { [string]$values["MT5_BRIDGE_PORT"] }
$bridgeBase = "http://${bridgeHost}:${bridgePort}"
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 16) { throw "Phase 7B autostart requires a valid MT5_API_KEY." }
if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "Phase 7B autostart refuses MT5_ALLOW_REAL_ACCOUNT=true." }

Write-Host "PHASE7B_AUTOSTART_WRAPPER=WAITING_BRIDGE"
Write-Host "PHASE7B_AUTOSTART_BRIDGE=$bridgeBase"
Write-Host "PHASE7B_AUTOSTART_REAL_ACCOUNT_ALLOWED=false"

$deadline = (Get-Date).AddSeconds([Math]::Max(30, $BridgeWaitSeconds))
$health = $null
while ((Get-Date) -lt $deadline) {
  try {
    $probe = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers @{ "x-mt5-api-key" = $apiKey } -Method Get -TimeoutSec 5
    if ($probe.accountMode -eq "real") {
      throw "REAL account detected. Phase 7B DEMO autostart is blocked."
    }
    if (
      $probe.connected -and
      $probe.status -eq "ok" -and
      $probe.accountMode -eq "demo" -and
      $probe.tradingEnabled -and
      $probe.terminalTradeAllowed -and
      $probe.expertTradeAllowed
    ) {
      $health = $probe
      break
    }
  } catch {
    if ($_.Exception.Message -like "*REAL account detected*") { throw }
  }
  Start-Sleep -Seconds 5
}

if ($null -eq $health) {
  throw "Phase 7B DEMO bridge/account was not ready within $BridgeWaitSeconds seconds."
}

Write-Host "PHASE7B_AUTOSTART_BRIDGE=PASS"
Write-Host "PHASE7B_AUTOSTART_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7B_AUTOSTART_ACCOUNT_MODE=$($health.accountMode)"

$notifyScript = Join-Path $PSScriptRoot "run-phase7b-bot-online-telegram.ps1"
if (Test-Path $notifyScript) {
  $notifyArgs = @(
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $notifyScript + '"'),
    "-WorkDir", ('"' + $WorkDir + '"'),
    "-EnvFile", ('"' + $TelegramEnvFile + '"'),
    "-FixedVolume", [string]$FixedVolume
  )
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $notifyArgs | Out-Null
}

$launcher = Join-Path $PSScriptRoot "run-phase7b-demo-local.ps1"
if (-not (Test-Path $launcher)) { throw "Phase 7B DEMO launcher missing: $launcher" }

Write-Host "PHASE7B_AUTOSTART_BOT=STARTING"
& $launcher -WorkDir $WorkDir -FixedVolume $FixedVolume -IntervalSeconds $IntervalSeconds -BridgeEnv $BridgeEnv -ArmDemoTrading
