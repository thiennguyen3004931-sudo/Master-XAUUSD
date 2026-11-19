param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [string]$TaskName = "XAUUSD-Phase7C-Executors"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TaskRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"

if (-not (Test-Path $TaskRunner)) { throw "Phase 7C executor task runner not found: $TaskRunner" }
if (-not (Test-Path $ConfigPath)) { throw "Phase 7C executor task config not found: $ConfigPath" }
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) { $WorkDir = Join-Path $ProjectRoot $WorkDir }
if (-not (Test-Path $WorkDir)) { throw "WorkDir not found: $WorkDir" }
$WorkDir = (Resolve-Path $WorkDir).Path

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([int]$config.version -ne 1) { throw "Executor task config version is unsupported." }
if (-not [bool]$config.demoOnly) { throw "Executor task config reports demoOnly=false." }
if (-not [bool]$config.armed) { throw "Executor task config reports armed=false." }
if ([string]$config.workDir -ne $WorkDir) { throw "Executor task config WorkDir mismatch: $($config.workDir)" }
if (-not (Test-Path ([string]$config.envFile))) { throw "Executor task config EnvFile not found: $($config.envFile)" }
if (-not (Test-Path ([string]$config.telegramEnvFile))) { throw "Executor task config TelegramEnvFile not found: $($config.telegramEnvFile)" }
if ([string]::IsNullOrWhiteSpace([string]$config.nodePath) -or -not (Test-Path ([string]$config.nodePath) -PathType Leaf)) {
  throw "Executor task config nodePath is missing/invalid: $($config.nodePath)"
}
if ([string]::IsNullOrWhiteSpace([string]$config.pnpmPath) -or -not (Test-Path ([string]$config.pnpmPath) -PathType Leaf)) {
  throw "Executor task config pnpmPath is missing/invalid: $($config.pnpmPath)"
}
if ($null -eq $config.trendFixedVolume -or [double]$config.trendFixedVolume -lt 0.03 -or [double]$config.trendFixedVolume -gt 0.30) {
  throw "Executor task config trendFixedVolume is missing/invalid."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1) { throw "Executor startup task must have exactly one action; found $($actions.Count)." }
$actionText = "$([string]$actions[0].Execute) $([string]$actions[0].Arguments)"
if ([string]$actions[0].Execute -notmatch "powershell" -or $actionText -notlike "*run-phase7c-executor-task-runner-local.ps1*") {
  throw "Executor startup task action does not match the expected Phase 7C task runner."
}
if ($actionText -match "(?i)(MT5_(?:API|BRIDGE_API)_KEY\s*=|ZIQ_TELEGRAM_BOT_TOKEN\s*=|x-phase7c-token)") {
  throw "Executor startup task action contains a secret-like value."
}

$bootTriggers = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskBootTrigger" })
$logonTriggers = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger" })
if ($bootTriggers.Count -lt 1) { throw "Executor startup task does not have an AtStartup trigger." }
if ($logonTriggers.Count -gt 0) { throw "Executor startup task still contains a Logon trigger." }

$principal = ([string]$task.Principal.UserId).Trim()
if ($principal -notmatch '^(?i)(SYSTEM|NT AUTHORITY\\SYSTEM|S-1-5-18)$') {
  throw "Executor startup task principal is not SYSTEM: $principal"
}
if ([string]$task.Principal.LogonType -ne "ServiceAccount") {
  throw "Executor startup task LogonType is not ServiceAccount: $($task.Principal.LogonType)"
}

$limitText = [string]$task.Settings.ExecutionTimeLimit
try {
  $limit = if ($task.Settings.ExecutionTimeLimit -is [TimeSpan]) {
    [TimeSpan]$task.Settings.ExecutionTimeLimit
  } else {
    [System.Xml.XmlConvert]::ToTimeSpan($limitText)
  }
} catch {
  throw "Executor startup task ExecutionTimeLimit is not parseable: $limitText"
}
if ($limit -ne [TimeSpan]::Zero) { throw "Executor startup task ExecutionTimeLimit is not unlimited: $limitText" }
if ([string]$task.State -ne "Running") { throw "Executor startup task is not Running. Current state=$($task.State)" }

Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_TASK_STATE=$($task.State)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_ACTION=PASS"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_TRIGGER=AT_STARTUP"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_LOGON_TRIGGER=False"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_PRINCIPAL=$principal"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_LOGON_TYPE=$($task.Principal.LogonType)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_NODE_PATH=$([string]$config.nodePath)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_PNPM_PATH=$([string]$config.pnpmPath)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_EXECUTION_TIME_LIMIT=UNLIMITED"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_SECRETS_IN_ARGUMENTS=False"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_CONFIG_DEMO_ONLY=$([bool]$config.demoOnly)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_CONFIG_ARMED=$([bool]$config.armed)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_TREND_FIXED_LOT=$([double]$config.trendFixedVolume)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_SIDEWAY_RISK_PERCENT=$([double]$config.sidewayRiskPercent)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_VERIFY_SIDEWAY_MAX_LOT=$([double]$config.sidewayMaxLot)"
Write-Host "PHASE7C_EXECUTOR_STARTUP_TASK_VERIFY=PASS"
