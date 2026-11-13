$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$helperPath = Join-Path $PSScriptRoot 'lib\phase7b-windows-job-object.ps1'
$autostartPath = Join-Path $PSScriptRoot 'run-phase7b-web-autostart.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Test-ProcessAlive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 10) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}

function Wait-ForExit([int]$ProcessId, [int]$TimeoutSeconds = 5) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ProcessAlive $ProcessId)) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return -not (Test-ProcessAlive $ProcessId)
}

function Stop-TestProcessTree([int]$ProcessId) {
  if (-not (Test-ProcessAlive $ProcessId)) { return }
  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (Test-Path -LiteralPath $taskkill) {
    & $taskkill /PID $ProcessId /T /F 2>$null | Out-Null
  } else {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Test-HelperCallerStatePreserved {
  $ErrorActionPreference = 'Continue'
  Set-StrictMode -Off
  . $helperPath

  $errorActionPreserved = $ErrorActionPreference -eq 'Continue'
  $strictModePreserved = $true
  try {
    $null = $phase7bJobObjectUndefinedProbe
  } catch {
    $strictModePreserved = $false
  }

  return [pscustomobject]@{
    ErrorActionPreferencePreserved = $errorActionPreserved
    StrictModeOffPreserved = $strictModePreserved
  }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('phase7b-job-object-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$childScript = Join-Path $tempRoot 'child.ps1'
$grandchildScript = Join-Path $tempRoot 'grandchild.ps1'
$supervisorScript = Join-Path $tempRoot 'supervisor.ps1'
$childPidFile = Join-Path $tempRoot 'child.pid'
$grandchildPidFile = Join-Path $tempRoot 'grandchild.pid'
$containmentFile = Join-Path $tempRoot 'containment.txt'
$supervisor = $null
$childPid = 0
$grandchildPid = 0

@'
param([string]$ReadyFile)
$ErrorActionPreference = 'Stop'
Set-Content -LiteralPath $ReadyFile -Value ([string]$PID) -Encoding Ascii
while ($true) { Start-Sleep -Seconds 1 }
'@ | Set-Content -LiteralPath $grandchildScript -Encoding UTF8

@'
param(
  [string]$GrandchildScript,
  [string]$GrandchildPidFile
)
$ErrorActionPreference = 'Stop'
Start-Sleep -Milliseconds 500
$shellPath = (Get-Process -Id $PID).Path
$grandchild = Start-Process -FilePath $shellPath -PassThru -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"{0}"' -f $GrandchildScript),
  '-ReadyFile', ('"{0}"' -f $GrandchildPidFile)
)
while ($true) { Start-Sleep -Seconds 1 }
'@ | Set-Content -LiteralPath $childScript -Encoding UTF8

@'
param(
  [string]$HelperPath,
  [string]$ChildScript,
  [string]$GrandchildScript,
  [string]$ChildPidFile,
  [string]$GrandchildPidFile,
  [string]$ContainmentFile
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$jobHandle = $null
if (Test-Path -LiteralPath $HelperPath) {
  . $HelperPath
  $jobHandle = New-Phase7BKillOnCloseJob -Name ('Phase7B-Test-' + [guid]::NewGuid().ToString('N'))
  Add-Phase7BProcessToJob -Job $jobHandle -ProcessId $PID
  Set-Content -LiteralPath $ContainmentFile -Value 'JOB_OBJECT' -Encoding Ascii
} else {
  Set-Content -LiteralPath $ContainmentFile -Value 'NONE' -Encoding Ascii
}

$shellPath = (Get-Process -Id $PID).Path
$child = Start-Process -FilePath $shellPath -PassThru -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"{0}"' -f $ChildScript),
  '-GrandchildScript', ('"{0}"' -f $GrandchildScript),
  '-GrandchildPidFile', ('"{0}"' -f $GrandchildPidFile)
)
Set-Content -LiteralPath $ChildPidFile -Value ([string]$child.Id) -Encoding Ascii
while ($true) { Start-Sleep -Seconds 1 }
'@ | Set-Content -LiteralPath $supervisorScript -Encoding UTF8

$violations = New-Object System.Collections.Generic.List[string]
$helperState = Test-HelperCallerStatePreserved
if (-not $helperState.ErrorActionPreferencePreserved) {
  $violations.Add('JOB_OBJECT_HELPER_MUTATES_ERROR_ACTION_PREFERENCE')
}
if (-not $helperState.StrictModeOffPreserved) {
  $violations.Add('JOB_OBJECT_HELPER_MUTATES_STRICT_MODE')
}

try {
  $shellPath = (Get-Process -Id $PID).Path
  $supervisor = Start-Process -FilePath $shellPath -PassThru -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $supervisorScript),
    '-HelperPath', ('"{0}"' -f $helperPath),
    '-ChildScript', ('"{0}"' -f $childScript),
    '-GrandchildScript', ('"{0}"' -f $grandchildScript),
    '-ChildPidFile', ('"{0}"' -f $childPidFile),
    '-GrandchildPidFile', ('"{0}"' -f $grandchildPidFile),
    '-ContainmentFile', ('"{0}"' -f $containmentFile)
  )

  Assert-True (Wait-ForFile $containmentFile) 'Containment fixture did not initialize.'
  Assert-True (Wait-ForFile $childPidFile) 'Child PID was not published.'
  Assert-True (Wait-ForFile $grandchildPidFile) 'Grandchild PID was not published.'

  $containment = (Get-Content -LiteralPath $containmentFile -Raw).Trim()
  $childPid = [int](Get-Content -LiteralPath $childPidFile -Raw).Trim()
  $grandchildPid = [int](Get-Content -LiteralPath $grandchildPidFile -Raw).Trim()
  Assert-True (Test-ProcessAlive $childPid) 'Child process was not alive before forced supervisor termination.'
  Assert-True (Test-ProcessAlive $grandchildPid) 'Grandchild process was not alive before forced supervisor termination.'

  Stop-Process -Id $supervisor.Id -Force
  $supervisor.WaitForExit(5000) | Out-Null

  $childExited = Wait-ForExit $childPid
  $grandchildExited = Wait-ForExit $grandchildPid
  if (-not $childExited -or -not $grandchildExited) {
    $violations.Add("DESCENDANTS_SURVIVED_AFTER_FORCED_SUPERVISOR_TERMINATION containment=$containment childAlive=$(-not $childExited) grandchildAlive=$(-not $grandchildExited)")
  }

  $autostartSource = Get-Content -LiteralPath $autostartPath -Raw
  if ($autostartSource -notmatch 'phase7b-windows-job-object\.ps1') {
    $violations.Add('AUTOSTART_JOB_OBJECT_HELPER_REFERENCE_MISSING')
  }
  $createIndex = $autostartSource.IndexOf('New-Phase7BKillOnCloseJob', [System.StringComparison]::Ordinal)
  $assignIndex = $autostartSource.IndexOf('Add-Phase7BProcessToJob', [System.StringComparison]::Ordinal)
  $firstStartIndex = $autostartSource.IndexOf('Start-Process', [System.StringComparison]::Ordinal)
  if ($createIndex -lt 0) { $violations.Add('AUTOSTART_JOB_OBJECT_CREATE_MISSING') }
  if ($assignIndex -lt 0) { $violations.Add('AUTOSTART_JOB_OBJECT_ASSIGN_MISSING') }
  if ($assignIndex -ge 0 -and $firstStartIndex -ge 0 -and $assignIndex -gt $firstStartIndex) {
    $violations.Add('AUTOSTART_JOB_OBJECT_ASSIGN_MUST_PRECEDE_CHILD_START')
  }

  if ($violations.Count -gt 0) {
    Write-Host 'PHASE7B_WEB_JOB_OBJECT_CLEANUP_TEST=FAIL'
    foreach ($violation in $violations) { Write-Host "VIOLATION=$violation" }
    throw ('Phase7B Web Job Object cleanup contract failed: ' + ($violations -join '; '))
  }

  Write-Host 'PHASE7B_WEB_JOB_OBJECT_CLEANUP_TEST=PASS'
  Write-Host 'FORCED_SUPERVISOR_TERMINATION=DESCENDANTS_CLEANED'
  Write-Host 'AUTOSTART_JOB_OBJECT_ASSIGNMENT=BEFORE_CHILD_START'
  Write-Host 'JOB_OBJECT_HELPER_CALLER_STATE=PRESERVED'
}
finally {
  if ($null -ne $supervisor -and (Test-ProcessAlive $supervisor.Id)) {
    Stop-TestProcessTree $supervisor.Id
  }
  if ($childPid -gt 0) { Stop-TestProcessTree $childPid }
  if ($grandchildPid -gt 0) { Stop-TestProcessTree $grandchildPid }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
