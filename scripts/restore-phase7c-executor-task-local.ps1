param(
  [string]$ProjectRoot = '',
  [string]$TaskName = 'XAUUSD-Phase7C-Executors',
  [string]$ApiBase = 'http://127.0.0.1:3711',
  [switch]$ConfirmCreate
)

$ErrorActionPreference = 'Stop'

if (-not $ConfirmCreate) {
  throw 'Explicit -ConfirmCreate is required. This script only restores the Scheduled Task definition; it does not start executors.'
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run from PowerShell Administrator.'
}

Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE=START'
Write-Host "PHASE7C_EXECUTOR_TASK_RESTORE_TASK=$TaskName"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE_ALREADY_EXISTS=True'
  powershell.exe -NoProfile -ExecutionPolicy Bypass `
    -File (Join-Path $ProjectRoot 'scripts\register-phase7c-executor-task-local.ps1') `
    -TaskName $TaskName `
    -ProjectRoot $ProjectRoot
  if ($LASTEXITCODE -ne 0) { throw 'Existing canonical executor task verification failed.' }
  Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE_TASK_START_PERFORMED=False'
  Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE=PASS'
  exit 0
}

$bot = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 5
if ([string]$bot.state.mode -ne 'PAUSE') {
  throw "Bot must be PAUSE before restoring missing executor task. Current=$($bot.state.mode)"
}
$life = Invoke-RestMethod -Uri "$ApiBase/api/v1/phase7c/lifecycle" -Method Get -TimeoutSec 8
if (-not $life.accountMode.valid) { throw 'Account-mode runtime state is invalid.' }
if (-not $life.bridge.reachable -or -not $life.bridge.accountModeMatchesConfigured) {
  throw 'Bridge must be reachable and match selected account before task restore.'
}
if ([int]$life.bridge.openXauusdPositions -ne 0) {
  throw "XAUUSD must be flat before task restore. positions=$($life.bridge.openXauusdPositions)"
}

$principalUserId = [string]$identity.Name
if ([string]::IsNullOrWhiteSpace($principalUserId)) { throw 'Cannot resolve current Windows principal identity.' }

$register = Join-Path $ProjectRoot 'scripts\register-phase7c-executor-task-local.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $register `
  -TaskName $TaskName `
  -ProjectRoot $ProjectRoot `
  -Create `
  -PrincipalUserId $principalUserId `
  -PrincipalLogonType Interactive
if ($LASTEXITCODE -ne 0) { throw 'Canonical executor task creation failed.' }

$created = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ([string]$created.State -eq 'Running') {
  throw 'Unexpected: task started during restore. Stop and inspect before proceeding.'
}
Write-Host "PHASE7C_EXECUTOR_TASK_RESTORE_STATE=$($created.State)"
Write-Host "PHASE7C_EXECUTOR_TASK_RESTORE_PRINCIPAL=$($created.Principal.UserId)"
Write-Host "PHASE7C_EXECUTOR_TASK_RESTORE_RUN_LEVEL=$($created.Principal.RunLevel)"
Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE_TASK_START_PERFORMED=False'
Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE_ACCOUNT_SWITCH=False'
Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE_LIVE_ARM_MUTATION=False'
Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE_ORDER_SEND=False'
Write-Host 'PHASE7C_EXECUTOR_TASK_RESTORE=PASS'
