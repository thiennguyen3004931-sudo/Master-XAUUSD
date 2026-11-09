param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$DemoEnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$LiveEnvFile = "packages/mt5-broker/bridge/.env.phase7b-live",
  [int]$StartupTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$BridgeDir = Join-Path $ProjectRoot "packages\mt5-broker\bridge"
$BridgeRunner = Join-Path $BridgeDir "run.ps1"
$AccountStatePath = Join-Path $ProjectRoot ".runtime\phase7c-account-mode.json"

foreach ($required in @($AccountLibrary, $BridgeRunner, $AccountStatePath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required LIVE read-only probe file not found: $required" }
}
if ($StartupTimeoutSeconds -lt 30 -or $StartupTimeoutSeconds -gt 300) {
  throw "StartupTimeoutSeconds must be between 30 and 300."
}

. $AccountLibrary

function Resolve-ProjectPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path $ProjectRoot $Path
}

function Invoke-BridgeGet([string]$BaseUrl, [string]$Path, $EnvInfo) {
  return Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))$Path" -Headers @{ "x-mt5-api-key" = $EnvInfo.apiKey } -Method Get -TimeoutSec 5
}

function Get-JsonArrayCount([string]$Content) {
  $raw = ([string]$Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return 0 }
  $parsed = $raw | ConvertFrom-Json
  return @($parsed | Where-Object { $null -ne $_ }).Count
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$DemoEnvFile = Resolve-ProjectPath $DemoEnvFile
$LiveEnvFile = Resolve-ProjectPath $LiveEnvFile

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "LIVE read-only terminal probe requires PowerShell Administrator."
}

$accountState = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
if ([int]$accountState.version -ne 1) { throw "Unsupported account-mode state version." }
$selectedMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
if ($selectedMode -ne "DEMO") {
  throw "LIVE read-only probe requires the selected runtime to remain DEMO. Actual=$selectedMode"
}

$botBefore = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$botBefore.state.mode -ne "PAUSE") {
  throw "LIVE read-only probe requires bot mode PAUSE. Actual=$($botBefore.state.mode)"
}

$demoEnv = Assert-Phase7CAccountEnv -EnvFile $DemoEnvFile -AccountMode "DEMO" -RequireTrading
$demoBase = "http://$($demoEnv.bridgeHost):$($demoEnv.bridgePort)"
$demoHealthBefore = Invoke-BridgeGet $demoBase "/health" $demoEnv
if (-not $demoHealthBefore.connected -or [string]$demoHealthBefore.accountMode -ne "demo") {
  throw "Current DEMO bridge is not healthy and connected to a DEMO account."
}
if ([string]$demoHealthBefore.configuredAccountMode -ne "DEMO") {
  throw "Current guarded DEMO bridge configuredAccountMode mismatch."
}
if ([string]::IsNullOrWhiteSpace([string]$demoHealthBefore.bridgeSessionId)) {
  throw "Current guarded DEMO bridge session id is missing."
}
if ($demoEnv.allowedLogins -notcontains [long]$demoHealthBefore.accountLogin) {
  throw "Current DEMO bridge login is outside the configured allowlist."
}
$demoSessionBefore = [string]$demoHealthBefore.bridgeSessionId
$demoLoginBefore = [long]$demoHealthBefore.accountLogin

$demoTerminal = ([string](Get-Phase7CEnvValue $DemoEnvFile "MT5_TERMINAL_PATH")).Trim()
if ([string]::IsNullOrWhiteSpace($demoTerminal)) {
  throw "DEMO MT5_TERMINAL_PATH is required to prove dual-terminal separation."
}
if (-not (Test-Path -LiteralPath $demoTerminal)) {
  throw "Configured DEMO terminal path does not exist: $demoTerminal"
}

$liveIdentity = Get-Phase7CLiveProfileIdentity $LiveEnvFile
if (-not (Test-Path -LiteralPath $liveIdentity.terminalPath)) {
  throw "Configured LIVE terminal path does not exist: $($liveIdentity.terminalPath)"
}
if ([System.IO.Path]::GetFileName($liveIdentity.terminalPath) -notmatch '^(?i:terminal64\.exe)$') {
  throw "Configured LIVE terminal path must point to terminal64.exe."
}
$demoFull = [System.IO.Path]::GetFullPath($demoTerminal).TrimEnd('\\').ToLowerInvariant()
$liveFull = [System.IO.Path]::GetFullPath($liveIdentity.terminalPath).TrimEnd('\\').ToLowerInvariant()
if ($demoFull -eq $liveFull) {
  throw "DEMO and LIVE must use different terminal64.exe paths for the dual-terminal architecture."
}

$liveEnv = Assert-Phase7CAccountEnv -EnvFile $LiveEnvFile -AccountMode "LIVE"
if ($liveEnv.tradingEnabled) {
  throw "LIVE read-only probe refuses MT5_TRADING_ENABLED=true."
}
$compatibility = Test-Phase7CTruthy (Get-Phase7CEnvValue $LiveEnvFile "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING")
if ($compatibility) {
  throw "LIVE read-only probe refuses XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=true."
}

$liveRiskPath = Get-Phase7CRiskProfilePath $WorkDir "LIVE"
if (-not (Test-Path -LiteralPath $liveRiskPath)) {
  throw "LIVE risk profile is missing: $liveRiskPath"
}
$liveRiskRaw = Get-Content -LiteralPath $liveRiskPath -Raw | ConvertFrom-Json
$liveRisk = Assert-Phase7CLiveRiskProfileBinding $liveRiskRaw $LiveEnvFile "LIVE read-only probe risk profile"

# A read-only probe must never inherit a stale LIVE arm. Clearing the local arm
# file is safe and intentionally leaves LIVE DISARMED after the probe finishes.
Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "live-readonly-probe"

$probeRoot = Join-Path $WorkDir "phase7c-live-readonly-probe"
New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
$token = "$PID.$([guid]::NewGuid().ToString('N'))"
$probeEnvPath = Join-Path $probeRoot "probe.$token.env"
$probeStdOut = Join-Path $probeRoot "probe.$token.out.log"
$probeStdErr = Join-Path $probeRoot "probe.$token.err.log"
$probeLedger = Join-Path $probeRoot "probe.$token.sqlite3"
$liveArmPath = Get-Phase7CLiveArmPath $WorkDir

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Set-ProbeEnvLine([System.Collections.Generic.List[string]]$Lines, [string]$Name, [string]$Value) {
  $replacement = "$Name=$Value"
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    $raw = ([string]$Lines[$i]).TrimStart([char]0xFEFF)
    if ($raw -match ('^' + [regex]::Escape($Name) + '=')) {
      $Lines[$i] = $replacement
      return
    }
  }
  [void]$Lines.Add($replacement)
}

$probePort = Get-FreeLoopbackPort
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in Get-Content -LiteralPath $LiveEnvFile) { [void]$lines.Add([string]$line) }
Set-ProbeEnvLine $lines "MT5_BRIDGE_HOST" "127.0.0.1"
Set-ProbeEnvLine $lines "MT5_BRIDGE_PORT" ([string]$probePort)
Set-ProbeEnvLine $lines "MT5_TRADING_ENABLED" "false"
Set-ProbeEnvLine $lines "XAUUSD_PHASE7C_ALLOW_LIVE_TRADING" "false"
Set-ProbeEnvLine $lines "MT5_LEDGER_PATH" $probeLedger
Set-ProbeEnvLine $lines "MT5_FAIL_STARTUP_IF_DISCONNECTED" "true"
[System.IO.File]::WriteAllText($probeEnvPath, (($lines -join "`r`n") + "`r`n"), [System.Text.UTF8Encoding]::new($false))

$process = $null
$probeError = $null
$cleanupError = $null
$health = $null
$positionCount = $null
$orderCount = $null

try {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $BridgeRunner),
    "-EnvFile", ('"{0}"' -f $probeEnvPath),
    "-AccountMode", "LIVE",
    "-LiveArmStatePath", ('"{0}"' -f $liveArmPath)
  )

  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $BridgeDir `
    -RedirectStandardOutput $probeStdOut `
    -RedirectStandardError $probeStdErr `
    -PassThru

  $base = "http://127.0.0.1:$probePort"
  $headers = @{ "x-mt5-api-key" = $liveEnv.apiKey }
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)

  do {
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited) {
      $detail = ""
      if (Test-Path -LiteralPath $probeStdErr) { $detail = (Get-Content -LiteralPath $probeStdErr -Tail 20 -ErrorAction SilentlyContinue) -join " | " }
      throw "LIVE read-only bridge exited before health became available. ExitCode=$($process.ExitCode) $detail"
    }
    try {
      $candidate = Invoke-RestMethod -Uri "$base/health" -Headers $headers -Method Get -TimeoutSec 5
      if ($candidate.connected -and $candidate.status -eq "ok") { $health = $candidate; break }
    } catch {}
  } while ((Get-Date) -lt $deadline)

  if ($null -eq $health) { throw "LIVE read-only bridge did not become healthy within $StartupTimeoutSeconds seconds." }
  if ([string]$health.accountMode -ne "real") { throw "LIVE probe connected account is not REAL. Actual=$($health.accountMode)" }
  if ([string]$health.configuredAccountMode -ne "LIVE") { throw "LIVE probe bridge configured mode mismatch. Actual=$($health.configuredAccountMode)" }
  if ([long]$health.accountLogin -ne [long]$liveIdentity.login) { throw "LIVE probe account login mismatch." }
  if (-not [string]::Equals(([string]$health.server).Trim(), $liveIdentity.server, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "LIVE probe server mismatch."
  }
  if ([bool]$health.tradingEnabled) { throw "LIVE probe bridge unexpectedly reports tradingEnabled=true." }
  if ([bool]$health.liveExecutionArmed) { throw "LIVE probe bridge unexpectedly reports LIVE ARMED." }
  if ([string]$health.liveArmStatus -ne "DISARMED") { throw "LIVE probe bridge must report liveArmStatus=DISARMED. Actual=$($health.liveArmStatus)" }

  $positionsRaw = Invoke-WebRequest -Uri "$base/v1/positions?symbol=XAUUSD" -Headers $headers -UseBasicParsing -TimeoutSec 5
  $ordersRaw = Invoke-WebRequest -Uri "$base/v1/orders?symbol=XAUUSD" -Headers $headers -UseBasicParsing -TimeoutSec 5
  $positionCount = Get-JsonArrayCount ([string]$positionsRaw.Content)
  $orderCount = Get-JsonArrayCount ([string]$ordersRaw.Content)
} catch {
  $probeError = $_
} finally {
  if ($null -ne $process) {
    try {
      $process.Refresh()
      if (-not $process.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if (-not $process.HasExited) { throw "Temporary LIVE read-only bridge process tree did not stop." }
      }
    } catch {
      $cleanupError = $_
    }
  }
  foreach ($path in @($probeEnvPath, $probeLedger, "$probeLedger-shm", "$probeLedger-wal")) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
  Clear-Phase7CLiveArmState -WorkDir $WorkDir -Reason "live-readonly-probe-complete"
}

if ($null -ne $probeError) { throw $probeError }
if ($null -ne $cleanupError) { throw $cleanupError }

# Prove the temporary probe did not replace/restart the selected DEMO bridge and
# did not alter the selected runtime or strategy mode.
$demoHealthAfter = Invoke-BridgeGet $demoBase "/health" $demoEnv
if (-not $demoHealthAfter.connected -or [string]$demoHealthAfter.accountMode -ne "demo") {
  throw "DEMO bridge is no longer healthy after LIVE read-only probe."
}
if ([string]$demoHealthAfter.bridgeSessionId -ne $demoSessionBefore) {
  throw "DEMO bridge session changed during LIVE read-only probe; refusing PASS."
}
if ([long]$demoHealthAfter.accountLogin -ne $demoLoginBefore) {
  throw "DEMO bridge account login changed during LIVE read-only probe; refusing PASS."
}
$accountStateAfter = Get-Content -LiteralPath $AccountStatePath -Raw | ConvertFrom-Json
if ((ConvertTo-Phase7CAccountMode ([string]$accountStateAfter.accountMode)) -ne "DEMO") {
  throw "Selected account mode changed during LIVE read-only probe."
}
$botAfter = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$botAfter.state.mode -ne "PAUSE") {
  throw "Bot mode changed during LIVE read-only probe."
}

Write-Host "PHASE7C_LIVE_READONLY_SELECTED_RUNTIME=DEMO"
Write-Host "PHASE7C_LIVE_READONLY_BOT_MODE=PAUSE"
Write-Host "PHASE7C_LIVE_READONLY_DEMO_SESSION_UNCHANGED=PASS"
Write-Host "PHASE7C_LIVE_READONLY_TERMINAL_SEPARATE=PASS"
Write-Host "PHASE7C_LIVE_READONLY_RISK_BINDING=PASS"
Write-Host "PHASE7C_LIVE_READONLY_ACCOUNT_MODE=$($health.accountMode)"
Write-Host "PHASE7C_LIVE_READONLY_CONFIGURED_MODE=$($health.configuredAccountMode)"
Write-Host "PHASE7C_LIVE_READONLY_ACCOUNT_LOGIN=$($health.accountLogin)"
Write-Host "PHASE7C_LIVE_READONLY_SERVER=$($health.server)"
Write-Host "PHASE7C_LIVE_READONLY_TRADING_ENABLED=$($health.tradingEnabled)"
Write-Host "PHASE7C_LIVE_READONLY_LIVE_ARM_STATUS=$($health.liveArmStatus)"
Write-Host "PHASE7C_LIVE_READONLY_LIVE_ARM_REASON=$($health.liveArmReason)"
Write-Host "PHASE7C_LIVE_READONLY_XAUUSD_POSITIONS=$positionCount"
Write-Host "PHASE7C_LIVE_READONLY_XAUUSD_PENDING_ORDERS=$orderCount"
Write-Host "PHASE7C_LIVE_READONLY_TREND_FIXED_LOT=$($liveRisk.profile.trendFixedLot)"
Write-Host "PHASE7C_LIVE_READONLY_SIDEWAY_RISK_PERCENT=$($liveRisk.profile.sidewayRiskPercent)"
Write-Host "PHASE7C_LIVE_READONLY_SIDEWAY_MAX_LOT=$($liveRisk.profile.sidewayMaxLot)"
Write-Host "PHASE7C_LIVE_READONLY_LIVE_ARM=DISARMED"
Write-Host "PHASE7C_LIVE_READONLY_STATUS=PASS"
