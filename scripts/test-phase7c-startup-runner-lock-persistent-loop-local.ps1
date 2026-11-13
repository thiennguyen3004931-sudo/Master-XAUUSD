$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$GuardLibrary = Join-Path $PSScriptRoot 'lib\phase7c-startup-runner-guard.ps1'
$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
foreach ($required in @($GuardLibrary, $OwnershipLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required production source missing: $required"
  }
}
. $OwnershipLibrary

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "$Message actual=$Actual expected=$Expected"
  }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-lock-persistent-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$lockPath = Join-Path $tempRoot 'startup-runner.lock'
$readyPath = Join-Path $tempRoot 'ready.txt'
$childScript = Join-Path $tempRoot 'persistent-owner.ps1'

$childSource = @'
param(
  [Parameter(Mandatory = $true)] [string]$GuardLibrary,
  [Parameter(Mandatory = $true)] [string]$LockPath,
  [Parameter(Mandatory = $true)] [string]$ReadyPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $GuardLibrary

$runnerLock = $null
try {
  $runnerLock = Open-Phase7CStartupRunnerLock -Path $LockPath
  [System.IO.File]::WriteAllText($ReadyPath, [string]$PID)

  # Production-shaped liveness: after acquisition the persistent runner never
  # touches $runnerLock inside its infinite broker loop. Force GC/finalization
  # while that shape is active so premature FileStream release is observable.
  while ($true) {
    $pressure = New-Object byte[] 262144
    $pressure[0] = 1
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    Start-Sleep -Milliseconds 25
  }
} finally {
  if ($null -ne $runnerLock) { $runnerLock.Dispose() }
}
'@
[System.IO.File]::WriteAllText($childScript, $childSource, [System.Text.UTF8Encoding]::new($false))

$hostExecutable = (Get-Process -Id $PID -ErrorAction Stop).Path
$child = $null
try {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $childScript),
    '-GuardLibrary', ('"{0}"' -f $GuardLibrary),
    '-LockPath', ('"{0}"' -f $lockPath),
    '-ReadyPath', ('"{0}"' -f $readyPath)
  )
  $child = Start-Process -FilePath $hostExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $readyPath)) {
    $child.Refresh()
    if ($child.HasExited) {
      throw "Persistent lock-owner exited before readiness. ExitCode=$($child.ExitCode)"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw 'Timed out waiting for persistent lock-owner readiness.'
    }
    Start-Sleep -Milliseconds 25
  }

  $ownerPid = [int](Get-Content -LiteralPath $readyPath -Raw)
  Assert-Equal $ownerPid $child.Id 'ready marker must identify persistent lock-owner child'

  $samples = 0
  for ($i = 0; $i -lt 400; $i++) {
    $child.Refresh()
    if ($child.HasExited) {
      throw "Persistent lock-owner exited unexpectedly. sample=$i ExitCode=$($child.ExitCode)"
    }
    $state = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
    Assert-Equal $state 'HELD' "persistent infinite-loop owner lost exclusive startup-runner lock; sample=$i ownerPid=$ownerPid"
    $samples++
    Start-Sleep -Milliseconds 25
  }

  Write-Host 'PHASE7C_STARTUP_RUNNER_LOCK_PERSISTENT_LOOP_TEST=PASS'
  Write-Host "OWNER_PID=$ownerPid"
  Write-Host "HELD_SAMPLES=$samples"
  Write-Host 'PERSISTENT_LOOP_LOCK_STATE=HELD'
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (-not $child.HasExited) {
      try { $child.Kill() } catch { }
      try { $child.WaitForExit(5000) | Out-Null } catch { }
    }
  }

  $releaseDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ((Get-Phase7CStartupRunnerLockState -LockPath $lockPath) -eq 'HELD' -and [DateTime]::UtcNow -lt $releaseDeadline) {
    Start-Sleep -Milliseconds 50
  }
  $postExitState = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
  if ($postExitState -eq 'HELD') {
    throw 'startup-runner lock remained held after persistent owner process terminated.'
  }
  Write-Host "POST_EXIT_LOCK_STATE=$postExitState"
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
