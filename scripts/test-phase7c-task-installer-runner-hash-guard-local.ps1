$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Installer = Join-Path $PSScriptRoot 'register-phase7c-executor-task-local.ps1'
$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
foreach ($required in @($Installer, $OwnershipLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required production source missing: $required"
  }
}
. $OwnershipLibrary

function Assert-Phase7CInstallerGuardTest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-TestGit([string]$RepositoryRoot, [string[]]$Arguments) {
  $output = @(& git -C $RepositoryRoot @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git fixture command failed: git -C '$RepositoryRoot' $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
  }
  return @($output)
}

function Quote-Phase7CSingle([string]$Value) {
  return ([string]$Value).Replace("'", "''")
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Task installer runner-hash integration test requires Administrator on the CI host.'
}

Import-Module ScheduledTasks -ErrorAction Stop

$tempRoot = Join-Path $env:ProgramData ("phase7c-task-installer-hash-{0}" -f [Guid]::NewGuid().ToString('N'))
$scriptsDir = Join-Path $tempRoot 'scripts'
$runnerPath = Join-Path $scriptsDir 'run-phase7c-executor-task-runner-local.ps1'
$markerPath = Join-Path $tempRoot 'runner-executed.txt'
$heartbeatPath = Join-Path $tempRoot '.runtime\phase7c-lifecycle-broker\state\heartbeat.json'
$wrapperPath = Join-Path $tempRoot 'invoke-installer.ps1'
$stdoutPath = Join-Path $tempRoot 'installer.stdout.txt'
$stderrPath = Join-Path $tempRoot 'installer.stderr.txt'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskName = "Phase7C-CI-InstallerGuard-$([Guid]::NewGuid().ToString('N'))"
$registered = $false
$cleanRunnerPid = 0

try {
  New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null

  $runnerSource = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $ProjectRoot '.runtime\phase7c-lifecycle-broker\state'
$heartbeatPath = Join-Path $stateDir 'heartbeat.json'
$markerPath = Join-Path $ProjectRoot 'runner-executed.txt'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
[System.IO.File]::WriteAllText($markerPath, "$PID", [System.Text.UTF8Encoding]::new($false))

while ($true) {
  $json = @{
    version = 1
    brokerPid = $PID
    state = 'RUNNING'
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($heartbeatPath, $json, [System.Text.UTF8Encoding]::new($false))
  Start-Sleep -Milliseconds 100
}
'@
  [System.IO.File]::WriteAllText($runnerPath, $runnerSource, [System.Text.UTF8Encoding]::new($false))

  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('init', '--quiet') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('config', 'user.email', 'phase7c-ci@example.invalid') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('config', 'user.name', 'Phase7C CI') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('add', '--', 'scripts/run-phase7c-executor-task-runner-local.ps1') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('commit', '--quiet', '-m', 'fixture runner') | Out-Null

  $trustedHash = [string](Get-Phase7CTrustedGitFileSha256 -ProjectRoot $tempRoot -Path $runnerPath)
  $apiSid = [string]$identity.User.Value

  $installerQuoted = Quote-Phase7CSingle $Installer
  $taskQuoted = Quote-Phase7CSingle $taskName
  $rootQuoted = Quote-Phase7CSingle $tempRoot
  $sidQuoted = Quote-Phase7CSingle $apiSid
  $wrapperSource = @"
& '$installerQuoted' -TaskName '$taskQuoted' -ProjectRoot '$rootQuoted' -Create -PrincipalUserId 'SYSTEM' -PrincipalLogonType 'ServiceAccount' -ApiUserSid '$sidQuoted'
"@
  [System.IO.File]::WriteAllText($wrapperPath, $wrapperSource, [System.Text.UTF8Encoding]::new($false))

  $installerArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $wrapperPath
  $installerProcess = Start-Process `
    -FilePath $powerShellExe `
    -ArgumentList $installerArguments `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -Wait `
    -PassThru `
    -WindowStyle Hidden

  if ([int]$installerProcess.ExitCode -ne 0) {
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    throw "Installer fixture failed. exit=$($installerProcess.ExitCode)`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
  }

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $registered = $true
  $ownership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $task.Actions `
    -ExpectedRunnerPath $runnerPath `
    -ExpectedRunnerSha256 $trustedHash
  Assert-Phase7CInstallerGuardTest ([bool]$ownership.owned) "Installer task ownership failed. reason=$($ownership.reason)"
  Assert-Phase7CInstallerGuardTest ([bool]$ownership.canonical) "Installer task action is not canonical. reason=$($ownership.reason)"
  Assert-Phase7CInstallerGuardTest (-not [bool]$ownership.repairRequired) "Installer task unexpectedly requires repair. reason=$($ownership.reason)"
  Assert-Phase7CInstallerGuardTest ([string]$ownership.runnerSha256 -eq $trustedHash) 'Installer task did not pin the trusted runner SHA256.'

  $markerDeadline = [DateTime]::UtcNow.AddSeconds(8)
  while (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -and [DateTime]::UtcNow -lt $markerDeadline) {
    Start-Sleep -Milliseconds 50
  }
  Assert-Phase7CInstallerGuardTest (Test-Path -LiteralPath $markerPath -PathType Leaf) 'Clean trusted runner was not executed by the installed task.'
  $cleanRunnerPid = [int](([string](Get-Content -LiteralPath $markerPath -Raw)).Trim())
  Assert-Phase7CInstallerGuardTest ($cleanRunnerPid -gt 0 -and $null -ne (Get-Process -Id $cleanRunnerPid -ErrorAction SilentlyContinue)) "Clean installed runner process is not alive. PID=$cleanRunnerPid"

  Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($null -ne (Get-Process -Id $cleanRunnerPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $stopDeadline) {
    Start-Sleep -Milliseconds 100
  }
  Assert-Phase7CInstallerGuardTest ($null -eq (Get-Process -Id $cleanRunnerPid -ErrorAction SilentlyContinue)) "Clean installed runner did not stop. PID=$cleanRunnerPid"
  $cleanRunnerPid = 0

  Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $runnerPath -Value "`n# tampered after installer pinned trusted hash" -Encoding UTF8

  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $guardDeadline = [DateTime]::UtcNow.AddSeconds(10)
  $lastResult = 267009
  do {
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
      throw 'Tampered installed runner executed despite the Scheduled Task pre-execution hash guard.'
    }
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    $lastResult = [int]$info.LastTaskResult
    if ($lastResult -eq 86) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $guardDeadline)

  Assert-Phase7CInstallerGuardTest ($lastResult -eq 86) "Tampered installed task did not fail with guard exit 86. LastTaskResult=$lastResult"
  Assert-Phase7CInstallerGuardTest (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) 'Tampered installed runner side-effect marker exists.'
  Assert-Phase7CInstallerGuardTest (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) 'Tampered installed runner recreated broker heartbeat despite hash mismatch.'

  Write-Host 'PHASE7C_TASK_INSTALLER_RUNNER_HASH_GUARD_TEST=PASS'
  Write-Host 'INSTALLER_TRUSTED_GIT_RUNNER=PASS'
  Write-Host 'INSTALLER_ACTION_CANONICAL_HASH_GUARD=PASS'
  Write-Host 'CLEAN_PINNED_RUNNER_EXECUTED=TRUE'
  Write-Host 'TAMPERED_PINNED_RUNNER_EXECUTED=FALSE'
  Write-Host 'TAMPERED_TASK_LAST_RESULT=86'
} finally {
  if ($registered) {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
  if ($cleanRunnerPid -gt 0) {
    try { Stop-Process -Id $cleanRunnerPid -Force -ErrorAction SilentlyContinue } catch { }
  }
  try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

exit 0
