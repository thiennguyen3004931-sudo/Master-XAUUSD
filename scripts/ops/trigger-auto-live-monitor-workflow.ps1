param(
  [string]$Repository = 'thiennguyen3004931-sudo/xauusd-ai-master-core',
  [string]$Workflow = 'auto-live-event-monitor.yml',
  [string]$Ref = 'main',
  [int]$MinGapMinutes = 4,
  [switch]$Force,
  [string]$LogPath = (Join-Path $PSScriptRoot 'fallback-clock.log')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-ClockLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $line = '{0:o} {1}' -f (Get-Date).ToUniversalTime(), $Message
  Write-Host $line
  try {
    $directory = Split-Path -Parent $LogPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 5MB) {
      $archive = "$LogPath.1"
      if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
      }
      Move-Item -LiteralPath $LogPath -Destination $archive -Force
    }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    Write-Warning "CLOCK_LOG_WRITE_FAILED=$($_.Exception.Message)"
  }
}

function Invoke-Gh {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = @(& gh @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) {
    Write-ClockLog ([string]$line)
  }
  if ($exitCode -ne 0) {
    throw "GH_COMMAND_FAILED exit=$exitCode args=$($Arguments -join ' ')"
  }
  return $output
}

Write-ClockLog 'WINDOWS_FALLBACK_CLOCK_START=TRUE'
Write-ClockLog 'PRODUCTION_MUTATION=NONE'
Write-ClockLog 'PRODUCTION_HTTP_METHODS=NONE'
Write-ClockLog 'TRADING_LOGIC_MUTATION=NONE'
Write-ClockLog 'MODE_MUTATION=NONE'
Write-ClockLog 'ARM_MUTATION=NONE'
Write-ClockLog 'ORDER_MUTATION=NONE'
Write-ClockLog 'POSITION_MUTATION=NONE'

$runner = Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $runner) {
  Write-ClockLog 'FALLBACK_DISPATCH=SKIP_RUNNER_NOT_LISTENING'
  exit 0
}
Write-ClockLog "RUNNER_LISTENER_PID=$($runner.Id)"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GH_CLI_NOT_FOUND'
}

$authOutput = @(& gh auth status --hostname github.com 2>&1)
$authExit = $LASTEXITCODE
foreach ($line in $authOutput) {
  Write-ClockLog ([string]$line)
}
if ($authExit -ne 0) {
  throw 'GH_PERSISTENT_AUTH_NOT_READY'
}
Write-ClockLog 'GH_PERSISTENT_AUTH=PASS'

if (-not $Force) {
  $jsonLines = Invoke-Gh -Arguments @(
    'run', 'list',
    '--repo', $Repository,
    '--workflow', $Workflow,
    '--limit', '10',
    '--json', 'databaseId,status,event,createdAt,conclusion'
  )
  $json = ($jsonLines -join [Environment]::NewLine).Trim()
  $runs = @()
  if ($json) {
    $parsed = $json | ConvertFrom-Json
    if ($null -ne $parsed) {
      $runs = @($parsed)
    }
  }

  $active = @($runs | Where-Object { $_.status -in @('queued', 'in_progress', 'waiting', 'pending', 'requested') })
  if ($active.Count -gt 0) {
    Write-ClockLog "FALLBACK_DISPATCH=SKIP_ACTIVE_RUN count=$($active.Count)"
    exit 0
  }

  $latest = $runs |
    Where-Object { $_.createdAt } |
    Sort-Object { [DateTimeOffset]::Parse([string]$_.createdAt) } -Descending |
    Select-Object -First 1

  if ($latest) {
    $created = [DateTimeOffset]::Parse([string]$latest.createdAt)
    $age = [DateTimeOffset]::UtcNow - $created.ToUniversalTime()
    Write-ClockLog ("LATEST_MONITOR_RUN_ID={0} EVENT={1} STATUS={2} AGE_SECONDS={3:N0}" -f $latest.databaseId, $latest.event, $latest.status, $age.TotalSeconds)
    if ($age.TotalMinutes -lt $MinGapMinutes) {
      Write-ClockLog "FALLBACK_DISPATCH=SKIP_RECENT_RUN min_gap_minutes=$MinGapMinutes"
      exit 0
    }
  }
}

Invoke-Gh -Arguments @(
  'workflow', 'run', $Workflow,
  '--repo', $Repository,
  '--ref', $Ref,
  '-f', 'notify=true'
) | Out-Null

Write-ClockLog 'FALLBACK_DISPATCH=QUEUED'
Write-ClockLog 'MONITOR_NOTIFY=TRUE'
Write-ClockLog 'WINDOWS_FALLBACK_CLOCK_RESULT=PASS'
