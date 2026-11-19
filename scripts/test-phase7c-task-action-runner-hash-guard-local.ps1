$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$OwnershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
if (-not (Test-Path -LiteralPath $OwnershipLibrary -PathType Leaf)) {
  throw "Required production source missing: $OwnershipLibrary"
}
. $OwnershipLibrary

function Assert-Phase7CGuardTest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-TestGit([string]$RepositoryRoot, [string[]]$Arguments) {
  $output = @(& git -C $RepositoryRoot @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git fixture command failed: git -C '$RepositoryRoot' $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
  }
  return @($output)
}

$tempRoot = Join-Path $env:TEMP ("phase7c-runner-hash-guard-{0}" -f [Guid]::NewGuid().ToString('N'))
$scriptsDir = Join-Path $tempRoot 'scripts'
$runnerPath = Join-Path $scriptsDir 'run-phase7c-executor-task-runner-local.ps1'
$markerPath = Join-Path $tempRoot 'runner-executed.txt'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$oldMarker = $env:PHASE7C_GUARD_TEST_MARKER

try {
  New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
  $env:PHASE7C_GUARD_TEST_MARKER = $markerPath

  $cleanRunner = @'
$ErrorActionPreference = 'Stop'
[System.IO.File]::WriteAllText($env:PHASE7C_GUARD_TEST_MARKER, 'EXECUTED', [System.Text.UTF8Encoding]::new($false))
'@
  [System.IO.File]::WriteAllText($runnerPath, $cleanRunner, [System.Text.UTF8Encoding]::new($false))

  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('init', '--quiet') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('config', 'user.email', 'phase7c-ci@example.invalid') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('config', 'user.name', 'Phase7C CI') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('add', '--', 'scripts/run-phase7c-executor-task-runner-local.ps1') | Out-Null
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @('commit', '--quiet', '-m', 'fixture runner') | Out-Null

  $trustedHash = [string](Get-Phase7CTrustedGitFileSha256 -ProjectRoot $tempRoot -Path $runnerPath)
  Assert-Phase7CGuardTest ($trustedHash -match '^[0-9A-F]{64}$') "Trusted runner hash is not canonical SHA256: $trustedHash"
  $actualCleanHash = (Get-FileHash -LiteralPath $runnerPath -Algorithm SHA256).Hash.ToUpperInvariant()
  Assert-Phase7CGuardTest ($trustedHash -eq $actualCleanHash) 'Trusted runner hash does not match the clean worktree runner bytes.'

  $guardArguments = [string](New-Phase7CExecutorTaskGuardArguments -RunnerPath $runnerPath -RunnerSha256 $trustedHash)
  $guardAction = [pscustomobject]@{ Execute = $powerShellExe; Arguments = $guardArguments }
  $guardOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions @($guardAction) -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedHash
  Assert-Phase7CGuardTest ([bool]$guardOwnership.owned) "Canonical guarded action is not owned. reason=$($guardOwnership.reason)"
  Assert-Phase7CGuardTest ([bool]$guardOwnership.canonical) "Canonical guarded action was not classified canonical. reason=$($guardOwnership.reason)"
  Assert-Phase7CGuardTest (-not [bool]$guardOwnership.repairRequired) "Canonical guarded action unexpectedly requires repair. reason=$($guardOwnership.reason)"
  Assert-Phase7CGuardTest ([string]$guardOwnership.reason -eq 'OWNED') "Canonical guarded action reason mismatch: $($guardOwnership.reason)"

  $legacyArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runnerPath
  $legacyAction = [pscustomobject]@{ Execute = $powerShellExe; Arguments = $legacyArguments }
  $legacyOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions @($legacyAction) -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedHash
  Assert-Phase7CGuardTest ([bool]$legacyOwnership.owned) "Legacy canonical action lost safe ownership. reason=$($legacyOwnership.reason)"
  Assert-Phase7CGuardTest (-not [bool]$legacyOwnership.canonical) 'Legacy canonical action must not be canonical after the provenance guard exists.'
  Assert-Phase7CGuardTest ([bool]$legacyOwnership.repairRequired) 'Legacy canonical action must require explicit repair.'
  Assert-Phase7CGuardTest ([string]$legacyOwnership.reason -eq 'OWNED_LEGACY_ACTION_REPAIR_REQUIRED') "Legacy ownership reason mismatch: $($legacyOwnership.reason)"

  $oldHash = ('A' * 64)
  if ($oldHash -eq $trustedHash) { $oldHash = ('B' * 64) }
  $oldGuardArguments = [string](New-Phase7CExecutorTaskGuardArguments -RunnerPath $runnerPath -RunnerSha256 $oldHash)
  $oldGuardAction = [pscustomobject]@{ Execute = $powerShellExe; Arguments = $oldGuardArguments }
  $oldGuardOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions @($oldGuardAction) -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedHash
  Assert-Phase7CGuardTest ([bool]$oldGuardOwnership.owned) "Old-hash Phase7C guard lost safe ownership. reason=$($oldGuardOwnership.reason)"
  Assert-Phase7CGuardTest (-not [bool]$oldGuardOwnership.canonical) 'Old-hash Phase7C guard must not be canonical.'
  Assert-Phase7CGuardTest ([bool]$oldGuardOwnership.repairRequired) 'Old-hash Phase7C guard must require explicit repair.'
  Assert-Phase7CGuardTest ([string]$oldGuardOwnership.reason -eq 'OWNED_HASH_DRIFT_REPAIR_REQUIRED') "Old-hash ownership reason mismatch: $($oldGuardOwnership.reason)"

  $foreignPayload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Write-Output 'foreign'"))
  $foreignAction = [pscustomobject]@{
    Execute = $powerShellExe
    Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $foreignPayload"
  }
  $foreignOwnership = Test-Phase7CExecutorTaskActionOwnership -Actions @($foreignAction) -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $trustedHash
  Assert-Phase7CGuardTest (-not [bool]$foreignOwnership.owned) 'Foreign encoded PowerShell action must never be treated as Phase7C-owned.'

  Add-Content -LiteralPath $runnerPath -Value "`n# tampered after task hash was pinned" -Encoding UTF8
  Invoke-TestGit -RepositoryRoot $tempRoot -Arguments @(
    'update-index',
    '--assume-unchanged',
    '--',
    'scripts/run-phase7c-executor-task-runner-local.ps1'
  ) | Out-Null

  $dirtyRejected = $false
  try {
    $null = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $tempRoot -Path $runnerPath
  } catch {
    $dirtyRejected = $true
  }
  Assert-Phase7CGuardTest $dirtyRejected 'Trusted Git runner verification accepted an assume-unchanged worktree runner that differs from HEAD.'

  if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force }
  $guardProcess = Start-Process -FilePath $powerShellExe -ArgumentList $guardArguments -Wait -PassThru -WindowStyle Hidden
  Assert-Phase7CGuardTest ([int]$guardProcess.ExitCode -eq 86) "Tampered runner guard exit code mismatch. expected=86 actual=$($guardProcess.ExitCode)"
  Assert-Phase7CGuardTest (-not (Test-Path -LiteralPath $markerPath)) 'Tampered runner executed despite pre-execution SHA256 guard.'

  Write-Host 'PHASE7C_TASK_ACTION_RUNNER_HASH_GUARD_TEST=PASS'
  Write-Host 'TRUSTED_GIT_RUNNER_HASH=PASS'
  Write-Host 'CANONICAL_GUARDED_ACTION=PASS'
  Write-Host 'LEGACY_ACTION_REPAIR_REQUIRED=PASS'
  Write-Host 'OLD_HASH_ACTION_REPAIR_REQUIRED=PASS'
  Write-Host 'FOREIGN_ENCODED_ACTION_BLOCKED=PASS'
  Write-Host 'ASSUME_UNCHANGED_TAMPER_REJECTED=PASS'
  Write-Host 'PRE_EXECUTION_HASH_MISMATCH_EXIT=86'
  Write-Host 'TAMPERED_RUNNER_EXECUTED=FALSE'
} finally {
  if ($null -eq $oldMarker) {
    Remove-Item Env:PHASE7C_GUARD_TEST_MARKER -ErrorAction SilentlyContinue
  } else {
    $env:PHASE7C_GUARD_TEST_MARKER = $oldMarker
  }
  try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

exit 0
