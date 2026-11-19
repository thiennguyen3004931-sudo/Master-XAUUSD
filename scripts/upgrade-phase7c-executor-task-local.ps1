param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$TaskName = "XAUUSD-Phase7B-Bot",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [double]$TrendFixedVolume = 0.03,
  [double]$SidewayRiskPercent = 0.25,
  [double]$SidewayMaxLot = 0.03,
  [switch]$StartTask,
  [switch]$RestoreLegacy
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1"
$Stopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"

if (-not (Test-Path $Supervisor)) { throw "Phase 7C supervisor not found: $Supervisor" }
if (-not (Test-Path $Stopper)) { throw "Phase 7C stopper not found: $Stopper" }
if ($TrendFixedVolume -lt 0.03 -or $TrendFixedVolume -gt 0.30) { throw "TrendFixedVolume must be between 0.03 and 0.30." }
if ($SidewayRiskPercent -lt 0.01 -or $SidewayRiskPercent -gt 1) { throw "SidewayRiskPercent must be between 0.01 and 1.00." }
if ($SidewayMaxLot -lt 0.03 -or $SidewayMaxLot -gt 0.30) { throw "SidewayMaxLot must be between 0.03 and 0.30." }
foreach ($managedLot in @($TrendFixedVolume, $SidewayMaxLot)) {
  $units = $managedLot / 0.03
  if ([math]::Abs($units - [math]::Round($units)) -gt 1e-8) { throw "Managed lot values must use 0.03 increments." }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run PowerShell as Administrator to migrate the scheduled task action."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path
if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
if (-not (Test-Path $EnvFile)) { throw "Environment file not found: $EnvFile" }
$EnvFile = (Resolve-Path $EnvFile).Path

$RuntimeDir = Join-Path $WorkDir "phase7c-executors"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$BackupPath = Join-Path $RuntimeDir "scheduled-task-action-backup.json"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1) {
  throw "Task $TaskName has $($actions.Count) actions. Migration refuses to change a non-single-action task automatically."
}
$currentAction = $actions[0]
$currentActionText = "$([string]$currentAction.Execute) $([string]$currentAction.Arguments)"
$currentIsPhase7C = $currentActionText -like "*run-phase7c-executors-local.ps1*" -and $currentActionText -like "*-Armed*"

if ($RestoreLegacy) {
  if (-not (Test-Path $BackupPath)) { throw "Legacy task action backup not found: $BackupPath" }
  $backup = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
  if ([int]$backup.version -ne 1) { throw "Legacy task backup version is unsupported: $($backup.version)" }
  if ([string]::IsNullOrWhiteSpace($backup.execute)) { throw "Legacy task backup is invalid: execute is empty." }
  if (-not [string]::IsNullOrWhiteSpace($backup.taskName) -and [string]$backup.taskName -ne $TaskName) {
    throw "Legacy task backup belongs to $($backup.taskName), not $TaskName."
  }
  $backupText = "$([string]$backup.execute) $([string]$backup.arguments)"
  if ($backupText -like "*run-phase7c-executors-local.ps1*") {
    throw "Legacy task backup is unsafe because it already points to the Phase 7C supervisor. Refusing rollback."
  }

  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Stopper -WorkDir $WorkDir
  if ([string]::IsNullOrWhiteSpace([string]$backup.workingDirectory)) {
    $legacyAction = New-ScheduledTaskAction -Execute ([string]$backup.execute) -Argument ([string]$backup.arguments)
  } else {
    $legacyAction = New-ScheduledTaskAction -Execute ([string]$backup.execute) -Argument ([string]$backup.arguments) -WorkingDirectory ([string]$backup.workingDirectory)
  }
  Set-ScheduledTask -TaskName $TaskName -Action $legacyAction | Out-Null
  Write-Host "PHASE7C_TASK_RESTORE=PASS"
  Write-Host "PHASE7C_TASK_NAME=$TaskName"
  Write-Host "PHASE7C_TASK_ACTION_EXECUTE=$($backup.execute)"
  Write-Host "PHASE7C_TASK_ACTION_ARGUMENTS=$($backup.arguments)"
  if ($StartTask) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "PHASE7C_TASK_RESTORE_START=REQUESTED"
  }
  exit 0
}

if (-not (Test-Path $BackupPath)) {
  if ($currentIsPhase7C) {
    throw "Task $TaskName already points to Phase 7C, but no legacy backup exists at $BackupPath. Refusing to overwrite rollback history."
  }
  [pscustomobject]@{
    version = 1
    taskName = $TaskName
    capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    execute = [string]$currentAction.Execute
    arguments = [string]$currentAction.Arguments
    workingDirectory = [string]$currentAction.WorkingDirectory
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $BackupPath -Encoding utf8
  Write-Host "PHASE7C_TASK_BACKUP=CREATED"
} else {
  $existingBackup = Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json
  if ([int]$existingBackup.version -ne 1 -or [string]::IsNullOrWhiteSpace($existingBackup.execute)) {
    throw "Existing legacy backup is invalid: $BackupPath"
  }
  $existingBackupText = "$([string]$existingBackup.execute) $([string]$existingBackup.arguments)"
  if ($existingBackupText -like "*run-phase7c-executors-local.ps1*") {
    throw "Existing rollback backup already points to Phase 7C and is unsafe: $BackupPath"
  }
  Write-Host "PHASE7C_TASK_BACKUP=PRESERVED_EXISTING"
}

$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy Bypass",
  ('-File "{0}"' -f $Supervisor),
  ('-WorkDir "{0}"' -f $WorkDir),
  ('-ControlApiUrl "{0}"' -f $ControlApiUrl),
  ('-EnvFile "{0}"' -f $EnvFile),
  ('-TrendFixedVolume {0}' -f $TrendFixedVolume.ToString([System.Globalization.CultureInfo]::InvariantCulture)),
  ('-SidewayRiskPercent {0}' -f $SidewayRiskPercent.ToString([System.Globalization.CultureInfo]::InvariantCulture)),
  ('-SidewayMaxLot {0}' -f $SidewayMaxLot.ToString([System.Globalization.CultureInfo]::InvariantCulture)),
  "-Armed"
) -join " "

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Stopper -WorkDir $WorkDir
$newAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $ProjectRoot
Set-ScheduledTask -TaskName $TaskName -Action $newAction | Out-Null

$verify = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$verifyActions = @($verify.Actions)
if ($verifyActions.Count -ne 1) { throw "Task action verification failed: expected one action." }
$verifyAction = $verifyActions[0]
if ([string]$verifyAction.Execute -notmatch "powershell" -or [string]$verifyAction.Arguments -notlike "*run-phase7c-executors-local.ps1*" -or [string]$verifyAction.Arguments -notlike "*-Armed*") {
  throw "Task action verification failed after Phase 7C migration."
}

Write-Host "PHASE7C_TASK_MIGRATION=PASS"
Write-Host "PHASE7C_TASK_NAME=$TaskName"
Write-Host "PHASE7C_TASK_TRIGGERS_PRESERVED=YES"
Write-Host "PHASE7C_TASK_PRINCIPAL_PRESERVED=YES"
Write-Host "PHASE7C_TASK_SETTINGS_PRESERVED=YES"
Write-Host "PHASE7C_TASK_ACTION=GATED_TREND_PLUS_SIDEWAY_SUPERVISOR"
Write-Host "PHASE7C_TASK_DEMO_ONLY=TRUE"
Write-Host "PHASE7C_TASK_BACKUP=$BackupPath"

if ($StartTask) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 5
  $after = Get-ScheduledTask -TaskName $TaskName
  Write-Host "PHASE7C_TASK_STATE=$($after.State)"
  Write-Host "PHASE7C_TASK_START=REQUESTED"
} else {
  Write-Host "PHASE7C_TASK_START=SKIPPED"
}
