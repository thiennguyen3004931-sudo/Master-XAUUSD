param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [decimal]$FixedVolume = 0.03,
  [int]$IntervalSeconds = 5,
  [int]$PreCloseMinSeconds = 5,
  [int]$PreCloseMaxSeconds = 10,
  [string]$BridgeEnv = "",
  [switch]$ArmDemoTrading,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path

if ([string]::IsNullOrWhiteSpace($BridgeEnv)) {
  $BridgeEnv = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo"
}

$BridgeExample = Join-Path $ProjectRoot "packages\mt5-broker\bridge\.env.phase7b-demo.example"
if (-not (Test-Path $BridgeEnv)) {
  if (Test-Path $BridgeExample) {
    Copy-Item $BridgeExample $BridgeEnv
    Write-Host "PHASE7B_DEMO_ENV_CREATED=$BridgeEnv" -ForegroundColor Yellow
    Write-Host "Edit MT5_API_KEY and, after preflight shows the DEMO login, set MT5_ALLOWED_LOGINS to that exact login." -ForegroundColor Yellow
  } else {
    Write-Host "Phase 7B DEMO env file missing: $BridgeEnv" -ForegroundColor Red
  }
  exit 1
}

if ($FixedVolume -le 0) { throw "FixedVolume must be positive." }
if ($IntervalSeconds -lt 1) { throw "IntervalSeconds must be >= 1." }
if ($PreCloseMinSeconds -lt 1) { throw "PreCloseMinSeconds must be >= 1." }
if ($PreCloseMaxSeconds -le $PreCloseMinSeconds -or $PreCloseMaxSeconds -gt 30) {
  throw "Pre-close window must satisfy 1 <= min < max <= 30 seconds."
}

# Pre-close detection must sample more frequently than the 5-10 second entry
# window. Keep the user's normal interval for management, but run the armed
# controller at one-second cadence so the provisional window is not skipped.
$EffectiveIntervalSeconds = if ($ArmDemoTrading) { 1 } else { $IntervalSeconds }

$BridgeEnv = (Resolve-Path $BridgeEnv).Path
$DemoWorkDir = Join-Path $WorkDir "phase7b-demo-forward"
New-Item -ItemType Directory -Path $DemoWorkDir -Force | Out-Null
$RuntimePath = Join-Path $DemoWorkDir "phase7b-demo-runtime.json"

function Get-EpochMs {
  return [long](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
}

function Write-DemoRuntimeState {
  param(
    [Parameter(Mandatory = $true)] [string]$Status,
    [Parameter(Mandatory = $true)] [bool]$Armed,
    [object]$ProcessId,
    [object]$StartedAt
  )

  $payload = [ordered]@{
    version = 1
    status = $Status
    armed = $Armed
    pid = $ProcessId
    heartbeatAt = Get-EpochMs
    startedAt = $StartedAt
    intervalSeconds = $EffectiveIntervalSeconds
  }
  $tmp = "$RuntimePath.tmp"
  $json = $payload | ConvertTo-Json -Depth 4
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
  Move-Item -Path $tmp -Destination $RuntimePath -Force
}

# Load the dedicated DEMO bridge env into this process. This is intentionally
# separate from the default bridge env so the DEMO controller cannot inherit a
# real-account opt-in accidentally.
Get-Content $BridgeEnv | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
  $parts = $line -split "=", 2
  $name = $parts[0].Trim()
  $value = $parts[1].Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

$env:ZIQ_BRIDGE_ENV = $BridgeEnv
$env:ZIQ_DEMO_WORK_DIR = $DemoWorkDir
$env:ZIQ_FIXED_VOLUME = [string]$FixedVolume
$env:ZIQ_DEMO_INTERVAL_SECONDS = [string]$EffectiveIntervalSeconds
$env:ZIQ_DEMO_ARMED = if ($ArmDemoTrading) { "true" } else { "false" }
$env:ZIQ_DEMO_ONCE = if ($Once) { "true" } else { "false" }
$env:ZIQ_DEMO_SYMBOL = "XAUUSD"
$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "true"
$env:ZIQ_PRE_CLOSE_MIN_SECONDS = [string]$PreCloseMinSeconds
$env:ZIQ_PRE_CLOSE_MAX_SECONDS = [string]$PreCloseMaxSeconds

Write-Host "PHASE7B_DEMO_WORK_DIR=$DemoWorkDir"
Write-Host "PHASE7B_DEMO_BRIDGE_ENV=$BridgeEnv"
Write-Host "PHASE7B_DEMO_FIXED_VOLUME=$FixedVolume"
Write-Host "PHASE7B_DEMO_INTERVAL_SECONDS_REQUESTED=$IntervalSeconds"
Write-Host "PHASE7B_DEMO_INTERVAL_SECONDS_EFFECTIVE=$EffectiveIntervalSeconds"
Write-Host "PHASE7B_DEMO_PRE_CLOSE_ENTRY=ENABLED"
Write-Host "PHASE7B_DEMO_PRE_CLOSE_WINDOW_SECONDS=$PreCloseMinSeconds-$PreCloseMaxSeconds"
Write-Host "PHASE7B_DEMO_PRE_CLOSE_CANDLE=FORMING_M15_PROVISIONAL"
Write-Host "PHASE7B_DEMO_ARM_REQUESTED=$($ArmDemoTrading.IsPresent)"
Write-Host "PHASE7B_DEMO_REAL_ACCOUNT_ALLOWED=false"
Write-Host "PHASE7B_DEMO_RUNTIME_STATE=$RuntimePath"

if ($env:MT5_ALLOW_REAL_ACCOUNT -match '^(?i:true|1|yes|on)$') {
  throw "Phase 7B DEMO refuses MT5_ALLOW_REAL_ACCOUNT=true."
}
if ([string]::IsNullOrWhiteSpace($env:MT5_API_KEY) -or $env:MT5_API_KEY.Length -lt 16) {
  throw "Phase 7B DEMO requires MT5_API_KEY with at least 16 characters."
}

$BridgeHost = if ([string]::IsNullOrWhiteSpace($env:MT5_BRIDGE_HOST)) { "127.0.0.1" } else { $env:MT5_BRIDGE_HOST }
$BridgePort = if ([string]::IsNullOrWhiteSpace($env:MT5_BRIDGE_PORT)) { "8765" } else { $env:MT5_BRIDGE_PORT }
$BridgeBase = "http://${BridgeHost}:${BridgePort}"
$Headers = @{ "x-mt5-api-key" = $env:MT5_API_KEY }

# Read-only preflight deliberately avoids Node/tsx on Windows. This isolates
# broker/account validation from a libuv shutdown assertion seen in Node 24 + tsx.
if (-not $ArmDemoTrading -and $Once) {
  Write-Host "PHASE7B_DEMO_PREFLIGHT_ENGINE=POWERSHELL_HTTP"
  try {
    $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $Headers -Method Get -TimeoutSec 8
  } catch {
    throw "Phase 7B DEMO bridge health request failed: $($_.Exception.Message)"
  }

  Write-Host "PHASE7B_DEMO_ACCOUNT_LOGIN=$($health.accountLogin)"
  Write-Host "PHASE7B_DEMO_ACCOUNT_MODE=$($health.accountMode)"
  Write-Host "PHASE7B_DEMO_SERVER=$($health.server)"
  Write-Host "PHASE7B_DEMO_BRIDGE_TRADING_ENABLED=$(if ($health.tradingEnabled) { 'YES' } else { 'NO' })"
  Write-Host "PHASE7B_DEMO_TERMINAL_TRADE_ALLOWED=$(if ($health.terminalTradeAllowed) { 'YES' } else { 'NO' })"
  Write-Host "PHASE7B_DEMO_EXPERT_TRADE_ALLOWED=$(if ($health.expertTradeAllowed) { 'YES' } else { 'NO' })"

  if (-not $health.connected -or $health.status -ne "ok") {
    throw "MT5 bridge is not healthy/connected."
  }
  if ($health.accountMode -ne "demo") {
    throw "Phase 7B DEMO requires accountMode=demo, got $($health.accountMode)."
  }
  if ($null -eq $health.accountLogin) {
    throw "MT5 DEMO account login is unavailable."
  }

  Write-Host "PHASE7B_DEMO_PREFLIGHT_STATUS=PASS"
  Write-Host "PHASE7B_DEMO_ORDER_SEND=DISABLED_NOT_ARMED"
  Write-Host "PHASE7B_DEMO_RUN_STATUS=PASS"
  exit 0
}

$ControllerTs = Join-Path $ProjectRoot "scripts\run-phase7b-demo-controller.ts"
$ControllerMts = Join-Path $ProjectRoot "scripts\.phase7b-demo-controller.mts"
$PreCloseHook = Join-Path $ProjectRoot "scripts\phase7b-preclose-fetch-hook.mts"
$RiskEngineEsm = Join-Path $ProjectRoot "packages\risk-engine\dist\index.js"
if (-not (Test-Path $ControllerTs)) { throw "Phase 7B DEMO controller missing: $ControllerTs" }
if (-not (Test-Path $PreCloseHook)) { throw "Phase 7B DEMO pre-close hook missing: $PreCloseHook" }
$PreCloseHookUri = ([System.Uri]::new($PreCloseHook)).AbsoluteUri

$BotProcess = $null
$RuntimeStartedAt = $null

Push-Location $ProjectRoot
try {
  Write-Host "PHASE7B_DEMO_BUILD_START"
  & pnpm --filter @xauusd/risk-engine build
  if ($LASTEXITCODE -ne 0) { throw "Phase 7B DEMO risk-engine build failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7B_DEMO_BUILD_STATUS=PASS"

  if (-not (Test-Path $RiskEngineEsm)) { throw "Phase 7B DEMO risk-engine ESM build missing: $RiskEngineEsm" }

  # Node 24 can strip erasable TypeScript types natively. Create a temporary
  # .mts entrypoint so the controller is ESM, then point its workspace import
  # directly at the risk-engine ESM artifact built above. This removes tsx from
  # the DEMO runtime path entirely.
  $ControllerText = Get-Content $ControllerTs -Raw
  $ControllerText = $ControllerText.Replace('from "@xauusd/risk-engine";', 'from "../packages/risk-engine/dist/index.js";')
  if ($ControllerText -match '@xauusd/risk-engine') {
    throw "Phase 7B DEMO temporary controller still contains unresolved @xauusd/risk-engine import."
  }
  Set-Content -Path $ControllerMts -Value $ControllerText -Encoding UTF8

  Write-Host "PHASE7B_DEMO_CONTROLLER_MODULE=NODE24_NATIVE_TS_MTS"
  Write-Host "PHASE7B_DEMO_RISK_ENGINE_IMPORT=../packages/risk-engine/dist/index.js"
  Write-Host "PHASE7B_DEMO_TSX_RUNTIME=OFF"
  Write-Host "PHASE7B_DEMO_PRE_CLOSE_HOOK=$PreCloseHook"
  Write-Host "PHASE7B_DEMO_PRE_CLOSE_HOOK_URI=$PreCloseHookUri"

  if ($ArmDemoTrading) {
    $RuntimeStartedAt = Get-EpochMs
    Write-DemoRuntimeState -Status "STARTING" -Armed $true -ProcessId $null -StartedAt $RuntimeStartedAt
    $NodeExe = (Get-Command node -ErrorAction Stop).Source
    $ImportArg = "--import=$PreCloseHookUri"
    $BotProcess = Start-Process -FilePath $NodeExe -ArgumentList @($ImportArg, $ControllerMts) -NoNewWindow -PassThru
    Write-DemoRuntimeState -Status "RUNNING" -Armed $true -ProcessId $BotProcess.Id -StartedAt $RuntimeStartedAt
    Write-Host "PHASE7B_DEMO_RUNTIME_ARMED=YES"
    Write-Host "PHASE7B_DEMO_RUNTIME_PID=$($BotProcess.Id)"
    Write-Host "PHASE7B_DEMO_RUNTIME_HEARTBEAT=ON"

    while (-not $BotProcess.HasExited) {
      Write-DemoRuntimeState -Status "RUNNING" -Armed $true -ProcessId $BotProcess.Id -StartedAt $RuntimeStartedAt
      Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min($EffectiveIntervalSeconds, 5)))
      $BotProcess.Refresh()
    }

    $exitCode = $BotProcess.ExitCode
    Write-DemoRuntimeState -Status "STOPPED" -Armed $false -ProcessId $BotProcess.Id -StartedAt $RuntimeStartedAt
    if ($exitCode -ne 0) { throw "Phase 7B DEMO controller exited with code $exitCode" }
  } else {
    & node "--import=$PreCloseHookUri" $ControllerMts
    $controllerExitCode = $LASTEXITCODE

    # Node 24 on Windows can hit a libuv async-handle assertion while the
    # short-lived read-only preview process is shutting down, after all preview
    # work has already completed. Never relax this for an armed controller.
    # The exact Windows status below is the observed UV_HANDLE_CLOSING assertion.
    if ($controllerExitCode -eq -1073740791) {
      Write-Host "PHASE7B_DEMO_PREVIEW_NODE24_LIBUV_SHUTDOWN_ASSERTION=KNOWN_NON_TRADING_EXIT" -ForegroundColor Yellow
      Write-Host "PHASE7B_DEMO_PREVIEW_ORDER_SEND=DISABLED_NOT_ARMED" -ForegroundColor Yellow
      Write-Host "PHASE7B_DEMO_RUN_STATUS=PASS_WITH_NODE24_PREVIEW_SHUTDOWN_WORKAROUND" -ForegroundColor Yellow
      $controllerExitCode = 0
    }

    if ($controllerExitCode -ne 0) { throw "Phase 7B DEMO controller exited with code $controllerExitCode" }
  }
}
finally {
  if ($ArmDemoTrading -and $null -ne $BotProcess) {
    try {
      $BotProcess.Refresh()
      if (-not $BotProcess.HasExited) {
        Stop-Process -Id $BotProcess.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {}
    try {
      Write-DemoRuntimeState -Status "STOPPED" -Armed $false -ProcessId $BotProcess.Id -StartedAt $RuntimeStartedAt
    } catch {}
  }
  Remove-Item $ControllerMts -Force -ErrorAction SilentlyContinue
  Pop-Location
}