param(
  [string]$TaskName = "XAUUSD-Phase7C-Bridge"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $PSScriptRoot "run-phase7c-account-bridge-task-runner-local.ps1"
if (-not (Test-Path -LiteralPath $Runner)) { throw "Phase7C account bridge runner not found: $Runner" }

$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) {
  throw "Windows PowerShell executable not found: $PowerShellExe"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Registering the Phase7C account bridge task requires PowerShell Administrator."
}

$arguments = ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f $Runner)
$action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument $arguments `
  -WorkingDirectory $ProjectRoot

$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$principal = New-ScheduledTaskPrincipal `
  -UserId $userId `
  -LogonType Interactive `
  -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1) {
  throw "Registered bridge task must contain exactly one action."
}
$registeredAction = $actions[0]
if (
  [string]$registeredAction.Execute -ne $PowerShellExe -or
  [string]$registeredAction.Arguments -ne $arguments -or
  [string]$registeredAction.WorkingDirectory -ne $ProjectRoot
) {
  throw "Registered bridge task action verification failed."
}

Write-Host "PHASE7C_ACCOUNT_BRIDGE_TASK=$TaskName"
Write-Host "PHASE7C_ACCOUNT_BRIDGE_TASK_STATE=$($task.State)"
Write-Host "PHASE7C_ACCOUNT_BRIDGE_TASK_EXECUTABLE=$PowerShellExe"
Write-Host "PHASE7C_ACCOUNT_BRIDGE_TASK_ACTION=PASS"
Write-Host "PHASE7C_ACCOUNT_BRIDGE_TASK_STATUS=PASS"
