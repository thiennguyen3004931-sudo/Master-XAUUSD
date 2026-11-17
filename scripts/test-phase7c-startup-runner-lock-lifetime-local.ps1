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

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-lock-lifetime-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$lockPath = Join-Path $tempRoot 'startup-runner.lock'
$readyPath = Join-Path $tempRoot 'ready.txt'
$gcCompletePath = Join-Path $tempRoot 'gc-complete.txt'
$releaseAckPath = Join-Path $tempRoot 'release-ack.txt'
$childScript = Join-Path $tempRoot 'lock-owner.ps1'

$childSource = @'
param(
  [Parameter(Mandatory = $true)] [string]$GuardLibrary,
  [Parameter(Mandatory = $true)] [string]$LockPath,
  [Parameter(Mandatory = $true)] [string]$ReadyPath,
  [Parameter(Mandatory = $true)] [string]$GcCompletePath,
  [Parameter(Mandatory = $true)] [string]$ReleaseAckPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $GuardLibrary

$runnerLock = $null
try {
  $runnerLock = Open-Phase7CStartupRunnerLock -Path $LockPath
  [System.IO.File]::WriteAllText($ReadyPath, [string]$PID)

  # Stress managed lifetime without touching the FileStream. If the owner variable
  # is a sufficient root, the exclusive handle must remain held throughout.
  for ($i = 0; $i -lt 120; $i++) {
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    Start-Sleep -Milliseconds 50
  }

  # Handshake removes the old shutdown race: after GC_COMPLETE the child remains
  # alive and must continue owning the lock until the parent explicitly ACKs release.
  [System.IO.File]::WriteAllText($GcCompletePath, [string]$PID)
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ReleaseAckPath)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw 'Timed out waiting for parent release acknowledgement.'
    }
    Start-Sleep -Milliseconds 50
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
    '-ReadyPath', ('"{0}"' -f $readyPath),
    '-GcCompletePath', ('"{0}"' -f $gcCompletePath),
    '-ReleaseAckPath', ('"{0}"' -f $releaseAckPath)
  )
  $child = Start-Process -FilePath $hostExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden

  $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $readyPath)) {
    $child.Refresh()
    if ($child.HasExited) {
      throw "Lock-owner child exited before acquiring lock. ExitCode=$($child.ExitCode)"
    }
    if ([DateTime]::UtcNow -ge $readyDeadline) {
      throw 'Timed out waiting for lock-owner child readiness.'
    }
    Start-Sleep -Milliseconds 25
  }

  $ownerPid = [int](Get-Content -LiteralPath $readyPath -Raw)
  Assert-Equal $ownerPid $child.Id 'ready marker must identify the live lock-owner child'

  $samples = 0
  $gcDeadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $gcCompletePath)) {
    $child.Refresh()
    if ($child.HasExited) {
      throw "Lock-owner child exited before GC stress completed. ExitCode=$($child.ExitCode)"
    }
    if ([DateTime]::UtcNow -ge $gcDeadline) {
      throw 'Timed out waiting for GC stress completion.'
    }
    $state = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
    Assert-Equal $state 'HELD' "exclusive startup-runner lock escaped during GC stress; sample=$samples ownerPid=$ownerPid"
    $samples++
    Start-Sleep -Milliseconds 25
  }

  $child.Refresh()
  if ($child.HasExited) {
    throw 'Child must remain alive after GC_COMPLETE until explicit release ACK.'
  }
  $heldAfterGc = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
  Assert-Equal $heldAfterGc 'HELD' 'startup-runner lock must still be held after GC stress while owner awaits release ACK'

  [System.IO.File]::WriteAllText($releaseAckPath, 'release')
  if (-not $child.WaitForExit(10000)) {
    throw 'Lock-owner child did not exit after release acknowledgement.'
  }
  if ($child.ExitCode -ne 0) {
    throw "Lock-owner child failed. ExitCode=$($child.ExitCode)"
  }
  if ($samples -lt 20) {
    throw "Lock lifetime test did not observe enough live-owner samples. samples=$samples"
  }

  $releasedState = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
  Assert-Equal $releasedState 'RELEASED' 'startup-runner lock must become released after owner acknowledges shutdown and exits'

  Write-Host "PHASE7C_STARTUP_RUNNER_LOCK_LIFETIME_TEST=PASS"
  Write-Host "OWNER_PID=$ownerPid"
  Write-Host "HELD_SAMPLES=$samples"
  Write-Host "POST_GC_LOCK_STATE=$heldAfterGc"
  Write-Host "POST_EXIT_LOCK_STATE=$releasedState"
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (-not $child.HasExited) {
      try { [System.IO.File]::WriteAllText($releaseAckPath, 'cleanup') } catch { }
      try { $child.WaitForExit(2000) | Out-Null } catch { }
      $child.Refresh()
      if (-not $child.HasExited) {
        try { $child.Kill() } catch { }
      }
    }
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
