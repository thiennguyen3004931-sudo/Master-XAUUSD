param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$TaskName = "XAUUSD-Phase7C-Forward-Dashboard",
  [string]$ExecutionTaskName = "XAUUSD-Phase7C-Executors",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$HostAddress = "127.0.0.1",
  [int]$Port = 5727,
  [int]$RefreshSeconds = 15,
  [int]$ReportRefreshSeconds = 300,
  [int]$ReportLookbackDays = 7,
  [switch]$StartTask
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskRunner = Join-Path $PSScriptRoot "run-phase7c-forward-dashboard-task-runner-local.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-dashboard-task-config.json"

if (-not (Test-Path $TaskRunner)) { throw "Phase 7C forward dashboard task runner not found: $TaskRunner" }
if ($HostAddress -notin @("127.0.0.1", "localhost", "::1")) { throw "Dashboard task must remain loopback-only. Refused HostAddress=$HostAddress" }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }
if ($RefreshSeconds -lt 5 -or $RefreshSeconds -gt 300) { throw "RefreshSeconds must be between 5 and 300." }
if ($ReportRefreshSeconds -lt 60 -or $ReportRefreshSeconds -gt 3600) { throw "ReportRefreshSeconds must be between 60 and 3600." }
if ($ReportLookbackDays -lt 1 -or $ReportLookbackDays -gt 90) { throw "ReportLookbackDays must be between 1 and 90." }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$adminPrincipal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $adminPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run PowerShell as Administrator to install the Phase 7C forward dashboard scheduled task."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
if (-not (Test-Path $EnvFile)) { throw "Environment file not found: $EnvFile" }
$EnvFile = (Resolve-Path $EnvFile).Path

$executionTask = Get-ScheduledTask -TaskName $ExecutionTaskName -ErrorAction Stop
$executionActionsBefore = @($executionTask.Actions)
if ($executionActionsBefore.Count -ne 1) { throw "Execution task $ExecutionTaskName must have exactly one action." }
$executionFingerprintBefore = "$([string]$executionActionsBefore[0].Execute)|$([string]$executionActionsBefore[0].Arguments)|$([string]$executionActionsBefore[0].WorkingDirectory)|$([string]$executionTask.Principal.UserId)|$([string]$executionTask.Principal.GroupId)|$([string]$executionTask.Principal.LogonType)|$([string]$executionTask.Principal.RunLevel)"

$config = [pscustomobject]@{
  version = 1
  workDir = $WorkDir
  controlApiUrl = $ControlApiUrl.TrimEnd('/')
  envFile = $EnvFile
  hostAddress = $HostAddress
  port = $Port
  refreshSeconds = $RefreshSeconds
  reportRefreshSeconds = $ReportRefreshSeconds
  reportLookbackDays = $ReportLookbackDays
  readOnly = $true
  mt5Mutation = $false
  updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ConfigPath -Encoding utf8

$taskCommand = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $TaskRunner)
if ($taskCommand.Length -gt 240) {
  throw "Dashboard task command is unexpectedly long ($($taskCommand.Length) chars); refusing schtasks registration."
}
if ($taskCommand -match "(?i)(MT5_(?:API|BRIDGE_API)_KEY\s*=|ZIQ_TELEGRAM_BOT_TOKEN\s*=|x-phase7c-token)") {
  throw "Refusing to register dashboard task because a secret-like value appears in task command."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  $existingActions = @($existing.Actions)
  if ($existingActions.Count -ne 1) { throw "Existing dashboard task $TaskName has $($existingActions.Count) actions; refusing replacement." }
  $existingText = "$([string]$existingActions[0].Execute) $([string]$existingActions[0].Arguments)"
  if ($existingText -notlike "*run-phase7c-forward-dashboard-task-runner-local.ps1*" -and $existingText -notlike "*run-phase7c-forward-dashboard-local.ps1*") {
    throw "Task $TaskName already exists but does not belong to the Phase 7C dashboard."
  }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$schtasks = Join-Path $env:SystemRoot "System32\schtasks.exe"
if (-not (Test-Path $schtasks)) { throw "schtasks.exe not found: $schtasks" }

$nativeOutput = & $schtasks `
  /Create `
  /TN $TaskName `
  /SC ONSTART `
  /RU SYSTEM `
  /RL HIGHEST `
  /TR $taskCommand `
  /F 2>&1
$nativeExitCode = $LASTEXITCODE
if ($nativeExitCode -ne 0) {
  throw "schtasks.exe failed with exitCode=$nativeExitCode. Output=$($nativeOutput -join ' ')"
}

# schtasks.exe is deliberately used for principal/trigger creation because some
# Windows builds reject Register-ScheduledTask when UserId is returned blank.
# Updating Settings after creation does not replace or rewrite the principal.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Set-ScheduledTask -TaskName $TaskName -Settings $settings -ErrorAction Stop | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$registeredActions = @($registered.Actions)
if ($registeredActions.Count -ne 1) { throw "Dashboard task registration verification failed: expected exactly one action." }
$registeredText = "$([string]$registeredActions[0].Execute) $([string]$registeredActions[0].Arguments)"
if ([string]$registeredActions[0].Execute -notmatch "powershell" -or $registeredText -notlike "*run-phase7c-forward-dashboard-task-runner-local.ps1*") {
  throw "Dashboard task registration verification failed: action mismatch."
}
if ($registeredText -match "(?i)(MT5_(?:API|BRIDGE_API)_KEY\s*=|ZIQ_TELEGRAM_BOT_TOKEN\s*=|x-phase7c-token)") {
  throw "Dashboard task registration verification failed: secret-like value found in task command."
}
$bootTrigger = @($registered.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" })
if ($bootTrigger.Count -lt 1) { throw "Dashboard task registration verification failed: startup trigger missing." }
$registeredPrincipal = ([string]$registered.Principal.UserId).Trim()
if ($registeredPrincipal -notmatch '^(?i)(SYSTEM|NT AUTHORITY\\SYSTEM|S-1-5-18)$') {
  throw "Dashboard task principal is not SYSTEM: $registeredPrincipal"
}

# Depending on the ScheduledTasks provider/Windows build, ExecutionTimeLimit can
# come back as either a TimeSpan or the ISO-8601 duration string "PT0S". Both
# represent an unlimited task when the duration is zero.
$executionTimeLimitRaw = $registered.Settings.ExecutionTimeLimit
$executionTimeLimitIsUnlimited = $false
if ($executionTimeLimitRaw -is [TimeSpan]) {
  $executionTimeLimitIsUnlimited = ($executionTimeLimitRaw -eq [TimeSpan]::Zero)
} else {
  $executionTimeLimitText = ([string]$executionTimeLimitRaw).Trim()
  try {
    $executionTimeLimitIsUnlimited = ([System.Xml.XmlConvert]::ToTimeSpan($executionTimeLimitText) -eq [TimeSpan]::Zero)
  } catch {
    $executionTimeLimitIsUnlimited = $executionTimeLimitText -in @("00:00:00", "0.00:00:00")
  }
}
if (-not $executionTimeLimitIsUnlimited) {
  throw "Dashboard task ExecutionTimeLimit is not unlimited: $executionTimeLimitRaw"
}

$executionTaskAfter = Get-ScheduledTask -TaskName $ExecutionTaskName -ErrorAction Stop
$executionActionsAfter = @($executionTaskAfter.Actions)
if ($executionActionsAfter.Count -ne 1) { throw "Execution task changed unexpectedly while dashboard task was installed." }
$executionFingerprintAfter = "$([string]$executionActionsAfter[0].Execute)|$([string]$executionActionsAfter[0].Arguments)|$([string]$executionActionsAfter[0].WorkingDirectory)|$([string]$executionTaskAfter.Principal.UserId)|$([string]$executionTaskAfter.Principal.GroupId)|$([string]$executionTaskAfter.Principal.LogonType)|$([string]$executionTaskAfter.Principal.RunLevel)"
if ($executionFingerprintAfter -ne $executionFingerprintBefore) { throw "Execution task action/principal changed unexpectedly." }

Write-Host "PHASE7C_DASHBOARD_TASK_INSTALL=PASS"
Write-Host "PHASE7C_DASHBOARD_TASK_NAME=$TaskName"
Write-Host "PHASE7C_DASHBOARD_TASK_TRIGGER=AT_STARTUP"
Write-Host "PHASE7C_DASHBOARD_TASK_PRINCIPAL_KIND=SYSTEM_NATIVE_SCHTASKS"
Write-Host "PHASE7C_DASHBOARD_TASK_PRINCIPAL_USER=$registeredPrincipal"
Write-Host "PHASE7C_DASHBOARD_TASK_ACTION=FORWARD_DASHBOARD_TASK_RUNNER_READ_ONLY"
Write-Host "PHASE7C_DASHBOARD_TASK_CONFIG=$ConfigPath"
Write-Host "PHASE7C_DASHBOARD_TASK_URL=http://${HostAddress}:${Port}/"
Write-Host "PHASE7C_DASHBOARD_TASK_REPORT_REFRESH_SECONDS=$ReportRefreshSeconds"
Write-Host "PHASE7C_DASHBOARD_TASK_REPORT_LOOKBACK_DAYS=$ReportLookbackDays"
Write-Host "PHASE7C_DASHBOARD_TASK_EXECUTION_TIME_LIMIT=UNLIMITED"
Write-Host "PHASE7C_DASHBOARD_TASK_SECRETS_IN_ARGUMENTS=False"
Write-Host "PHASE7C_DASHBOARD_TASK_MT5_MUTATION=False"
Write-Host "PHASE7C_DASHBOARD_TASK_EXECUTION_TASK_UNCHANGED=True"

if ($StartTask) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $listener) {
    throw "Port $Port is already listening (PID=$($listener.OwningProcess)). Stop the manually launched dashboard before using -StartTask."
  }
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $afterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-Host "PHASE7C_DASHBOARD_TASK_START=REQUESTED"
  Write-Host "PHASE7C_DASHBOARD_TASK_STATE=$($afterStart.State)"
} else {
  Write-Host "PHASE7C_DASHBOARD_TASK_START=SKIPPED"
}
