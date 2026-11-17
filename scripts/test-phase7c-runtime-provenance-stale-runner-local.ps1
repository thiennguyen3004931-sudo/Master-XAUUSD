$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$ProbeLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$CanonicalRunner = Join-Path $PSScriptRoot 'run-phase7c-executor-task-runner-local.ps1'
foreach ($required in @($OwnershipLibrary, $ProbeLibrary, $CanonicalRunner)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required production source missing: $required"
  }
}
. $OwnershipLibrary
. $ProbeLibrary

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Stale-runner provenance regression requires Administrator on the CI host.'
}

Import-Module ScheduledTasks -ErrorAction Stop

$tempRoot = Join-Path $env:ProgramData ("phase7c-stale-runner-provenance-{0}" -f [Guid]::NewGuid().ToString('N'))
$tempScripts = Join-Path $tempRoot 'scripts'
$runtimeDir = Join-Path $tempRoot 'phase7c-executors'
$brokerStateDir = Join-Path $tempRoot 'phase7c-lifecycle-broker\state'
$resultDir = Join-Path $tempRoot 'results'
$staleRunner = Join-Path $tempScripts 'run-phase7c-executor-task-runner-local.ps1'
$statusPath = Join-Path $brokerStateDir 'status.json'
$heartbeatPath = Join-Path $brokerStateDir 'heartbeat.json'
$readyPath = Join-Path $resultDir 'stale-runner-ready.txt'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskName = "Phase7C-CI-StaleRunner-$([Guid]::NewGuid().ToString('N'))"

foreach ($directory in @($tempScripts, $runtimeDir, $brokerStateDir, $resultDir)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

# This fixture intentionally represents an older/non-canonical runner body that
# still lives at the exact canonical task-action path. It writes healthy broker
# ownership state but never acquires phase7c-executors\startup-runner.lock.
$staleSource = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $ProjectRoot 'phase7c-executors'
$brokerStateDir = Join-Path $ProjectRoot 'phase7c-lifecycle-broker\state'
$resultDir = Join-Path $ProjectRoot 'results'
$statusPath = Join-Path $brokerStateDir 'status.json'
$heartbeatPath = Join-Path $brokerStateDir 'heartbeat.json'
$readyPath = Join-Path $resultDir 'stale-runner-ready.txt'
foreach ($directory in @($runtimeDir, $brokerStateDir, $resultDir)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

function Write-StateFile([string]$Path, [hashtable]$Value) {
  $json = $Value | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

Write-StateFile -Path $statusPath -Value @{
  version = 1
  brokerPid = $PID
  state = 'RUNNING'
  staleRunnerFixture = $true
}
[System.IO.File]::WriteAllText($readyPath, "$PID", [System.Text.UTF8Encoding]::new($false))

while ($true) {
  Write-StateFile -Path $heartbeatPath -Value @{
    version = 1
    brokerPid = $PID
    state = 'RUNNING'
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    staleRunnerFixture = $true
  }
  Start-Sleep -Milliseconds 100
}
'@
[System.IO.File]::WriteAllText($staleRunner, $staleSource, [System.Text.UTF8Encoding]::new($false))

$canonicalHash = (Get-FileHash -LiteralPath $CanonicalRunner -Algorithm SHA256).Hash.ToUpperInvariant()
$staleHash = (Get-FileHash -LiteralPath $staleRunner -Algorithm SHA256).Hash.ToUpperInvariant()
if ($canonicalHash -eq $staleHash) {
  throw 'Fixture setup invalid: stale runner hash unexpectedly matches canonical runner hash.'
}

$registered = $false
$ownerPid = 0
try {
  # Persist the exact legacy/path-only action that previously reproduced the
  # incident mechanism. The new ownership contract must keep it identifiable as
  # ours for explicit repair, but it must never be canonical/start-eligible.
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $staleRunner
  $action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -ErrorAction Stop | Out-Null
  $registered = $true

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $ownership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $task.Actions `
    -ExpectedRunnerPath $staleRunner `
    -ExpectedRunnerSha256 $canonicalHash

  $startEligible = [bool]$ownership.owned -and [bool]$ownership.canonical -and (-not [bool]$ownership.repairRequired)
  if ([bool]$ownership.owned -and (-not [bool]$ownership.canonical) -and [bool]$ownership.repairRequired -and [string]$ownership.reason -eq 'OWNED_LEGACY_ACTION_REPAIR_REQUIRED') {
    Write-Host 'PHASE7C_STALE_RUNNER_PROVENANCE_TEST=PASS'
    Write-Host 'STALE_RUNNER_PROVENANCE_GAP=BLOCKED_BY_ACTION_REPAIR_REQUIRED'
    Write-Host 'TASK_ACTION_OWNED=TRUE'
    Write-Host 'TASK_ACTION_CANONICAL=FALSE'
    Write-Host 'TASK_ACTION_REPAIR_REQUIRED=TRUE'
    Write-Host 'TASK_ACTION_START_ELIGIBLE=FALSE'
    Write-Host "CANONICAL_RUNNER_SHA256=$canonicalHash"
    Write-Host "STALE_RUNNER_SHA256=$staleHash"
    return
  }

  if (-not [bool]$ownership.owned) {
    throw "Legacy Phase7C action is no longer safely identifiable for explicit repair. reason=$($ownership.reason)"
  }
  if (-not $startEligible) {
    throw "Legacy Phase7C action did not converge to the required repair classification. reason=$($ownership.reason) canonical=$($ownership.canonical) repairRequired=$($ownership.repairRequired)"
  }

  # If a regression ever makes the legacy action start-eligible again, continue
  # through the historical fixture and require the exact detector tuple to show
  # that the stale-source incident mechanism has reopened.
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $readyDeadline) {
      throw 'Timed out waiting for stale SYSTEM runner readiness.'
    }
    Start-Sleep -Milliseconds 50
  }

  $ownerPid = [int](([string](Get-Content -LiteralPath $readyPath -Raw)).Trim())
  if ($ownerPid -le 0 -or $null -eq (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
    throw "Stale runner process is not alive. PID=$ownerPid"
  }

  $snapshot = $null
  $snapshotDeadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    $snapshot = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $tempRoot -HeartbeatMaxAgeMs 5000
    if ([bool]$snapshot.brokerProcessAlive -and [bool]$snapshot.brokerHeartbeatFresh -and [bool]$snapshot.brokerStatusPidMatch) {
      break
    }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $snapshotDeadline)

  if (-not [bool]$snapshot.brokerProcessAlive) { throw 'Fixture broker process did not become alive in ownership snapshot.' }
  if (-not [bool]$snapshot.brokerHeartbeatFresh) { throw 'Fixture broker heartbeat did not become fresh.' }
  if (-not [bool]$snapshot.brokerStatusPidMatch) { throw 'Fixture broker status/heartbeat PID did not match.' }

  Write-Host "TASK_ACTION_OWNERSHIP=$($ownership.reason)"
  Write-Host "CANONICAL_RUNNER_SHA256=$canonicalHash"
  Write-Host "STALE_RUNNER_SHA256=$staleHash"
  Write-Host "BROKER_PROCESS_ALIVE=$($snapshot.brokerProcessAlive)"
  Write-Host "BROKER_HEARTBEAT_FRESH=$($snapshot.brokerHeartbeatFresh)"
  Write-Host "BROKER_STATUS_PID_MATCH=$($snapshot.brokerStatusPidMatch)"
  Write-Host "STARTUP_RUNNER_LOCK_STATE=$($snapshot.startupRunnerLockState)"
  Write-Host "EXACT_GENERATION_MISMATCH_GATE=$($snapshot.exactGenerationMismatchGate)"

  $exactReproduction =
    [bool]$ownership.owned -and
    $startEligible -and
    $canonicalHash -ne $staleHash -and
    [bool]$snapshot.brokerProcessAlive -and
    [bool]$snapshot.brokerHeartbeatFresh -and
    [bool]$snapshot.brokerStatusPidMatch -and
    [string]$snapshot.startupRunnerLockState -eq 'MISSING' -and
    [bool]$snapshot.exactGenerationMismatchGate

  if ($exactReproduction) {
    throw 'RED_REOPENED: stale runner path-only action became start-eligible again and reproduced alive+fresh+PID-match+startup-lock-MISSING exact generation mismatch.'
  }

  throw 'Legacy action became start-eligible without reproducing the expected historical detector tuple; provenance guard contract is unsafe or fixture behavior changed.'
} finally {
  if ($registered) {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    if ($ownerPid -gt 0) {
      $stopDeadline = [DateTime]::UtcNow.AddSeconds(8)
      while ($null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $stopDeadline) {
        Start-Sleep -Milliseconds 100
      }
    }
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
  try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
