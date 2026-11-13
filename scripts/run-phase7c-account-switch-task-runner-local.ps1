param(
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "Account switch WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

$RequestPath = Join-Path $WorkDir "phase7c-account-switch-request.json"
$StatusPath = Join-Path $WorkDir "phase7c-account-switch-status.json"
$LockPath = Join-Path $WorkDir "phase7c-account-switch.lock"
$AccountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
$ArmPath = Join-Path $WorkDir "phase7c-live-arm.json"
$RuntimeDir = Join-Path $WorkDir "phase7c-executors"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$GuardedLiveSwitcher = Join-Path $PSScriptRoot "switch-phase7c-live-guarded-local.ps1"
$CanonicalSwitcher = Join-Path $PSScriptRoot "switch-phase7c-account-mode-local.ps1"
$DisarmLive = Join-Path $PSScriptRoot "disarm-phase7c-live-local.ps1"
$Verifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"

foreach ($required in @($AccountLibrary, $GuardedLiveSwitcher, $CanonicalSwitcher, $DisarmLive, $Verifier)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required account-switch component missing: $required" }
}
. $AccountLibrary

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Phase7C account-switch task runner requires Administrator privileges."
}

function Write-AtomicJson([string]$Path, $Value) {
  $tmp = "$Path.tmp.$PID"
  $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Write-SwitchStatus(
  [string]$RequestId,
  [string]$TargetMode,
  [string]$Status,
  [string]$Phase,
  [string]$Message,
  [long]$StartedAt,
  [Nullable[long]]$CompletedAt = $null,
  [string]$FinalAccountMode = "",
  [string]$FinalBotMode = ""
) {
  Write-AtomicJson $StatusPath ([ordered]@{
    version = 1
    requestId = $RequestId
    targetMode = $TargetMode
    status = $Status
    phase = $Phase
    message = $Message
    startedAt = $StartedAt
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    completedAt = $CompletedAt
    finalAccountMode = $FinalAccountMode
    finalBotMode = $FinalBotMode
    liveArmFilePresent = (Test-Path -LiteralPath $ArmPath)
  })
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Read-StateTicket($State) {
  if ($null -eq $State -or $null -eq $State.managed -or [string]::IsNullOrWhiteSpace([string]$State.managed.ticket)) { return "" }
  return [string]$State.managed.ticket
}

function Assert-FlatRuntimeState([string]$Mode) {
  if ($Mode -eq "LIVE") {
    $trendPath = Join-Path $WorkDir "phase7b-live-forward\phase7b-demo-state.json"
    $sidewayPath = Join-Path $WorkDir "phase7c-sideway-live-forward\phase7c-sideway-state.json"
  } else {
    $trendPath = Join-Path $WorkDir "phase7b-demo-forward\phase7b-demo-state.json"
    $sidewayPath = Join-Path $WorkDir "phase7c-sideway-forward\phase7c-sideway-state.json"
  }
  $trendState = Read-Json $trendPath
  $sidewayState = Read-Json $sidewayPath
  $trendTicket = Read-StateTicket $trendState
  $sidewayTicket = Read-StateTicket $sidewayState
  $trendPending = if ($null -ne $trendState) { $trendState.pendingPullback } else { $null }
  $sidewayPending = if ($null -ne $sidewayState) { $sidewayState.pendingEntry } else { $null }
  if ($trendTicket -or $sidewayTicket -or $null -ne $trendPending -or $null -ne $sidewayPending) {
    throw "Runtime is not flat: managed/pending strategy state exists."
  }
  if (Test-Path -LiteralPath (Join-Path $RuntimeDir "phase7c-execution.lock")) {
    throw "Runtime execution lock is present."
  }
}

function Get-BridgeArrayCount([string]$Uri, [hashtable]$Headers) {
  $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 5
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return 0 }
  $parsed = $raw | ConvertFrom-Json
  return @($parsed | Where-Object { $null -ne $_ }).Count
}

function Assert-FinalAccountState([string]$ExpectedMode) {
  $state = Read-Json $AccountStatePath
  if ($null -eq $state -or [string]$state.accountMode -ne $ExpectedMode) {
    throw "Final account-mode state mismatch. Expected=$ExpectedMode Actual=$($state.accountMode)"
  }
  $bot = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
  if ([string]$bot.state.mode -ne "PAUSE") {
    throw "Final bot mode must remain PAUSE. Actual=$($bot.state.mode)"
  }
  return [string]$bot.state.mode
}

$lockStream = $null
$request = $null
$requestId = "UNKNOWN"
$targetMode = "UNKNOWN"
$startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
  try {
    $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    throw "Another Phase7C account switch is already running."
  }

  $request = Read-Json $RequestPath
  if ($null -eq $request) { throw "Account switch request is missing or invalid." }
  if ([int]$request.version -ne 1) { throw "Account switch request version must be 1." }
  $requestId = [string]$request.requestId
  $targetMode = ([string]$request.targetMode).Trim().ToUpperInvariant()
  if ($requestId -notmatch '^[0-9a-fA-F-]{36}$') { throw "Account switch requestId is invalid." }
  if ($targetMode -notin @("DEMO", "LIVE")) { throw "Account switch targetMode must be DEMO or LIVE." }
  if ([string]$request.source -ne "LOCAL_WEB") { throw "Account switch request source is not allowed." }
  $expectedConfirmation = if ($targetMode -eq "LIVE") { "SWITCH_TO_LIVE" } else { "SWITCH_TO_DEMO" }
  if ([string]$request.confirmation -ne $expectedConfirmation) { throw "Account switch confirmation is invalid." }
  $createdAt = [long]$request.createdAt
  $ageMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $createdAt
  if ($createdAt -le 0 -or $ageMs -lt -10000 -or $ageMs -gt 60000) { throw "Account switch request expired or has invalid timestamp." }

  Write-SwitchStatus $requestId $targetMode "RUNNING" "PREFLIGHT" "Đang kiểm tra lại điều kiện an toàn." $startedAt

  $accountState = Read-Json $AccountStatePath
  if ($null -eq $accountState) { throw "Account-mode state is missing." }
  $currentMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
  if ($currentMode -eq $targetMode) { throw "Runtime is already selected on $targetMode." }

  $bot = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
  if ([string]$bot.state.mode -ne "PAUSE") { throw "Account switch requires bot PAUSE. Current=$($bot.state.mode)" }

  Assert-FlatRuntimeState $currentMode

  $envInfo = Assert-Phase7CAccountEnv -EnvFile ([string]$accountState.envFile) -AccountMode $currentMode -RequireTrading
  $headers = @{ "x-mt5-api-key" = $envInfo.apiKey }
  $bridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
  $health = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $headers -Method Get -TimeoutSec 5
  $expectedBrokerMode = if ($currentMode -eq "LIVE") { "real" } else { "demo" }
  if (-not [bool]$health.connected -or [string]$health.status -ne "ok" -or [string]$health.accountMode -ne $expectedBrokerMode) {
    throw "Current MT5 bridge does not match selected $currentMode runtime."
  }
  $positionCount = Get-BridgeArrayCount "$bridgeBase/v1/positions?symbol=XAUUSD" $headers
  $orderCount = Get-BridgeArrayCount "$bridgeBase/v1/orders?symbol=XAUUSD" $headers
  if ($positionCount -ne 0 -or $orderCount -ne 0) {
    throw "Account switch requires flat XAUUSD state. Positions=$positionCount PendingOrders=$orderCount"
  }
  if ($currentMode -eq "DEMO" -and (Test-Path -LiteralPath $ArmPath)) {
    throw "LIVE arm file must not exist while switching DEMO to LIVE."
  }

  Write-SwitchStatus $requestId $targetMode "RUNNING" "SWITCHING" "Preflight PASS; đang chạy account switch được bảo vệ." $startedAt

  if ($targetMode -eq "LIVE") {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $GuardedLiveSwitcher -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl -ConfirmLiveExecution
    if ($LASTEXITCODE -ne 0) { throw "Guarded DEMO-to-LIVE switch failed with exit code $LASTEXITCODE." }
    if (Test-Path -LiteralPath $ArmPath) { throw "LIVE switch completed with an unexpected arm file. Expected DISARMED." }
  } else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DisarmLive -WorkDir $WorkDir -Reason "web-account-switch-to-demo"
    if ($LASTEXITCODE -ne 0) { throw "LIVE disarm failed before DEMO switch." }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CanonicalSwitcher -TargetMode DEMO -WorkDir $WorkDir -ControlApiUrl $ControlApiUrl
    if ($LASTEXITCODE -ne 0) { throw "Canonical LIVE-to-DEMO switch failed with exit code $LASTEXITCODE." }
    if (Test-Path -LiteralPath $ArmPath) { throw "LIVE arm file still exists after switching to DEMO." }
  }

  Write-SwitchStatus $requestId $targetMode "RUNNING" "VERIFYING" "Đang strict verify runtime sau switch." $startedAt
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Verifier -WorkDir $WorkDir -ExpectedAccountMode $targetMode -RequireTelegram
  if ($LASTEXITCODE -ne 0) { throw "Strict $targetMode runtime verification failed after account switch." }

  $finalBotMode = Assert-FinalAccountState $targetMode
  if (Test-Path -LiteralPath $ArmPath) { throw "Final account switch state must be LIVE DISARMED or DEMO with no arm file." }
  $completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-SwitchStatus $requestId $targetMode "PASS" "COMPLETE" "Đã chuyển sang $targetMode; bot PAUSE và LIVE DISARMED." $startedAt $completedAt $targetMode $finalBotMode
  Write-Host "PHASE7C_WEB_ACCOUNT_SWITCH_STATUS=PASS"
  Write-Host "PHASE7C_WEB_ACCOUNT_SWITCH_TARGET=$targetMode"
  Write-Host "PHASE7C_WEB_ACCOUNT_SWITCH_BOT_MODE=PAUSE"
  Write-Host "PHASE7C_WEB_ACCOUNT_SWITCH_LIVE_ARM=DISARMED"
  exit 0
} catch {
  $completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $message = $_.Exception.Message
  try {
    $state = Read-Json $AccountStatePath
    $finalMode = if ($null -ne $state) { [string]$state.accountMode } else { "UNKNOWN" }
    $finalBot = "UNKNOWN"
    try {
      $bot = Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 3
      $finalBot = [string]$bot.state.mode
    } catch {}
    Write-SwitchStatus $requestId $targetMode "FAIL" "FAILED" $message $startedAt $completedAt $finalMode $finalBot
  } catch {}
  Write-Error $message
  exit 1
} finally {
  try { Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue } catch {}
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}