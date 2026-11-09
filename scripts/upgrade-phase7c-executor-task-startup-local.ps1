param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$TaskName = "XAUUSD-Phase7C-Executors",
  [string]$ControlApiUrl = "http://127.0.0.1:3711",
  [string]$EnvFile = "packages/mt5-broker/bridge/.env.phase7b-demo",
  [string]$TelegramEnvFile = ".env.phase7b-telegram",
  [double]$TrendFixedVolume = 0.03,
  [double]$SidewayRiskPercent = 0.25,
  [double]$SidewayMaxLot = 0.03,
  [switch]$KeepStopped
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
$Stopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$BackupPath = Join-Path $ProjectRoot ".runtime\phase7c-executors\scheduled-task-preboot-backup.xml"

if (-not (Test-Path $TaskRunner)) { throw "Phase 7C executor task runner not found: $TaskRunner" }
if (-not (Test-Path $Stopper)) { throw "Phase 7C executor stopper not found: $Stopper" }
if ($TrendFixedVolume -lt 0.03 -or $TrendFixedVolume -gt 0.30) { throw "TrendFixedVolume must be between 0.03 and 0.30." }
if ($SidewayRiskPercent -lt 0.01 -or $SidewayRiskPercent -gt 1) { throw "SidewayRiskPercent must be between 0.01 and 1.00." }
if ($SidewayMaxLot -lt 0.03 -or $SidewayMaxLot -gt 0.30) { throw "SidewayMaxLot must be between 0.03 and 0.30." }
foreach ($managedLot in @($TrendFixedVolume, $SidewayMaxLot)) {
  $units = $managedLot / 0.03
  if ([math]::Abs($units - [math]::Round($units)) -gt 1e-8) { throw "Managed lot values must use 0.03 increments." }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$adminPrincipal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $adminPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run PowerShell as Administrator to upgrade the Phase 7C executor task to startup/SYSTEM."
}

if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path
$LotSettingsPath = Join-Path $WorkDir "phase7c-lot-settings.json"
if (Test-Path $LotSettingsPath) {
  try {
    $lotSettings = Get-Content -LiteralPath $LotSettingsPath -Raw | ConvertFrom-Json
    if ([int]$lotSettings.version -ne 1) { throw "Unsupported version $($lotSettings.version)." }
    $TrendFixedVolume = [double]$lotSettings.trendFixedLot
    $SidewayRiskPercent = [double]$lotSettings.sidewayRiskPercent
    $SidewayMaxLot = [double]$lotSettings.sidewayMaxLot
  } catch {
    throw "Phase 7C lot settings are invalid at $LotSettingsPath. $($_.Exception.Message)"
  }
}
if ($TrendFixedVolume -lt 0.03 -or $TrendFixedVolume -gt 0.30) { throw "Configured TrendFixedVolume is invalid: $TrendFixedVolume" }
if ($SidewayRiskPercent -lt 0.01 -or $SidewayRiskPercent -gt 1) { throw "Configured SidewayRiskPercent is invalid: $SidewayRiskPercent" }
if ($SidewayMaxLot -lt 0.03 -or $SidewayMaxLot -gt 0.30) { throw "Configured SidewayMaxLot is invalid: $SidewayMaxLot" }
foreach ($managedLot in @($TrendFixedVolume, $SidewayMaxLot)) {
  $units = $managedLot / 0.03
  if ([math]::Abs($units - [math]::Round($units)) -gt 1e-8) { throw "Configured managed lot values must use 0.03 increments." }
}

if (-not [System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile = Join-Path $ProjectRoot $EnvFile }
if (-not (Test-Path $EnvFile)) { throw "Environment file not found: $EnvFile" }
$EnvFile = (Resolve-Path $EnvFile).Path

if (-not [System.IO.Path]::IsPathRooted($TelegramEnvFile)) { $TelegramEnvFile = Join-Path $ProjectRoot $TelegramEnvFile }
if (-not (Test-Path $TelegramEnvFile)) { throw "Telegram environment file not found: $TelegramEnvFile" }
$TelegramEnvFile = (Resolve-Path $TelegramEnvFile).Path

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace([string]$nodeCommand.Source)) {
  throw "node.exe was not found in the current Administrator PATH. Install/repair Node.js before startup conversion."
}
if ($null -eq $pnpmCommand -or [string]::IsNullOrWhiteSpace([string]$pnpmCommand.Source)) {
  throw "pnpm.cmd was not found in the current Administrator PATH. Install/repair pnpm before startup conversion."
}
$NodePath = (Resolve-Path ([string]$nodeCommand.Source)).Path
$PnpmPath = (Resolve-Path ([string]$pnpmCommand.Source)).Path
if (-not (Test-Path $NodePath -PathType Leaf)) { throw "Resolved node.exe path does not exist: $NodePath" }
if (-not (Test-Path $PnpmPath -PathType Leaf)) { throw "Resolved pnpm.cmd path does not exist: $PnpmPath" }

function Read-EnvValueFromFile([string]$Path, [string]$Name) {
  foreach ($raw in Get-Content -LiteralPath $Path) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $index = $line.IndexOf("=")
    $key = $line.Substring(0, $index).Trim().TrimStart([char]0xFEFF)
    if ($key -ne $Name) { continue }
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
  }
  return ""
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1) { throw "Task $TaskName must have exactly one action." }
$currentActionText = "$([string]$actions[0].Execute) $([string]$actions[0].Arguments)"
$currentIsMigrated = $currentActionText -like "*run-phase7c-executors-local.ps1*" -and $currentActionText -like "*-Armed*"
$currentIsStartupRunner = $currentActionText -like "*run-phase7c-executor-task-runner-local.ps1*"
if (-not $currentIsMigrated -and -not $currentIsStartupRunner) {
  throw "Task $TaskName is not a verified Phase 7C executor task. Refusing startup conversion."
}

$wasRunning = [string]$task.State -eq "Running"
$previousPrincipal = ([string]$task.Principal.UserId).Trim()
$previousLogonType = [string]$task.Principal.LogonType
$previousTriggerKinds = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ","

$apiKey = Read-EnvValueFromFile $EnvFile "MT5_API_KEY"
$bridgeHost = Read-EnvValueFromFile $EnvFile "MT5_BRIDGE_HOST"
$bridgePort = Read-EnvValueFromFile $EnvFile "MT5_BRIDGE_PORT"
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "MT5_API_KEY is missing from $EnvFile" }
if ([string]::IsNullOrWhiteSpace($bridgeHost)) { $bridgeHost = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($bridgePort)) { $bridgePort = "8765" }
$bridgeBase = "http://${bridgeHost}:${bridgePort}"
$headers = @{ "x-mt5-api-key" = $apiKey }

$health = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $headers -Method Get -TimeoutSec 5
if (-not $health.connected -or [string]$health.status -ne "ok") { throw "MT5 bridge must be healthy before executor task startup conversion." }
if ([string]$health.accountMode -ne "demo") { throw "Executor task startup conversion is DEMO-only. Current accountMode=$($health.accountMode)" }
$positionsResponse = Invoke-RestMethod -Uri "$bridgeBase/v1/positions?symbol=XAUUSD" -Headers $headers -Method Get -TimeoutSec 5
$positions = @($positionsResponse)
if ($positions.Count -gt 0) {
  $tickets = ($positions | ForEach-Object { $_.ticket }) -join ","
  throw "Executor task startup conversion requires zero open XAUUSD positions. Count=$($positions.Count), tickets=$tickets"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BackupPath) | Out-Null
if (-not (Test-Path $BackupPath)) {
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $BackupPath -Encoding Unicode
  Write-Host "PHASE7C_EXECUTOR_STARTUP_BACKUP=CREATED"
} else {
  Write-Host "PHASE7C_EXECUTOR_STARTUP_BACKUP=PRESERVED_EXISTING"
}

$config = [pscustomobject]@{
  version = 1
  workDir = $WorkDir
  controlApiUrl = $ControlApiUrl.TrimEnd('/')
  envFile = $EnvFile
  telegramEnvFile = $TelegramEnvFile
  nodePath = $NodePath
  pnpmPath = $PnpmPath
  trendFixedVolume = $TrendFixedVolume
  sidewayRiskPercent = $SidewayRiskPercent
  sidewayMaxLot = $SidewayMaxLot
  armed = $true
  demoOnly = $true
  updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ConfigPath -Encoding utf8

$taskCommand = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $TaskRunner)
if ($taskCommand.Length -gt 240) { throw "Executor startup task command is unexpectedly long ($($taskCommand.Length) chars)." }
if ($taskCommand -match "(?i)(MT5_(?:API|BRIDGE_API)_KEY\s*=|ZIQ_TELEGRAM_BOT_TOKEN\s*=|x-phase7c-token)") {
  throw "Refusing startup conversion because a secret-like value appears in task command."
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Stopper -WorkDir $WorkDir
if ($LASTEXITCODE -ne 0) { throw "Could not stop existing Phase 7C executors safely before startup conversion." }

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

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
Set-ScheduledTask -TaskName $TaskName -Settings $settings -ErrorAction Stop | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$registeredActions = @($registered.Actions)
if ($registeredActions.Count -ne 1) { throw "Executor startup task verification failed: expected one action." }
$registeredText = "$([string]$registeredActions[0].Execute) $([string]$registeredActions[0].Arguments)"
if ([string]$registeredActions[0].Execute -notmatch "powershell" -or $registeredText -notlike "*run-phase7c-executor-task-runner-local.ps1*") {
  throw "Executor startup task verification failed: action mismatch."
}
if ($registeredText -match "(?i)(MT5_(?:API|BRIDGE_API)_KEY\s*=|ZIQ_TELEGRAM_BOT_TOKEN\s*=|x-phase7c-token)") {
  throw "Executor startup task verification failed: secret-like value found in task command."
}
$bootTrigger = @($registered.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" })
if ($bootTrigger.Count -lt 1) { throw "Executor startup task verification failed: startup trigger missing." }
$registeredPrincipal = ([string]$registered.Principal.UserId).Trim()
if ($registeredPrincipal -notmatch '^(?i)(SYSTEM|NT AUTHORITY\\SYSTEM|S-1-5-18)$') {
  throw "Executor startup task principal is not SYSTEM: $registeredPrincipal"
}
$limitText = [string]$registered.Settings.ExecutionTimeLimit
try {
  $limit = if ($registered.Settings.ExecutionTimeLimit -is [TimeSpan]) {
    [TimeSpan]$registered.Settings.ExecutionTimeLimit
  } else {
    [System.Xml.XmlConvert]::ToTimeSpan($limitText)
  }
} catch {
  throw "Executor startup task ExecutionTimeLimit is not parseable: $limitText"
}
if ($limit -ne [TimeSpan]::Zero) { throw "Executor startup task ExecutionTimeLimit is not unlimited: $limitText" }

Write-Host "PHASE7C_EXECUTOR_STARTUP_UPGRADE=PASS"
Write-Host "PHASE7C_EXECUTOR_STARTUP_TASK_NAME=$TaskName"
Write-Host "PHASE7C_EXECUTOR_STARTUP_TRIGGER=AT_STARTUP"
Write-Host "PHASE7C_EXECUTOR_STARTUP_PRINCIPAL=SYSTEM"
Write-Host "PHASE7C_EXECUTOR_STARTUP_ACTION=PHASE7C_ARMED_TASK_RUNNER"
Write-Host "PHASE7C_EXECUTOR_STARTUP_DEMO_ONLY=True"
Write-Host "PHASE7C_EXECUTOR_STARTUP_OPEN_XAUUSD_POSITIONS=0"
Write-Host "PHASE7C_EXECUTOR_STARTUP_NODE_PATH=$NodePath"
Write-Host "PHASE7C_EXECUTOR_STARTUP_PNPM_PATH=$PnpmPath"
Write-Host "PHASE7C_EXECUTOR_STARTUP_EXECUTION_TIME_LIMIT=UNLIMITED"
Write-Host "PHASE7C_EXECUTOR_STARTUP_SECRETS_IN_ARGUMENTS=False"
Write-Host "PHASE7C_EXECUTOR_STARTUP_PREVIOUS_PRINCIPAL=$previousPrincipal"
Write-Host "PHASE7C_EXECUTOR_STARTUP_PREVIOUS_LOGON_TYPE=$previousLogonType"
Write-Host "PHASE7C_EXECUTOR_STARTUP_PREVIOUS_TRIGGERS=$previousTriggerKinds"
Write-Host "PHASE7C_EXECUTOR_STARTUP_CONFIG=$ConfigPath"
Write-Host "PHASE7C_EXECUTOR_STARTUP_BACKUP=$BackupPath"

if ($wasRunning -and -not $KeepStopped) {
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Start-Sleep -Seconds 8
  $after = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$after.State -ne "Running") {
    throw "Executor startup task did not remain Running after restoring previous running state. Current=$($after.State)"
  }
  Write-Host "PHASE7C_EXECUTOR_STARTUP_START=RESTORED_PREVIOUS_RUNNING"
  Write-Host "PHASE7C_EXECUTOR_STARTUP_TASK_STATE=$($after.State)"
} else {
  Write-Host "PHASE7C_EXECUTOR_STARTUP_START=SKIPPED"
  Write-Host "PHASE7C_EXECUTOR_STARTUP_TASK_STATE=$($registered.State)"
}
