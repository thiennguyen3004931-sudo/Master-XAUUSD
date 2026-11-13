$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BrokerRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
$ExecutorSupervisor = Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1"

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message actual=$Actual expected=$Expected" }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

foreach ($required in @($BrokerRunner, $ExecutorSupervisor)) {
  Assert-True (Test-Path -LiteralPath $required) "Missing per-attempt lifecycle log dependency: $required"
  Assert-PowerShellSyntax $required
}

$runner = Get-Content -LiteralPath $BrokerRunner -Raw
$supervisor = Get-Content -LiteralPath $ExecutorSupervisor -Raw

# Every invocation of Start-Phase7CExecutorRuntime must allocate fresh log evidence.
$runnerTokens = $null
$runnerErrors = $null
$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile($BrokerRunner, [ref]$runnerTokens, [ref]$runnerErrors)
Assert-Equal $runnerErrors.Count 0 "runner AST must parse for per-attempt lifecycle log contract"
$newAttemptAst = $runnerAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "New-Phase7CAttemptLogDirectory"
}, $true)
Assert-True ($null -ne $newAttemptAst) "production New-Phase7CAttemptLogDirectory helper must exist"

# Execute the production allocator in isolation: two attempts may never share a directory.
$attemptHarnessRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-attempt-log-test-" + [Guid]::NewGuid().ToString("N"))
$attemptsRoot = Join-Path $attemptHarnessRoot "attempts"
try {
  Invoke-Expression $newAttemptAst.Extent.Text
  $attempt1 = New-Phase7CAttemptLogDirectory
  $attempt2 = New-Phase7CAttemptLogDirectory

  Assert-True (Test-Path -LiteralPath $attempt1 -PathType Container) "first lifecycle attempt directory must exist"
  Assert-True (Test-Path -LiteralPath $attempt2 -PathType Container) "second lifecycle attempt directory must exist"
  Assert-True (-not [string]::Equals([string]$attempt1, [string]$attempt2, [System.StringComparison]::OrdinalIgnoreCase)) "lifecycle attempts must receive unique directories"
  Assert-Equal (Split-Path -Parent $attempt1) $attemptsRoot "first lifecycle attempt must live under canonical attempts root"
  Assert-Equal (Split-Path -Parent $attempt2) $attemptsRoot "second lifecycle attempt must live under canonical attempts root"
} finally {
  Remove-Item -LiteralPath $attemptHarnessRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Explicit START and automatic recovery both call the same allocator-owning launch function.
Assert-True ($runner -match '(?s)function\s+Start-Phase7CExecutorRuntime\s*\([^)]*\).*?New-Phase7CAttemptLogDirectory') "Start-Phase7CExecutorRuntime must allocate a fresh attempt directory on every invocation"
Assert-True ($runner -match '(?s)function\s+Recover-SupervisorIfNeeded.*?Start-Phase7CExecutorRuntime\s+\$config') "supervisor recovery must launch through the same per-attempt runtime path"
Assert-True ($runner -match '"-AttemptLogDir"') "broker runner must pass the allocated attempt log directory to the supervisor"
Assert-True ($runner -match '\$supervisorOut\s*=\s*Join-Path\s+\$attemptLogDir\s+"startup-supervisor\.out\.log"') "supervisor stdout must be scoped to the current attempt directory"
Assert-True ($runner -match '\$supervisorErr\s*=\s*Join-Path\s+\$attemptLogDir\s+"startup-supervisor\.err\.log"') "supervisor stderr must be scoped to the current attempt directory"

# The supervisor must place every child stdout/stderr file in that same attempt directory.
Assert-True ($supervisor -match '\[string\]\$AttemptLogDir') "executor supervisor must accept AttemptLogDir"
foreach ($logBinding in @{
  TrendOut = 'trend\.out\.log'
  TrendErr = 'trend\.err\.log'
  SidewayOut = 'sideway\.out\.log'
  SidewayErr = 'sideway\.err\.log'
  TelegramModeOut = 'telegram-mode\.out\.log'
  TelegramModeErr = 'telegram-mode\.err\.log'
  RegimeNotifierOut = 'regime-notifier\.out\.log'
  RegimeNotifierErr = 'regime-notifier\.err\.log'
  TradeNotifierOut = 'trade-notifier\.out\.log'
  TradeNotifierErr = 'trade-notifier\.err\.log'
}.GetEnumerator()) {
  $pattern = '\$' + [regex]::Escape([string]$logBinding.Key) + '\s*=\s*Join-Path\s+\$AttemptLogDir\s+"' + [string]$logBinding.Value + '"'
  Assert-True ($supervisor -match $pattern) "child log must use AttemptLogDir: $($logBinding.Key)"
}

# Canonical runtime state remains canonical/current; only evidence logs are per-attempt.
foreach ($canonicalPid in @(
  'SupervisorPidPath',
  'TrendPidPath',
  'SidewayPidPath',
  'TelegramModePidPath',
  'RegimeNotifierPidPath',
  'TradeNotifierPidPath'
)) {
  $pattern = '\$' + [regex]::Escape($canonicalPid) + '\s*=\s*Join-Path\s+\$RuntimeDir\s+"[^"]+\.pid"'
  Assert-True ($supervisor -match $pattern) "canonical PID path must remain under RuntimeDir: $canonicalPid"
}
Assert-True ($supervisor -match '\$TradeNotifierRuntimePath\s*=\s*Join-Path\s+\$RuntimeDir\s+"trade-notifier-runtime\.json"') "trade notifier runtime state must remain canonical"
Assert-True ($supervisor -match '\$ActiveLotSettingsPath\s*=\s*Join-Path\s+\$RuntimeDir\s+"active-lot-settings\.json"') "active lot settings must remain canonical/current"

Write-Host "PHASE7C_PER_ATTEMPT_LIFECYCLE_LOGS_SOURCE_TEST=PASS"
