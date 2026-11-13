param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$EnvFile = ".env.phase7b-telegram",
  [ValidateSet("DEMO", "LIVE")] [string]$AccountMode = "DEMO",
  [string]$RuntimeFile = "",
  [int]$IntervalSeconds = 2,
  [switch]$SendTest,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = (Resolve-Path $WorkDir).Path
$AccountMode = $AccountMode.ToUpperInvariant()
$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier.mjs"
$JobObjectHelper = Join-Path $PSScriptRoot "lib\phase7b-windows-job-object.ps1"
$IsWindowsHost = $env:OS -eq "Windows_NT"

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile = Join-Path $ProjectRoot $EnvFile
}
if (-not (Test-Path $EnvFile)) {
  throw "Telegram env file not found: $EnvFile"
}
if (-not (Test-Path $Notifier)) {
  throw "Telegram notifier not found: $Notifier"
}
if ($IsWindowsHost) {
  if (-not (Test-Path -LiteralPath $JobObjectHelper -PathType Leaf)) {
    throw "Windows Job Object helper not found: $JobObjectHelper"
  }
  . $JobObjectHelper
}

$trendDirName = if ($AccountMode -eq "LIVE") { "phase7b-live-forward" } else { "phase7b-demo-forward" }
$sidewayDirName = if ($AccountMode -eq "LIVE") { "phase7c-sideway-live-forward" } else { "phase7c-sideway-forward" }
$workLeaf = Split-Path -Leaf $WorkDir
$knownTrendDirs = @("phase7b-demo-forward", "phase7b-live-forward")

if ($knownTrendDirs -contains $workLeaf) {
  if ($workLeaf -ne $trendDirName) {
    throw "Trade notifier WorkDir/account mode mismatch. AccountMode=$AccountMode expects $trendDirName, got $workLeaf"
  }
  $trendDir = $WorkDir
  $runtimeRoot = Split-Path -Parent $WorkDir
} else {
  $runtimeRoot = $WorkDir
  $trendDir = Join-Path $runtimeRoot $trendDirName
}

$sidewayDir = Join-Path $runtimeRoot $sidewayDirName
New-Item -ItemType Directory -Path $trendDir -Force | Out-Null
New-Item -ItemType Directory -Path $sidewayDir -Force | Out-Null

# The Trend controller keeps its legacy canonical filename in both account modes;
# only the parent forward directory changes for LIVE versus DEMO.
$journal = Join-Path $trendDir "phase7b-demo-events.jsonl"
$sidewayJournal = Join-Path $sidewayDir "phase7c-sideway-events.jsonl"
$state = Join-Path $trendDir "phase7b-telegram-state.json"

if ([string]::IsNullOrWhiteSpace($RuntimeFile)) {
  $runtime = Join-Path $trendDir "phase7b-telegram-runtime.json"
} else {
  if (-not [System.IO.Path]::IsPathRooted($RuntimeFile)) {
    $RuntimeFile = Join-Path $runtimeRoot $RuntimeFile
  }
  $runtime = [System.IO.Path]::GetFullPath($RuntimeFile)
}
$runtimeParent = Split-Path -Parent $runtime
if (-not [string]::IsNullOrWhiteSpace($runtimeParent)) {
  New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
}

# Create empty journals if controllers have not emitted their first event yet.
# This guarantees both feeds are registered by the long-running notifier from startup.
foreach ($journalPath in @($journal, $sidewayJournal)) {
  if (-not (Test-Path -LiteralPath $journalPath)) {
    New-Item -ItemType File -Path $journalPath -Force | Out-Null
  }
}

function Read-TelegramRuntime {
  if (-not (Test-Path $runtime)) { return $null }
  try { return Get-Content $runtime -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-TelegramRuntimeAlive {
  param($Snapshot)
  if ($null -eq $Snapshot -or $Snapshot.status -ne "RUNNING" -or $null -eq $Snapshot.pid) { return $false }
  try {
    $heartbeatAge = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$Snapshot.heartbeatAt
    if ($heartbeatAge -gt 10000) { return $false }
    Get-Process -Id ([int]$Snapshot.pid) -ErrorAction Stop | Out-Null
    return $true
  } catch { return $false }
}

function Write-TelegramRuntime {
  param(
    [Parameter(Mandatory = $true)] [string]$Status,
    [int]$NodePid = 0,
    [int]$ExitCode = 0,
    [string]$StartedAt = ""
  )
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $payload = [ordered]@{
    version = 2
    status = $Status
    accountMode = $AccountMode
    pid = if ($NodePid -gt 0) { $NodePid } else { $null }
    wrapperPid = $PID
    startedAt = if ($StartedAt) { $StartedAt } else { $null }
    heartbeatAt = $now
    heartbeatAgeMs = 0
    intervalSeconds = [Math]::Max(1, $IntervalSeconds)
    trendJournal = $journal
    sidewayJournal = $sidewayJournal
    orderPermission = "NONE"
    sendTest = $SendTest.IsPresent
    once = $Once.IsPresent
    exitCode = if ($Status -eq "STOPPED") { $ExitCode } else { $null }
  }
  $temp = "$runtime.tmp"
  $payload | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $temp
  Move-Item -Force $temp $runtime
}

if (-not $SendTest -and -not $Once) {
  $existingRuntime = Read-TelegramRuntime
  if (Test-TelegramRuntimeAlive $existingRuntime) {
    Write-Host "PHASE7B_TELEGRAM_NOTIFIER=ALREADY_RUNNING"
    Write-Host "PHASE7B_TELEGRAM_EXISTING_PID=$($existingRuntime.pid)"
    return
  }
}

# On Windows, make the wrapper the owner of a kill-on-close Job Object before it
# spawns Node. The Node child inherits this job, so forced wrapper termination
# cannot leave an orphan notifier holding the singleton lock.
$runtimeJob = $null
if ($IsWindowsHost) {
  $runtimeJob = New-Phase7BKillOnCloseJob -Name ("Phase7B-Telegram-Notifier-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))
  Add-Phase7BProcessToJob -Job $runtimeJob -ProcessId $PID
  Write-Host "PHASE7B_TELEGRAM_JOB_OBJECT=ACTIVE"
}

foreach ($raw in Get-Content $EnvFile) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

if ([string]::IsNullOrWhiteSpace($env:ZIQ_TELEGRAM_BOT_TOKEN)) {
  throw "ZIQ_TELEGRAM_BOT_TOKEN is missing in $EnvFile"
}
if ([string]::IsNullOrWhiteSpace($env:ZIQ_TELEGRAM_CHAT_ID)) {
  throw "ZIQ_TELEGRAM_CHAT_ID is missing in $EnvFile"
}

$env:ZIQ_PHASE7C_ACCOUNT_MODE = $AccountMode
$env:ZIQ_TELEGRAM_JOURNAL_PATH = $journal
$env:ZIQ_TELEGRAM_SIDEWAY_JOURNAL_PATH = $sidewayJournal
$env:ZIQ_TELEGRAM_STATE_PATH = $state
$env:ZIQ_TELEGRAM_INTERVAL_MS = [string]([math]::Max(1, $IntervalSeconds) * 1000)
$env:ZIQ_TELEGRAM_SEND_TEST = if ($SendTest) { "true" } else { "false" }
$env:ZIQ_TELEGRAM_ONCE = if ($Once) { "true" } else { "false" }

Write-Host "PHASE7B_TELEGRAM_ENV=$EnvFile"
Write-Host "PHASE7B_TELEGRAM_ACCOUNT_MODE=$AccountMode"
Write-Host "PHASE7B_TELEGRAM_JOURNAL=$journal"
Write-Host "PHASE7B_TELEGRAM_SIDEWAY_JOURNAL=$sidewayJournal"
Write-Host "PHASE7B_TELEGRAM_SIDEWAY_JOURNAL_EXISTS=$(Test-Path -LiteralPath $sidewayJournal)"
Write-Host "PHASE7B_TELEGRAM_STATE=$state"
Write-Host "PHASE7B_TELEGRAM_RUNTIME=$runtime"
Write-Host "PHASE7B_TELEGRAM_INTERVAL_SECONDS=$IntervalSeconds"
Write-Host "PHASE7B_TELEGRAM_SEND_TEST=$($SendTest.IsPresent)"
Write-Host "PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL"

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeExe = $nodeCommand.Source
$startedAt = [DateTimeOffset]::UtcNow.ToString("o")

Push-Location $ProjectRoot
try {
  # One-shot/test mode intentionally runs Node synchronously. On Windows
  # PowerShell 5.1, Start-Process -PassThru can report HasExited while the
  # ExitCode property remains unavailable even after WaitForExit(). Native
  # invocation gives us the reliable process exit status through LASTEXITCODE.
  if ($SendTest -or $Once) {
    Write-Host "PHASE7B_TELEGRAM_NOTIFIER=RUNNING_ONESHOT"
    & $nodeExe $Notifier
    $nativeExitCode = $LASTEXITCODE
    if ($null -eq $nativeExitCode) { $nativeExitCode = 0 }
    $nativeExitCode = [int]$nativeExitCode
    Write-TelegramRuntime -Status "STOPPED" -NodePid 0 -ExitCode $nativeExitCode -StartedAt $startedAt
    if ($nativeExitCode -ne 0) {
      throw "Phase 7B Telegram notifier one-shot exited with code $nativeExitCode"
    }
    Write-Host "PHASE7B_TELEGRAM_WRAPPER_TEST_EXIT=PASS"
    return
  }

  $nodeProcess = Start-Process -FilePath $nodeExe -ArgumentList @($Notifier) -NoNewWindow -PassThru
  Write-TelegramRuntime -Status "RUNNING" -NodePid $nodeProcess.Id -StartedAt $startedAt
  Write-Host "PHASE7B_TELEGRAM_NOTIFIER=RUNNING"
  Write-Host "PHASE7B_TELEGRAM_PID=$($nodeProcess.Id)"

  while (-not $nodeProcess.HasExited) {
    Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds))
    $nodeProcess.Refresh()
    if (-not $nodeProcess.HasExited) {
      Write-TelegramRuntime -Status "RUNNING" -NodePid $nodeProcess.Id -StartedAt $startedAt
    }
  }

  # Persistent notifier should not normally exit. We do not depend on the
  # flaky Windows PowerShell ExitCode property here; any unexpected exit is
  # reported as a stopped notifier and the wrapper returns a clear failure.
  Write-TelegramRuntime -Status "STOPPED" -NodePid $nodeProcess.Id -ExitCode 1 -StartedAt $startedAt
  throw "Phase 7B persistent Telegram notifier stopped unexpectedly."
}
finally {
  Pop-Location
}
