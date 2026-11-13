param(
  [string]$WorkDir = ".runtime",
  [string]$TaskName = "XAUUSD-Phase7C-Account-Switch"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path -LiteralPath $WorkDir)) { throw "Account switch WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$Runner = Join-Path $PSScriptRoot "run-phase7c-account-switch-task-runner-local.ps1"
if (-not (Test-Path -LiteralPath $Runner)) { throw "Account switch task runner missing: $Runner" }

$principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this registration script from PowerShell Administrator."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -WorkDir `"$WorkDir`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $ProjectRoot
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Principal $principal `
  -Settings $settings `
  -Description "XAUUSD Phase7C guarded DEMO/LIVE account switch worker. No trigger; local Web may only request explicit guarded switches." `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1) { throw "Registered account-switch task must have exactly one action." }
$actual = "$($actions[0].Execute) $($actions[0].Arguments)"
if ($actual.IndexOf($Runner, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "Registered account-switch task does not own the canonical runner."
}
if ([string]$task.Principal.RunLevel -ne "Highest") {
  throw "Registered account-switch task must use RunLevel Highest."
}

Write-Host "PHASE7C_ACCOUNT_SWITCH_TASK=REGISTERED"
Write-Host "PHASE7C_ACCOUNT_SWITCH_TASK_NAME=$TaskName"
Write-Host "PHASE7C_ACCOUNT_SWITCH_TASK_RUNNER=$Runner"
Write-Host "PHASE7C_ACCOUNT_SWITCH_TASK_RUN_LEVEL=Highest"
Write-Host "PHASE7C_ACCOUNT_SWITCH_TASK_TRIGGER=NONE"
Write-Host "PHASE7C_ACCOUNT_SWITCH_TASK_STATUS=PASS"