$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$helperPath = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
$registerPath = Join-Path $PSScriptRoot 'register-phase7c-executor-task-local.ps1'
$verifyPath = Join-Path $PSScriptRoot 'verify-phase7c-executors-local.ps1'

. $helperPath

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ([string]$Expected -ne [string]$Actual) {
    throw "$Message Expected=[$Expected] Actual=[$Actual]"
  }
}

$expectedRunner = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$absolutePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$canonicalAction = [pscustomobject]@{
  Execute = $absolutePowerShell
  Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $expectedRunner
}

$owned = Test-Phase7CExecutorTaskActionOwnership -Actions @($canonicalAction) -ExpectedRunnerPath $expectedRunner
Assert-True $owned.owned 'Canonical absolute Phase7C action must be owned.'
Assert-Equal 'OWNED' $owned.reason 'Canonical ownership reason mismatch.'

$legacyRelativeAction = [pscustomobject]@{
  Execute = 'powershell.exe'
  Arguments = $canonicalAction.Arguments
}
$legacyOwned = Test-Phase7CExecutorTaskActionOwnership -Actions @($legacyRelativeAction) -ExpectedRunnerPath $expectedRunner
Assert-True $legacyOwned.owned 'Legacy relative PowerShell action must remain recognizable as owned for safe repair.'
Assert-Equal 'OWNED' $legacyOwned.reason 'Legacy relative ownership reason mismatch.'

$wrongRunner = [pscustomobject]@{
  Execute = $absolutePowerShell
  Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\Other\run-phase7c-executor-task-runner-local.ps1"'
}
$wrongRunnerResult = Test-Phase7CExecutorTaskActionOwnership -Actions @($wrongRunner) -ExpectedRunnerPath $expectedRunner
Assert-True (-not $wrongRunnerResult.owned) 'Wrong runner path must be blocked.'
Assert-Equal 'RUNNER_PATH_MISMATCH' $wrongRunnerResult.reason 'Wrong runner reason mismatch.'

$wrongExecutable = [pscustomobject]@{
  Execute = 'C:\Temp\powershell.exe'
  Arguments = $canonicalAction.Arguments
}
$wrongExecutableResult = Test-Phase7CExecutorTaskActionOwnership -Actions @($wrongExecutable) -ExpectedRunnerPath $expectedRunner
Assert-True (-not $wrongExecutableResult.owned) 'Untrusted PowerShell executable path must be blocked.'
Assert-Equal 'EXECUTABLE_MISMATCH' $wrongExecutableResult.reason 'Wrong executable reason mismatch.'

$extraArgument = [pscustomobject]@{
  Execute = $absolutePowerShell
  Arguments = "$($canonicalAction.Arguments) -Armed"
}
$extraArgumentResult = Test-Phase7CExecutorTaskActionOwnership -Actions @($extraArgument) -ExpectedRunnerPath $expectedRunner
Assert-True (-not $extraArgumentResult.owned) 'Extra action arguments must be blocked.'
Assert-Equal 'ARGUMENT_COUNT' $extraArgumentResult.reason 'Extra argument reason mismatch.'

$multipleResult = Test-Phase7CExecutorTaskActionOwnership -Actions @($canonicalAction, $canonicalAction) -ExpectedRunnerPath $expectedRunner
Assert-True (-not $multipleResult.owned) 'Multiple actions must be blocked.'
Assert-Equal 'ACTION_COUNT' $multipleResult.reason 'Multiple action reason mismatch.'

$task = [pscustomobject]@{
  Actions = @($canonicalAction)
  Triggers = @([pscustomobject]@{ CimClassName = 'MSFT_TaskBootTrigger' })
  Settings = [pscustomobject]@{
    AllowDemandStart = $true
    StartWhenAvailable = $true
    MultipleInstances = 'IgnoreNew'
    RestartCount = 0
    ExecutionTimeLimit = 'PT0S'
  }
  Principal = [pscustomobject]@{
    UserId = 'phase7c-test-user'
    RunLevel = 'Highest'
  }
}

$drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
Assert-Equal 0 $drift.Count 'Canonical task must have no drift.'

$task.Settings.StartWhenAvailable = $false
$drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
Assert-True ($drift -contains 'START_WHEN_AVAILABLE') 'Settings drift must be detected after ownership.'
$task.Settings.StartWhenAvailable = $true

$task.Principal.RunLevel = 'Limited'
$drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
Assert-True ($drift -contains 'PRINCIPAL_RUN_LEVEL') 'Principal RunLevel drift must be detected.'
$task.Principal.RunLevel = 'Highest'

Assert-Equal 'ACCESS_DENIED' (Get-Phase7CScheduledTaskErrorClassification -Exception (New-Object System.UnauthorizedAccessException 'Access denied')) 'Access denied classification mismatch.'
Assert-Equal 'NOT_FOUND' (Get-Phase7CScheduledTaskErrorClassification -Exception (New-Object System.Exception 'Scheduled task not found')) 'Not found classification mismatch.'
Assert-Equal 'PROVIDER_ERROR' (Get-Phase7CScheduledTaskErrorClassification -Exception (New-Object System.Exception 'CIM provider unavailable')) 'Provider error classification mismatch.'

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('phase7c-task-ownership-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$lockPath = Join-Path $tempRoot 'startup-runner.lock'
[System.IO.File]::WriteAllText($lockPath, 'test')
try {
  Assert-Equal 'RELEASED' (Get-Phase7CStartupRunnerLockState -LockPath $lockPath) 'Unlocked singleton file must report RELEASED.'
  $handle = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    Assert-Equal 'HELD' (Get-Phase7CStartupRunnerLockState -LockPath $lockPath) 'Exclusive singleton file must report HELD.'
  } finally {
    $handle.Dispose()
  }
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$registerSource = Get-Content -LiteralPath $registerPath -Raw
Assert-True ($registerSource -match 'Test-Phase7CExecutorTaskActionOwnership') 'Registration script must prove ownership before repair.'
Assert-True ($registerSource -match 'Set-ScheduledTask') 'Registration script must use in-place task repair.'
Assert-True ($registerSource -match 'PHASE7C_TASK_MUTATION=BLOCKED') 'Registration script must expose fail-closed mutation marker.'
Assert-True ($registerSource -match 'PrincipalUserId') 'Task creation must require explicit principal identity.'
Assert-True ($registerSource -match 'System32\\WindowsPowerShell\\v1\.0\\powershell\.exe') 'Registration script must use the canonical absolute Windows PowerShell executable.'
Assert-True ($registerSource -match 'ACTION_EXECUTABLE') 'Registration script must classify legacy relative PowerShell action as repairable executable drift.'
Assert-True ($registerSource -notmatch 'Register-ScheduledTask[^\r\n]*-Force') 'Registration script must not force-overwrite an existing task.'
Assert-True ($registerSource -notmatch 'Unregister-ScheduledTask') 'Registration script must never delete an existing task.'
Assert-True ($registerSource -notmatch '(?i)taskkill') 'Registration script must not kill processes.'

$verifySource = Get-Content -LiteralPath $verifyPath -Raw
Assert-True ($verifySource -match 'phase7c-scheduled-task-ownership\.ps1') 'Strict verifier must load scheduled task ownership helper.'
Assert-True ($verifySource -match 'PHASE7C_VERIFY_TASK_OWNERSHIP') 'Strict verifier must report exact task ownership.'
Assert-True ($verifySource -match 'PHASE7C_VERIFY_STARTUP_RUNNER_LOCK') 'Strict verifier must report singleton lock state.'
Assert-True ($verifySource -match 'Get-Phase7CStartupRunnerLockState') 'Strict verifier must probe singleton lock state.'

Write-Host 'PHASE7C_SCHEDULED_TASK_OWNERSHIP_TEST=PASS'
