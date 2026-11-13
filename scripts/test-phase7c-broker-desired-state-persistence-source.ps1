$ErrorActionPreference = "Stop"

$BrokerRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
if (-not (Test-Path -LiteralPath $BrokerRunner)) {
  throw "Missing lifecycle broker runner: $BrokerRunner"
}

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message actual=$Actual expected=$Expected" }
}

$tokens = $null
$errors = $null
$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile($BrokerRunner, [ref]$tokens, [ref]$errors)
Assert-Equal @($errors).Count 0 "Broker runner must parse before desired-state contract inspection"
$runner = Get-Content -LiteralPath $BrokerRunner -Raw

# Durable intent lives under the broker state directory and is independent from
# volatile status/heartbeat snapshots.
Assert-True ($runner -match '\$desiredExecutorStatePath\s*=\s*Join-Path\s+\$stateDir\s+"desired-executor-state\.json"') "Broker must define a dedicated durable desired-executor-state file"

$readDesiredStateAst = $runnerAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Read-DurableDesiredExecutorState"
}, $true)
$writeDesiredStateAst = $runnerAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Write-DurableDesiredExecutorState"
}, $true)
$existingSupervisorAst = $runnerAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Get-Phase7CExistingSupervisorPid"
}, $true)
Assert-True ($null -ne $readDesiredStateAst) "Broker must define Read-DurableDesiredExecutorState"
Assert-True ($null -ne $writeDesiredStateAst) "Broker must define Write-DurableDesiredExecutorState"
Assert-True ($null -ne $existingSupervisorAst) "Broker must define Get-Phase7CExistingSupervisorPid for cold-start adoption"

# Cold-start must force PAUSE before durable intent is restored. Existing
# Recover-SupervisorIfNeeded remains the only restoration launcher.
Assert-True ($runner -match '(?s)Ensure-Phase7CBotPause\s+"system-lifecycle-broker-boot".*?Read-DurableDesiredExecutorState') "Broker cold-start must force PAUSE before restoring durable desired state"
Assert-True ($runner -match '(?s)while\s*\(\$true\).*?Recover-SupervisorIfNeeded') "Broker must retain the canonical recovery loop"

# A broker cold-start loses the in-memory supervisor PID while the canonical
# supervisor/process tree can still be alive. Durable RUNNING must first adopt a
# proven canonical survivor instead of launching a duplicate supervisor, but only
# after recovery has positively confirmed PAUSE.
Assert-True ($runner -match '(?s)function\s+Get-Phase7CExistingSupervisorPid.*?supervisor\.pid.*?Get-Process.*?Get-CimInstance\s+Win32_Process.*?run-phase7c-executors-local\.ps1') "Existing-supervisor adoption must verify live PID evidence and canonical PowerShell command line"
Assert-True ($runner -match '(?s)function\s+Recover-SupervisorIfNeeded.*?Get-Phase7CExistingSupervisorPid.*?\$script:supervisorPid\s*=.*?Set-BrokerState\s+"RUNNING".*?return.*?Start-Phase7CExecutorRuntime') "Recovery must adopt a proven surviving supervisor before any new supervisor launch"
Assert-True ($runner -match '(?s)function\s+Recover-SupervisorIfNeeded.*?Ensure-Phase7CBotPause\s+"system-lifecycle-broker-recovery".*?Get-Phase7CExistingSupervisorPid') "Recovery must confirm PAUSE before adopting a surviving supervisor"

# Persist successful operator intent before publishing successful/idempotent request completion.
Assert-True ($runner -match '(?s)if\s*\(\$action\s*-eq\s*"STOP"\).*?Write-DurableDesiredExecutorState\s+"STOPPED".*?\$script:desiredExecutorState\s*=\s*"STOPPED".*?Complete-Request') "Successful STOP must persist STOPPED before request completion"
Assert-True ($runner -match '(?s)if\s*\(\$action\s*-eq\s*"START"\s*-and\s*\(Test-SupervisorAlive\)\).*?Write-DurableDesiredExecutorState\s+"RUNNING".*?\$script:desiredExecutorState\s*=\s*"RUNNING".*?Complete-Request') "Idempotent START must persist RUNNING before NOOP completion"
Assert-True ($runner -match '(?s)\$startResult\s*=\s*Start-Phase7CExecutorRuntime\s+\$config.*?if\s*\(-not\s+\$startResult\.success\).*?return.*?Write-DurableDesiredExecutorState\s+"RUNNING".*?\$script:desiredExecutorState\s*=\s*"RUNNING".*?\$reasonCode\s*=.*?Complete-Request') "Successful START/RESTART must persist RUNNING before request completion"

# There are exactly three durable writes in request handling: STOP success/NOOP,
# START already-running NOOP, and common successful START/RESTART. Rejected/failed
# request paths must never write a false success intent.
$writeCommands = @($runnerAst.FindAll({
  param($node)
  if (-not ($node -is [System.Management.Automation.Language.CommandAst])) { return $false }
  if ($node.CommandElements.Count -lt 1) { return $false }
  return [string]$node.CommandElements[0].Value -eq "Write-DurableDesiredExecutorState"
}, $true))
Assert-Equal $writeCommands.Count 3 "Broker request handling must have exactly three durable desired-state writes"
$writeStates = @($writeCommands | ForEach-Object {
  if ($_.CommandElements.Count -lt 2) { return "" }
  return [string]$_.CommandElements[1].Value
})
Assert-Equal @($writeStates | Where-Object { $_ -eq "STOPPED" }).Count 1 "Exactly one durable STOPPED write is allowed"
Assert-Equal @($writeStates | Where-Object { $_ -eq "RUNNING" }).Count 2 "Exactly two durable RUNNING writes are allowed"

# Execute the production reader/writer functions in isolation to prove fail-closed behavior.
function Append-BrokerLog([string]$Message) {}
function Write-Phase7CJsonAtomic {
  param(
    [string]$Path,
    $Value,
    [int]$Depth = 6
  )
  $json = $Value | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}
Invoke-Expression $readDesiredStateAst.Extent.Text
Invoke-Expression $writeDesiredStateAst.Extent.Text

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-desired-state-contract-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$script:desiredExecutorStatePath = Join-Path $tempRoot "desired-executor-state.json"
try {
  Assert-Equal (Read-DurableDesiredExecutorState) "STOPPED" "Missing durable intent must fail closed"

  [System.IO.File]::WriteAllText($script:desiredExecutorStatePath, "{broken-json", (New-Object System.Text.UTF8Encoding($false)))
  Assert-Equal (Read-DurableDesiredExecutorState) "STOPPED" "Corrupt durable intent must fail closed"

  @{ version = 2; desiredExecutorState = "RUNNING" } | ConvertTo-Json | Set-Content -LiteralPath $script:desiredExecutorStatePath -Encoding UTF8
  Assert-Equal (Read-DurableDesiredExecutorState) "STOPPED" "Unsupported durable intent version must fail closed"

  @{ version = 1; desiredExecutorState = "SIDEWAYS" } | ConvertTo-Json | Set-Content -LiteralPath $script:desiredExecutorStatePath -Encoding UTF8
  Assert-Equal (Read-DurableDesiredExecutorState) "STOPPED" "Unknown durable intent value must fail closed"

  @{ version = 1; desiredExecutorState = "running" } | ConvertTo-Json | Set-Content -LiteralPath $script:desiredExecutorStatePath -Encoding UTF8
  Assert-Equal (Read-DurableDesiredExecutorState) "RUNNING" "Valid RUNNING durable intent must restore"

  @{ version = 1; desiredExecutorState = "stopped" } | ConvertTo-Json | Set-Content -LiteralPath $script:desiredExecutorStatePath -Encoding UTF8
  Assert-Equal (Read-DurableDesiredExecutorState) "STOPPED" "Valid STOPPED durable intent must restore"

  Write-DurableDesiredExecutorState "RUNNING"
  $persisted = Get-Content -LiteralPath $script:desiredExecutorStatePath -Raw | ConvertFrom-Json
  Assert-Equal ([int]$persisted.version) 1 "Durable intent schema version must remain 1"
  Assert-Equal ([string]$persisted.desiredExecutorState) "RUNNING" "Durable writer must persist normalized RUNNING"

  $invalidWriteRejected = $false
  try { Write-DurableDesiredExecutorState "UNKNOWN" } catch { $invalidWriteRejected = $true }
  Assert-True $invalidWriteRejected "Durable writer must reject values outside RUNNING/STOPPED"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "PHASE7C_BROKER_DESIRED_STATE_PERSISTENCE_SOURCE_TEST=PASS"