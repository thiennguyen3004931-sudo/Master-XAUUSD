param(
  [string]$WorkDir = ".runtime",
  [string]$WebTask = "XAUUSD-Phase7B-Web",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$StartupTimeoutSeconds = 90,
  [switch]$SkipPanelInstall,
  [switch]$AllowOwnedTaskProvenanceMigration,
  [string]$ExpectedRunnerSha256 = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
  $WorkDir = Join-Path $ProjectRoot $WorkDir
}
if (-not (Test-Path -LiteralPath $WorkDir)) {
  throw "Phase7C dashboard deploy WorkDir not found: $WorkDir"
}
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

if ($ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw "ApiPort is invalid." }
if ($WebPort -lt 1024 -or $WebPort -gt 65535) { throw "WebPort is invalid." }
if ($ApiPort -eq $WebPort) { throw "ApiPort and WebPort must be different." }
if ($StartupTimeoutSeconds -lt 30 -or $StartupTimeoutSeconds -gt 300) {
  throw "StartupTimeoutSeconds must be between 30 and 300."
}
if ($AllowOwnedTaskProvenanceMigration) {
  if ($ExpectedRunnerSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Owned task provenance migration dashboard deploy requires an exact 64-character ExpectedRunnerSha256."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($ExpectedRunnerSha256)) {
  throw "ExpectedRunnerSha256 is only valid with AllowOwnedTaskProvenanceMigration."
}

$ApiBase = "http://127.0.0.1:$ApiPort"
$UiUrl = "$ApiBase/api/v1/phase7c-ui/mt5?symbol=XAUUSD"
$ModeUrl = "$ApiBase/api/v1/phase7c/bot-mode"
$PidDir = Join-Path $WorkDir "phase7c-executors"
$ArmPath = Join-Path $WorkDir "phase7c-live-arm.json"
$TelegramStatusPath = Join-Path $PidDir "telegram-mode-status.json"
$Installer = Join-Path $PSScriptRoot "install-phase7c-mt5-decision-panel-local.ps1"
$AccountVerifier = Join-Path $PSScriptRoot "verify-phase7c-account-runtime-local.ps1"

if (-not (Test-Path -LiteralPath $Installer)) { throw "MT5 panel installer missing: $Installer" }
if (-not (Test-Path -LiteralPath $AccountVerifier)) { throw "Phase7C account verifier missing: $AccountVerifier" }

function Read-AlivePid([string]$Name) {
  $pidFile = Join-Path $PidDir "$Name.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) {
    throw "Missing executor PID file: $pidFile"
  }
  $processId = 0
  $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if (-not [int]::TryParse($raw, [ref]$processId) -or $processId -le 0) {
    throw "Invalid executor PID file: $pidFile"
  }
  if ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    throw "Executor is not alive: $Name PID=$processId"
  }
  return $processId
}

function Read-UiAccountMode([string]$Content) {
  $match = [regex]::Match($Content, '(?m)^accountMode=(DEMO|LIVE)$')
  if (-not $match.Success) { return "" }
  return $match.Groups[1].Value
}

function Test-ProjectCoreCommand([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $hasProjectPath = $CommandLine.IndexOf(
    $ProjectRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -ge 0
  $hasRuntimeMarker = $CommandLine -match '(?i)(run-phase7b-(web-autostart|api-runtime-local)\.ps1|phase7b-(api|web)-background-v\d+\.ps1|node_modules[\\/].*(vite|tsx))'
  $hasWorkspaceFilter = $CommandLine -match '(?i)--filter\s+["'']?@xauusd/(api|web)["'']?'
  return ($hasProjectPath -and $hasRuntimeMarker) -or $hasWorkspaceFilter
}

function Test-DescendantOfRoot(
  [int]$ProcessId,
  [int]$RootProcessId,
  [hashtable]$ProcessTable
) {
  $cursor = $ProcessId
  for ($depth = 0; $depth -lt 32; $depth++) {
    if ($cursor -eq $RootProcessId) { return $true }
    if (-not $ProcessTable.ContainsKey($cursor)) { break }
    $parentProcessId = [int]$ProcessTable[$cursor].ParentProcessId
    if ($parentProcessId -le 0) { break }
    $cursor = $parentProcessId
  }
  return $false
}

function Get-VerifiedCoreRoots([int[]]$Ports, [int[]]$ProtectedProcessIds) {
  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byPid = @{}
  foreach ($process in $snapshot) {
    $byPid[[int]$process.ProcessId] = $process
  }

  $listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $Ports -contains [int]$_.LocalPort }
  )

  $roots = @()
  foreach ($listener in $listeners) {
    $cursor = [int]$listener.OwningProcess
    $rootProcessId = 0

    for ($depth = 0; $depth -lt 16; $depth++) {
      if (-not $byPid.ContainsKey($cursor)) { break }
      $commandLine = [string]$byPid[$cursor].CommandLine
      if (Test-ProjectCoreCommand $commandLine) {
        $rootProcessId = $cursor
      }
      $parentProcessId = [int]$byPid[$cursor].ParentProcessId
      if ($parentProcessId -le 0) { break }
      $cursor = $parentProcessId
    }

    if ($rootProcessId -le 0) {
      throw "Unrecognized owner for localhost port $($listener.LocalPort), PID=$($listener.OwningProcess). No process was killed."
    }

    foreach ($protectedProcessId in $ProtectedProcessIds) {
      if (Test-DescendantOfRoot -ProcessId $protectedProcessId -RootProcessId $rootProcessId -ProcessTable $byPid) {
        throw "Safety block: core root PID=$rootProcessId contains protected executor PID=$protectedProcessId."
      }
    }

    $rootCommand = [string]$byPid[$rootProcessId].CommandLine
    if ($rootCommand -match '(?i)run-phase7c-executors|trend-executor|sideway-executor') {
      throw "Safety block: executor marker detected in core root PID=$rootProcessId."
    }

    Write-Host "PHASE7C_DASHBOARD_DEPLOY_VERIFIED_CORE_ROOT=PORT=$($listener.LocalPort)|PID=$rootProcessId"
    $roots += $rootProcessId
  }

  return @($roots | Sort-Object -Unique)
}

function Stop-VerifiedProcessTrees([int[]]$ProcessIds) {
  if ($ProcessIds.Count -eq 0) { return }
  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  foreach ($processId in $ProcessIds) {
    Write-Host "PHASE7C_DASHBOARD_DEPLOY_CORE_TREE_STOP=PID=$processId"
    & $taskkill /PID $processId /T /F 2>$null | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      throw "Could not stop verified dashboard core tree PID=$processId. ExitCode=$exitCode"
    }
  }
}

function Wait-PortsReleased([int[]]$Ports) {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $remaining = @(
      Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $Ports -contains [int]$_.LocalPort }
    )
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
  $detail = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $Ports -contains [int]$_.LocalPort } |
      ForEach-Object { "PORT=$($_.LocalPort)|PID=$($_.OwningProcess)" }
  )
  throw "Dashboard core ports are still occupied after verified cleanup. Remaining=$($detail -join ',')"
}

function Wait-DashboardV2([string]$ExpectedAccountMode) {
  if ($ExpectedAccountMode -notin @("DEMO", "LIVE")) {
    throw "ExpectedAccountMode must be DEMO or LIVE."
  }
  $escapedMode = [regex]::Escape($ExpectedAccountMode)
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $probe = Invoke-WebRequest -Uri $UiUrl -UseBasicParsing -TimeoutSec 5
      $content = [string]$probe.Content
      if (
        $probe.StatusCode -eq 200 -and
        $content -match '(?m)^version=2$' -and
        $content -match "(?m)^accountMode=$escapedMode$" -and
        $content -match '(?m)^mt5Connected=true$' -and
        $content -match '(?m)^accountGuardValid=true$' -and
        $content -match '(?m)^trendOn=' -and
        $content -match '(?m)^sidewayOn=' -and
        $content -match '(?m)^autoReason1=' -and
        $content -match '(?m)^trendWaitReason1=' -and
        $content -match '(?m)^sidewayWaitReason1=' -and
        $content -match '(?m)^entryReason1=' -and
        $content -match '(?m)^holdReason1=' -and
        $content -match '(?m)^stopMoveReason1=' -and
        $content -match '(?m)^partialReason1=' -and
        $content -match '(?m)^exitReason1=' -and
        $content -match '(?m)^readOnly=true$' -and
        $content -match '(?m)^mt5OrderPermission=NONE$'
      ) {
        return $content
      }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "Phase7C dashboard v2 did not become ready for $ExpectedAccountMode within $StartupTimeoutSeconds seconds."
}

function Wait-TelegramRecoveryAfterApiRestart([int]$TimeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastStatus = "MISSING"
  $lastAge = "UNKNOWN"
  Write-Host "PHASE7C_DASHBOARD_DEPLOY_TELEGRAM_RECOVERY_WAIT=START|TIMEOUT_SECONDS=$TimeoutSeconds"
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $TelegramStatusPath) {
      try {
        $telegram = Get-Content -LiteralPath $TelegramStatusPath -Raw | ConvertFrom-Json
        $lastStatus = [string]$telegram.status
        $lastSuccessAt = $telegram.lastTelegramSuccessAt
        if ($null -ne $lastSuccessAt -and [long]$lastSuccessAt -gt 0) {
          $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$lastSuccessAt
          $lastAge = [string]$age
          if (
            [bool]$telegram.ready -and
            $lastStatus -eq "READY" -and
            $age -ge -10000 -and
            $age -le 60000
          ) {
            Write-Host "PHASE7C_DASHBOARD_DEPLOY_TELEGRAM_RECOVERY_WAIT=PASS|STATUS=$lastStatus|HEARTBEAT_AGE_MS=$age"
            return $true
          }
        }
      } catch {
        $lastStatus = "INVALID_STATUS_FILE"
        $lastAge = "UNKNOWN"
      }
    }
    Start-Sleep -Seconds 2
  }
  Write-Host "PHASE7C_DASHBOARD_DEPLOY_TELEGRAM_RECOVERY_WAIT=TIMEOUT|STATUS=$lastStatus|HEARTBEAT_AGE_MS=$lastAge"
  return $false
}

Write-Host "PHASE7C_DASHBOARD_DEPLOY=START"

$task = Get-ScheduledTask -TaskName $WebTask -ErrorAction Stop
Write-Host "PHASE7C_DASHBOARD_DEPLOY_WEB_TASK=$WebTask"
Write-Host "PHASE7C_DASHBOARD_DEPLOY_WEB_TASK_STATE=$($task.State)"

$supervisorPid = Read-AlivePid "supervisor"
$trendPid = Read-AlivePid "trend"
$sidewayPid = Read-AlivePid "sideway"
$protectedPids = @($supervisorPid, $trendPid, $sidewayPid)
Write-Host "PHASE7C_DASHBOARD_DEPLOY_SUPERVISOR_PID=$supervisorPid"
Write-Host "PHASE7C_DASHBOARD_DEPLOY_TREND_PID=$trendPid"
Write-Host "PHASE7C_DASHBOARD_DEPLOY_SIDEWAY_PID=$sidewayPid"

$modeBefore = Invoke-RestMethod -Uri $ModeUrl -Method Get -TimeoutSec 5
$preservedMode = [string]$modeBefore.state.mode
if ([string]::IsNullOrWhiteSpace($preservedMode)) {
  throw "Could not read Phase7C mode before dashboard deploy."
}
Write-Host "PHASE7C_DASHBOARD_DEPLOY_MODE_BEFORE=$preservedMode"

$preflight = Invoke-WebRequest -Uri $UiUrl -UseBasicParsing -TimeoutSec 8
$preflightContent = [string]$preflight.Content
$expectedAccountMode = Read-UiAccountMode $preflightContent
if (
  $preflight.StatusCode -ne 200 -or
  $expectedAccountMode -notin @("DEMO", "LIVE") -or
  $preflightContent -notmatch '(?m)^mt5OrderPermission=NONE$'
) {
  throw "Dashboard deploy preflight requires a verified DEMO/LIVE account and MT5 order permission NONE."
}
$armFileBefore = Test-Path -LiteralPath $ArmPath
Write-Host "PHASE7C_DASHBOARD_DEPLOY_ACCOUNT_MODE=$expectedAccountMode"
Write-Host "PHASE7C_DASHBOARD_DEPLOY_LIVE_ARM_FILE_BEFORE=$armFileBefore"
Write-Host "PHASE7C_DASHBOARD_DEPLOY_PREFLIGHT=PASS"

if ($task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $WebTask -ErrorAction Stop
  Start-Sleep -Seconds 1
}

$ports = @($ApiPort, $WebPort)
$roots = Get-VerifiedCoreRoots -Ports $ports -ProtectedProcessIds $protectedPids
Write-Host "PHASE7C_DASHBOARD_DEPLOY_EXECUTOR_TREE_ISOLATION=PASS"
Stop-VerifiedProcessTrees -ProcessIds $roots
Wait-PortsReleased -Ports $ports
Write-Host "PHASE7C_DASHBOARD_DEPLOY_PORT_RELEASE=PASS"

$task = Get-ScheduledTask -TaskName $WebTask -ErrorAction Stop
if ($task.State -eq "Disabled") {
  Enable-ScheduledTask -TaskName $WebTask -ErrorAction Stop | Out-Null
}
Start-ScheduledTask -TaskName $WebTask -ErrorAction Stop
Write-Host "PHASE7C_DASHBOARD_DEPLOY_WEB_TASK_START=PASS"

$uiPayload = Wait-DashboardV2 -ExpectedAccountMode $expectedAccountMode
Write-Host "PHASE7C_DASHBOARD_DEPLOY_UI_V2=PASS"

$modeAfter = Invoke-RestMethod -Uri $ModeUrl -Method Get -TimeoutSec 5
if ([string]$modeAfter.state.mode -ne $preservedMode) {
  throw "Phase7C mode changed during dashboard deploy. Before=$preservedMode After=$($modeAfter.state.mode)"
}
Write-Host "PHASE7C_DASHBOARD_DEPLOY_MODE_PRESERVED=$preservedMode"

$afterSupervisorPid = Read-AlivePid "supervisor"
$afterTrendPid = Read-AlivePid "trend"
$afterSidewayPid = Read-AlivePid "sideway"
if ($afterSupervisorPid -ne $supervisorPid -or $afterTrendPid -ne $trendPid -or $afterSidewayPid -ne $sidewayPid) {
  throw "Executor PID changed during dashboard deploy."
}
Write-Host "PHASE7C_DASHBOARD_DEPLOY_EXECUTORS_UNCHANGED=PASS"

$armFileAfter = Test-Path -LiteralPath $ArmPath
if ($armFileAfter -ne $armFileBefore) {
  throw "LIVE arm file presence changed during dashboard deploy. Before=$armFileBefore After=$armFileAfter"
}
Write-Host "PHASE7C_DASHBOARD_DEPLOY_LIVE_ARM_FILE_PRESERVED=$armFileAfter"

if (-not $SkipPanelInstall) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Installer
  if ($LASTEXITCODE -ne 0) { throw "MT5 dashboard panel installer failed with exit code $LASTEXITCODE" }
  Write-Host "PHASE7C_DASHBOARD_DEPLOY_PANEL_INSTALL=PASS"
} else {
  Write-Host "PHASE7C_DASHBOARD_DEPLOY_PANEL_INSTALL=SKIPPED"
}

# Restarting Control API 3711 can briefly put the independent Telegram controller
# into DEGRADED_RETRYING while it reconnects. Wait for that same process to recover,
# then keep the existing strict -RequireTelegram verification. This does not restart
# Telegram, executors, bridge, switch account mode, or mutate LIVE arm state.
[void](Wait-TelegramRecoveryAfterApiRestart -TimeoutSeconds 45)

$accountVerifierArgs = @()
if ($AllowOwnedTaskProvenanceMigration) {
  $accountVerifierArgs += @(
    '-AllowOwnedTaskProvenanceMigration',
    '-ExpectedRunnerSha256', $ExpectedRunnerSha256
  )
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $AccountVerifier `
  -WorkDir $WorkDir `
  -ExpectedAccountMode $expectedAccountMode `
  -RequireTelegram `
  @accountVerifierArgs
if ($LASTEXITCODE -ne 0) {
  throw "Phase7C strict $expectedAccountMode account verifier failed after dashboard deploy."
}
Write-Host "PHASE7C_DASHBOARD_DEPLOY_ACCOUNT_VERIFY=PASS|MODE=$expectedAccountMode"

Write-Host "PHASE7C_DASHBOARD_DEPLOY_STATUS=PASS"