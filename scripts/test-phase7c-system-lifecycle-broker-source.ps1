$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LifecycleService = Join-Path $ProjectRoot "apps\api\src\services\phase7c-lifecycle.service.ts"
$BrokerService = Join-Path $ProjectRoot "apps\api\src\services\phase7c-lifecycle-broker.service.ts"
$BrokerRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
$ExecutorVerifier = Join-Path $PSScriptRoot "verify-phase7c-executors-local.ps1"

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

foreach ($required in @($LifecycleService, $BrokerRunner, $ExecutorVerifier)) {
  Assert-True (Test-Path -LiteralPath $required) "Missing lifecycle broker source dependency: $required"
}
Assert-PowerShellSyntax $BrokerRunner
Assert-PowerShellSyntax $ExecutorVerifier

$lifecycle = Get-Content -LiteralPath $LifecycleService -Raw
$runner = Get-Content -LiteralPath $BrokerRunner -Raw
$verifier = Get-Content -LiteralPath $ExecutorVerifier -Raw

# Web/API must become an unprivileged file-protocol client only.
Assert-True (Test-Path -LiteralPath $BrokerService) "Lifecycle broker client service must exist"
$brokerClient = Get-Content -LiteralPath $BrokerService -Raw
Assert-True ($lifecycle -match 'phase7c-lifecycle-broker\.service') "Lifecycle service must delegate privileged mutations to broker client"
foreach ($forbidden in @(
  'schtasks\.exe',
  'taskkill\.exe',
  'runStopper\s*\(',
  'launchSelectedSupervisor\s*\(',
  'run-phase7c-executors-local\.ps1'
)) {
  Assert-True (-not ($lifecycle -match $forbidden)) "Web lifecycle must not own privileged executor mutation; forbidden pattern=$forbidden"
}
Assert-True ($brokerClient -match 'phase7c-lifecycle-broker') "Broker client must use the dedicated lifecycle broker runtime"
Assert-True ($brokerClient -match 'inbox') "Broker client must write only through the broker inbox"
Assert-True ($brokerClient -match 'results') "Broker client must reconcile immutable per-request results"
Assert-True ($brokerClient -match 'requestId') "Broker client must correlate lifecycle results by requestId"
Assert-True ($brokerClient -match 'START') "Broker client must support START"
Assert-True ($brokerClient -match 'STOP') "Broker client must support STOP"
Assert-True ($brokerClient -match 'RESTART') "Broker client must support RESTART"
Assert-True ($brokerClient -match 'WEB_CONTROL_CENTER') "Broker client must use the closed source enum"
Assert-True (-not ($brokerClient -match '(?i)(commandLine|scriptPath|executablePath|powershell|taskkill|schtasks)')) "Broker request client must not expose arbitrary/elevated command fields"

# SYSTEM broker boot policy is fail-safe: alive broker, executors stopped, PAUSE.
Assert-True ($runner -match 'phase7c-lifecycle-broker') "SYSTEM runner must own the lifecycle broker runtime"
Assert-True ($runner -match 'inbox') "SYSTEM runner must consume broker inbox requests"
Assert-True ($runner -match 'results') "SYSTEM runner must persist request results"
Assert-True ($runner -match 'heartbeat') "SYSTEM runner must publish broker heartbeat"
Assert-True ($runner -match 'desiredExecutorState') "SYSTEM runner must track desired executor state"
Assert-True ($runner -match '(?i)STOPPED') "Broker must boot with desired executor state STOPPED"
Assert-True ($runner -match '(?i)IDLE') "Broker must expose IDLE state"
Assert-True ($runner -match '(?i)PAUSE') "Broker startup/recovery must enforce PAUSE"
Assert-True (-not ($runner -match '(?s)while\s*\(\$true\).*?Start-Process.*?run-phase7c-executors-local')) "Broker boot loop must not unconditionally launch the executor supervisor"

# STOP must not infer that executors are gone merely because canonical PID files
# disappeared. Production can retain live attested wrapper processes after PID-file
# cleanup, so the idempotent canonical stopper must still be allowed to reconcile them.
Assert-True (-not ($runner.Contains('return [pscustomobject]@{ success = $true; reasonCode = "NOOP_ALREADY_STOPPED"; message = "Executor runtime already stopped." }'))) "Lifecycle STOP must not return NOOP_ALREADY_STOPPED solely from missing PID files; canonical stopper reconciliation must run"

# START after a fresh broker/task generation is also an orphan-reconciliation boundary.
# The source-generation recovery path restarts the SYSTEM task and then sends START,
# so START must run the bounded canonical stopper before launching a new supervisor.
Assert-True ($runner -match '(?s)if\s*\(\$action\s*-eq\s*"START"\)\s*\{.*?\$preStartReconcile\s*=\s*Stop-Phase7CExecutorRuntime\s+\$config.*?if\s*\(-not\s+\$preStartReconcile\.success\).*?return.*?\}.*?\$startResult\s*=\s*Start-Phase7CExecutorRuntime\s+\$config') "Lifecycle START must reconcile bounded canonical orphan wrappers before launching a new supervisor"

# The migrated-task verifier must use the broker's fresh heartbeat as the runner-liveness authority.
# startup-runner-status.json belongs to the legacy runner and may legitimately contain a stale PID after migration.
Assert-True ($verifier -match 'phase7c-lifecycle-broker') "executor verifier must inspect the lifecycle broker runtime"
Assert-True ($verifier -match 'heartbeat\.json') "executor verifier must read broker heartbeat.json"
Assert-True ($verifier -match 'brokerPid') "executor verifier must use brokerPid from broker heartbeat"
Assert-True (-not ($verifier -match 'startupRunnerStatus\.runnerPid')) "migrated-task verifier must not use legacy startup-runner-status runnerPid as liveness authority"
Assert-True (-not ($verifier -match 'startup-runner-status\.json does not identify a live runner process')) "migrated-task verifier must not fail on a stale legacy startup-runner-status PID"

# Runtime READY must use the same canonical broker ownership proof as the verifier.
# A merely fresh heartbeat from an exited/replaced process must never make lifecycle.ready true.
Assert-True ($brokerClient -match 'isPidAlive') "Broker API readiness must verify that heartbeat brokerPid is a live process"
Assert-True ($brokerClient -match '(?s)heartbeat\?\.brokerPid.*status\?\.brokerPid|status\?\.brokerPid.*heartbeat\?\.brokerPid') "Broker API readiness must reconcile heartbeat brokerPid with status brokerPid"

# START must not succeed on one transient ready sample. Require an explicit continuous stable window
# before the lifecycle start flow reports READY and before LIVE ARM can consume runtimeReady=true.
Assert-True ($lifecycle -match 'START_READY_STABLE_MS') "Lifecycle START must define an explicit stable READY window"
Assert-True ($lifecycle -match '(?s)readySince.*START_READY_STABLE_MS') "waitForReady must require continuous READY for the stable window"

# Closed request protocol and core safety reason codes must be represented in SYSTEM source.
foreach ($requiredPattern in @(
  'REJECT_BROKER_BUSY',
  'REJECT_REQUEST_INVALID',
  'REJECT_REQUEST_STALE',
  'REJECT_REQUEST_DUPLICATE',
  'REJECT_OPEN_XAUUSD_POSITION',
  'REJECT_BOT_NOT_PAUSED',
  'REJECT_LIVE_AUTH_INVALID',
  'OK_STARTED',
  'OK_STOPPED',
  'OK_RESTARTED'
)) {
  Assert-True ($runner -match $requiredPattern) "SYSTEM broker must expose canonical contract token=$requiredPattern"
}

# RESTART is a two-boundary mutation: after STOP and config reload, safety must be
# re-probed immediately before START so account/MT5/trading changes fail closed.
Assert-True ($runner -match '(?s)# Critical: re-read task/account/lot configuration after stop and before launch\.\s*\$config\s*=\s*Read-Phase7CCanonicalLaunchConfig\s*\$script:accountMode\s*=\s*\[string\]\$config\.accountMode\s*\$postStopContext\s*=\s*Get-BrokerSafetyContext\s+\$config\s*\$postStopGate\s*=\s*Test-Phase7CLifecycleBrokerSafetyGate\s+-Action\s+"START"\s+-Context\s+\$postStopContext') "RESTART must re-run the START safety gate after STOP/config reload and before launching the supervisor"

# Lifecycle START/RESTART must not invent or require session ARM. AUTO ARM stays elsewhere.
Assert-True (-not ($runner -match 'REJECT_LIVE_ARM_INVALID')) "Lifecycle broker must not require session LIVE ARM for START/RESTART"

# Synthetic bookkeeping regression: execute the production Set-BrokerState function in isolation.
# A successful PAUSE-only recovery may change current state semantics, but it must not overwrite
# the audit semantics of the most recently handled STOP request.
$astTokens = $null
$astErrors = $null
$runnerAst = [System.Management.Automation.Language.Parser]::ParseFile($BrokerRunner, [ref]$astTokens, [ref]$astErrors)
Assert-Equal $astErrors.Count 0 "runner AST must parse for lifecycle status consistency harness"
$setBrokerStateAst = $runnerAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Set-BrokerState"
}, $true)
Assert-True ($null -ne $setBrokerStateAst) "production Set-BrokerState function must exist"

function Write-BrokerStatus {}
function Write-BrokerHeartbeat {}
Invoke-Expression $setBrokerStateAst.Extent.Text

$script:brokerState = "BLOCKED"
$script:lastHandledAction = "STOP"
$script:lastResult = "FAILED"
$script:lastReasonCode = "FAIL_STOP_TIMEOUT"
$script:stateReasonCode = $null
$script:lastError = "Executor stop exceeded 25 seconds."

Set-BrokerState "RUNNING" "OK_STARTED"

Assert-Equal $script:brokerState "RUNNING" "recovery must update current broker state"
Assert-Equal $script:lastHandledAction "STOP" "recovery must preserve last handled action audit"
Assert-Equal $script:lastResult "FAILED" "recovery must preserve last request result audit"
Assert-Equal $script:lastReasonCode "FAIL_STOP_TIMEOUT" "recovery state reason must not overwrite last request reason audit"
Assert-Equal $script:stateReasonCode "OK_STARTED" "recovery must expose its current-state reason separately"

Write-Host "PHASE7C_SYSTEM_LIFECYCLE_BROKER_SOURCE_TEST=PASS"
