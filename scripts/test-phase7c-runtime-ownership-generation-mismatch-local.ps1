param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_GENERATION_MISMATCH=SKIP_NON_WINDOWS'
  exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$probeLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$guardLibrary = Join-Path $PSScriptRoot 'lib\phase7c-startup-runner-guard.ps1'

if (-not (Test-Path -LiteralPath $probeLibrary)) {
  throw "RED: runtime ownership probe library is missing: $probeLibrary"
}
if (-not (Test-Path -LiteralPath $guardLibrary)) {
  throw "Startup runner guard library is missing: $guardLibrary"
}

. $probeLibrary
. $guardLibrary

function Assert-Equal($Expected, $Actual, [string]$Label) {
  if ($Expected -ne $Actual) {
    throw "$Label expected '$Expected' but got '$Actual'."
  }
}

function Assert-True([bool]$Value, [string]$Label) {
  if (-not $Value) { throw "$Label expected TRUE." }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-runtime-ownership-{0}" -f [Guid]::NewGuid().ToString('N'))
$heldHandle = $null
try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  $missingLock = Join-Path $tempRoot 'missing\startup-runner.lock'
  Assert-Equal 'MISSING' (Get-Phase7CReadOnlyLockState -Path $missingLock) 'missing lock state'

  $releasedDir = Join-Path $tempRoot 'released'
  New-Item -ItemType Directory -Force -Path $releasedDir | Out-Null
  $releasedLock = Join-Path $releasedDir 'startup-runner.lock'
  [System.IO.File]::WriteAllText($releasedLock, '{"version":1,"runnerPid":0}')
  Assert-Equal 'RELEASED' (Get-Phase7CReadOnlyLockState -Path $releasedLock) 'released lock state'

  $heldDir = Join-Path $tempRoot 'held'
  New-Item -ItemType Directory -Force -Path $heldDir | Out-Null
  $heldLock = Join-Path $heldDir 'startup-runner.lock'
  $heldHandle = Open-Phase7CStartupRunnerLock -Path $heldLock
  Assert-Equal 'HELD' (Get-Phase7CReadOnlyLockState -Path $heldLock) 'held lock state'
  $heldHandle.Dispose()
  $heldHandle = $null

  # Exact diagnostic fixture for the incident gate: broker heartbeat/status identify
  # one fresh live PID, while the lock path belonging to the inspected WorkDir is
  # missing. This is intentionally synthetic and must never mutate LIVE runtime.
  $workDir = Join-Path $tempRoot 'generation-b'
  $runtimeDir = Join-Path $workDir 'phase7c-executors'
  $brokerStateDir = Join-Path $workDir 'phase7c-lifecycle-broker\state'
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  New-Item -ItemType Directory -Force -Path $brokerStateDir | Out-Null

  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $status = [pscustomobject]@{
    version = 1
    state = 'RUNNING'
    brokerPid = $PID
    supervisorPid = $null
    accountMode = 'LIVE'
    updatedAt = $nowMs
  }
  $heartbeat = [pscustomobject]@{
    version = 1
    brokerPid = $PID
    state = 'RUNNING'
    desiredExecutorState = 'STOPPED'
    updatedAt = $nowMs
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $brokerStateDir 'status.json'),
    ($status | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    (Join-Path $brokerStateDir 'heartbeat.json'),
    ($heartbeat | ConvertTo-Json -Depth 4),
    [System.Text.UTF8Encoding]::new($false)
  )

  $snapshot = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $workDir -HeartbeatMaxAgeMs 5000
  Assert-True ([bool]$snapshot.brokerProcessAlive) 'BROKER_PROCESS_ALIVE'
  Assert-True ([bool]$snapshot.brokerHeartbeatFresh) 'BROKER_HEARTBEAT_FRESH'
  Assert-True ([bool]$snapshot.brokerStatusPidMatch) 'BROKER_STATUS_PID_MATCH'
  Assert-Equal 'MISSING' ([string]$snapshot.startupRunnerLockState) 'STARTUP_RUNNER_LOCK_STATE'
  Assert-True ([bool]$snapshot.exactGenerationMismatchGate) 'EXACT_GENERATION_MISMATCH_GATE'

  Write-Host 'BROKER_PROCESS_ALIVE=TRUE'
  Write-Host 'BROKER_HEARTBEAT_FRESH=TRUE'
  Write-Host 'BROKER_STATUS_PID_MATCH=TRUE'
  Write-Host 'STARTUP_RUNNER_LOCK_STATE=MISSING'
  Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_GENERATION_MISMATCH=PASS'
} finally {
  if ($null -ne $heldHandle) {
    try { $heldHandle.Dispose() } catch { }
  }
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
