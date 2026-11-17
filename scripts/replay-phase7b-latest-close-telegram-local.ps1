param(
  [string]$WorkDir = ".\.runtime",
  [string]$EnvFile = ".env.phase7b-telegram"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Notifier = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-compact.mjs"

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
  $WorkDir = Join-Path $ProjectRoot $WorkDir
}
$WorkDir = [System.IO.Path]::GetFullPath($WorkDir)

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) {
  $EnvFile = Join-Path $ProjectRoot $EnvFile
}
if (-not (Test-Path $EnvFile)) { throw "Telegram env file not found: $EnvFile" }
if (-not (Test-Path $Notifier)) { throw "Compact notifier not found: $Notifier" }

$demoDir = if ((Split-Path -Leaf $WorkDir) -eq "phase7b-demo-forward") {
  $WorkDir
} else {
  Join-Path $WorkDir "phase7b-demo-forward"
}
$journal = Join-Path $demoDir "phase7b-demo-events.jsonl"
if (-not (Test-Path $journal)) { throw "Phase7B journal not found: $journal" }

# Load Telegram credentials/settings exactly like the normal wrapper.
foreach ($raw in Get-Content $EnvFile) {
  $line = $raw.Trim()
  if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
  $index = $line.IndexOf("=")
  $name = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
  $value = $line.Substring($index + 1).Trim().Trim('"').Trim("'")
  [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}
if ([string]::IsNullOrWhiteSpace($env:ZIQ_TELEGRAM_BOT_TOKEN)) { throw "ZIQ_TELEGRAM_BOT_TOKEN is missing." }
if ([string]::IsNullOrWhiteSpace($env:ZIQ_TELEGRAM_CHAT_ID)) { throw "ZIQ_TELEGRAM_CHAT_ID is missing." }

# Locate only the most recent close event. Do not replay the whole journal.
$latestRaw = $null
$latestEvent = $null
$allLines = @(Get-Content $journal)
for ($i = $allLines.Count - 1; $i -ge 0; $i--) {
  $rawLine = $allLines[$i]
  if ([string]::IsNullOrWhiteSpace($rawLine)) { continue }
  try {
    $event = $rawLine | ConvertFrom-Json
  } catch {
    continue
  }
  $type = [string]$event.type
  if ($type -eq "EXIT_EXECUTED" -or $type -eq "MANAGED_POSITION_CLOSED") {
    $latestRaw = $rawLine
    $latestEvent = $event
    break
  }
}
if ($null -eq $latestEvent) { throw "No EXIT_EXECUTED or MANAGED_POSITION_CLOSED event found in journal." }

$replayDir = Join-Path $demoDir "telegram-one-shot-replay"
New-Item -ItemType Directory -Path $replayDir -Force | Out-Null
$tempJournal = Join-Path $replayDir "latest-close.jsonl"
$tempState = Join-Path $replayDir "latest-close-state.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tempJournal, ($latestRaw + "`n"), $utf8NoBom)
Remove-Item $tempState -Force -ErrorAction SilentlyContinue

$names = @(
  "ZIQ_TELEGRAM_JOURNAL_PATH",
  "ZIQ_TELEGRAM_STATE_PATH",
  "ZIQ_TELEGRAM_REPLAY_EXISTING",
  "ZIQ_TELEGRAM_SEND_STARTUP",
  "ZIQ_TELEGRAM_SYNC_OPEN_POSITION_ON_START",
  "ZIQ_TELEGRAM_ONCE",
  "ZIQ_TELEGRAM_SEND_TEST"
)
$previous = @{}
foreach ($name in $names) { $previous[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process") }

try {
  $env:ZIQ_TELEGRAM_JOURNAL_PATH = $tempJournal
  $env:ZIQ_TELEGRAM_STATE_PATH = $tempState
  $env:ZIQ_TELEGRAM_REPLAY_EXISTING = "true"
  $env:ZIQ_TELEGRAM_SEND_STARTUP = "false"
  $env:ZIQ_TELEGRAM_SYNC_OPEN_POSITION_ON_START = "false"
  $env:ZIQ_TELEGRAM_ONCE = "true"
  $env:ZIQ_TELEGRAM_SEND_TEST = "false"

  Write-Host "PHASE7B_TELEGRAM_REPLAY_EVENT_TYPE=$($latestEvent.type)"
  Write-Host "PHASE7B_TELEGRAM_REPLAY_EVENT_TIME=$($latestEvent.timestamp)"
  if ($latestEvent.ticket) { Write-Host "PHASE7B_TELEGRAM_REPLAY_TICKET=$($latestEvent.ticket)" }
  elseif ($latestEvent.lastKnownState -and $latestEvent.lastKnownState.ticket) { Write-Host "PHASE7B_TELEGRAM_REPLAY_TICKET=$($latestEvent.lastKnownState.ticket)" }

  $node = (Get-Command node -ErrorAction Stop).Source
  Push-Location $ProjectRoot
  try {
    & $node $Notifier
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($null -eq $exitCode) { $exitCode = 0 }
  if ([int]$exitCode -ne 0) { throw "Compact notifier replay exited with code $exitCode" }

  Write-Host "PHASE7B_TELEGRAM_REPLAY_SCOPE=LATEST_CLOSE_ONLY"
  Write-Host "PHASE7B_TELEGRAM_REPLAY_PERSISTENT_STATE_CHANGED=False"
  Write-Host "PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY"
  Write-Host "PHASE7B_TELEGRAM_REPLAY_LATEST_CLOSE=PASS"
}
finally {
  foreach ($name in $names) {
    [System.Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
  }
  Remove-Item $tempJournal -Force -ErrorAction SilentlyContinue
  Remove-Item $tempState -Force -ErrorAction SilentlyContinue
}
