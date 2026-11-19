$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$GuardLibrary = Join-Path $PSScriptRoot 'lib\phase7c-startup-runner-guard.ps1'
if (-not (Test-Path -LiteralPath $GuardLibrary -PathType Leaf)) {
  throw "Required production source missing: $GuardLibrary"
}
. $GuardLibrary

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-DeepestException($Exception) {
  $current = $Exception
  while ($null -ne $current -and $null -ne $current.InnerException) {
    $current = $current.InnerException
  }
  return $current
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-json-atomic-sharing-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$targetPath = Join-Path $tempRoot 'heartbeat.json'
$readyPath = Join-Path $tempRoot 'reader-ready.txt'
$childScript = Join-Path $tempRoot 'hold-reader.ps1'

$initial = [pscustomobject]@{
  version = 1
  brokerPid = 17668
  state = 'IDLE'
  desiredExecutorState = 'STOPPED'
  updatedAt = 1
}
Write-Phase7CJsonAtomic -Path $targetPath -Value $initial -Depth 4

$childSource = @'
param(
  [Parameter(Mandatory = $true)] [string]$TargetPath,
  [Parameter(Mandatory = $true)] [string]$ReadyPath,
  [int]$HoldMilliseconds = 300
)
$ErrorActionPreference = 'Stop'
$stream = $null
try {
  # Production-shaped observer: readable concurrently, but no delete sharing.
  # File.Replace on Windows must fail with sharing/lock violation while this
  # handle is open, matching the LIVE broker failure captured on 2026-09-06.
  $stream = [System.IO.File]::Open(
    $TargetPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  [System.IO.File]::WriteAllText($ReadyPath, [string]$PID)
  Start-Sleep -Milliseconds $HoldMilliseconds
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
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
    '-TargetPath', ('"{0}"' -f $targetPath),
    '-ReadyPath', ('"{0}"' -f $readyPath),
    '-HoldMilliseconds', '300'
  )
  $child = Start-Process -FilePath $hostExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden

  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    $child.Refresh()
    if ($child.HasExited) {
      throw "Reader exited before acquiring target handle. ExitCode=$($child.ExitCode)"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      throw 'Timed out waiting for reader to acquire target handle.'
    }
    Start-Sleep -Milliseconds 10
  }

  $readerPid = [int](Get-Content -LiteralPath $readyPath -Raw)
  Assert-True ($readerPid -eq $child.Id) 'Reader readiness marker must identify the lock-holding process.'

  $next = [pscustomobject]@{
    version = 1
    brokerPid = 17668
    state = 'IDLE'
    desiredExecutorState = 'STOPPED'
    updatedAt = 2
  }

  $writeError = $null
  try {
    Write-Phase7CJsonAtomic -Path $targetPath -Value $next -Depth 4
  } catch {
    $writeError = $_
  }

  if ($null -ne $writeError) {
    $deepest = Get-DeepestException -Exception $writeError.Exception
    $nativeCode = if ($null -ne $deepest) { $deepest.HResult -band 0xFFFF } else { -1 }
    $isIo = $null -ne $deepest -and $deepest -is [System.IO.IOException]
    $isSharingViolation = $nativeCode -in @(32, 33)
    Assert-True $isIo "Atomic writer failed with a non-IOException. error=$($writeError.Exception.Message)"
    Assert-True $isSharingViolation "Atomic writer failed with an unexpected IOException. nativeCode=$nativeCode error=$($writeError.Exception.Message)"
    throw "PHASE7C_JSON_ATOMIC_SHARING_RETRY_RED: transient File.Replace sharing violation escaped instead of being retried. nativeCode=$nativeCode error=$($writeError.Exception.Message)"
  }

  if (-not $child.WaitForExit(5000)) {
    throw 'Reader did not exit after bounded hold interval.'
  }
  Assert-True ($child.ExitCode -eq 0) "Reader exited nonzero. ExitCode=$($child.ExitCode)"

  $actual = Get-Content -LiteralPath $targetPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  Assert-True ([long]$actual.updatedAt -eq 2) 'Atomic writer did not publish the replacement JSON after transient sharing contention.'
  Assert-True ([int]$actual.brokerPid -eq 17668) 'Atomic replacement changed broker identity unexpectedly.'

  $leaks = @(Get-ChildItem -LiteralPath $tempRoot -File -ErrorAction Stop | Where-Object {
    $_.Name -like 'heartbeat.json.*.tmp' -or $_.Name -like 'heartbeat.json.*.bak'
  })
  Assert-True ($leaks.Count -eq 0) "Atomic writer leaked temp/backup files. count=$($leaks.Count)"

  Write-Host 'PHASE7C_JSON_ATOMIC_SHARING_RETRY_TEST=PASS'
  Write-Host 'TRANSIENT_SHARING_VIOLATION=RECOVERED'
  Write-Host 'FINAL_JSON_VALID=TRUE'
  Write-Host 'TEMP_BACKUP_LEAKS=0'
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (-not $child.HasExited) {
      try { $child.Kill() } catch { }
      try { $child.WaitForExit(5000) | Out-Null } catch { }
    }
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
