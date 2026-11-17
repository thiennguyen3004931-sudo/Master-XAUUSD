$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReconcilePath = Join-Path $PSScriptRoot 'reconcile-phase7c-stopped-lifecycle-broker-provenance-local.ps1'

if (-not (Test-Path -LiteralPath $ReconcilePath -PathType Leaf)) {
  throw "RED: broker-only provenance reconciliation entrypoint is missing: $ReconcilePath"
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ReconcilePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "PowerShell syntax error in ${ReconcilePath}: $($errors[0].Message)"
}

$source = (Get-Content -LiteralPath $ReconcilePath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")

function Assert-ContainsLiteral {
  param([string]$Literal, [string]$Message)
  if ($source.IndexOf($Literal, [System.StringComparison]::Ordinal) -lt 0) {
    throw "RED: $Message missing=$Literal"
  }
}

function Assert-NotContainsLiteral {
  param([string]$Literal, [string]$Message)
  if ($source.IndexOf($Literal, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    throw "RED: $Message forbidden=$Literal"
  }
}

# Exact operator inputs and source/deployment identity.
foreach ($literal in @(
  '[string]$TaskName = ''XAUUSD-Phase7C-Executors''',
  '[string]$ExpectedCommit',
  '[string]$ExpectedTree',
  '[string]$ExpectedDeploymentId',
  '[int]$TimeoutSeconds = 30',
  'PHASE7C_BROKER_RECONCILE_GIT_GUARD=PASS',
  'PHASE7C_BROKER_RECONCILE_DEPLOYMENT_GUARD=PASS'
)) {
  Assert-ContainsLiteral $literal 'Exact source/deployment contract'
}

# Reuse canonical trust primitives rather than inventing another ownership model.
foreach ($literal in @(
  'phase7c-scheduled-task-ownership.ps1',
  'phase7c-runtime-ownership-probe.ps1',
  'phase7c-runtime-source-attestation.ps1',
  'Get-Phase7CTrustedGitFileSha256',
  'Test-Phase7CExecutorTaskActionOwnership',
  'Get-Phase7CExecutorTaskDrift',
  'Get-Phase7CRuntimeGenerationSnapshot',
  'Read-Phase7CRuntimeSourceDeployment'
)) {
  Assert-ContainsLiteral $literal 'Canonical trust primitive'
}

# Preflight must be GET-only for application/bridge state and must prove the stopped/flat envelope.
foreach ($literal in @(
  '-Method Get',
  '/api/v1/phase7c/bot-mode',
  '/api/v1/phase7c-live-arm-control/capability',
  '/api/v1/phase7c/lifecycle',
  '/api/v1/phase7c/runtime-source-attestation',
  '/v1/positions?symbol=XAUUSD',
  '/v1/orders?symbol=XAUUSD',
  '/health',
  'PHASE7C_BROKER_RECONCILE_PREFLIGHT_MODE=PAUSE',
  'PHASE7C_BROKER_RECONCILE_PREFLIGHT_ARM=DISARMED',
  'PHASE7C_BROKER_RECONCILE_PREFLIGHT_LIFECYCLE=STOPPED',
  'PHASE7C_BROKER_RECONCILE_PREFLIGHT_POSITIONS=0',
  'PHASE7C_BROKER_RECONCILE_PREFLIGHT_PENDING_ORDERS=0',
  'PHASE7C_BROKER_RECONCILE_PREFLIGHT_BRIDGE=PASS'
)) {
  Assert-ContainsLiteral $literal 'Stopped-lifecycle safety preflight'
}

# Attestation classification must be exact: API/Web active exact, broker live provenance-only mismatch,
# and inactive lifecycle components stale/dead. Unknown or non-provenance broker mismatches must fail closed.
foreach ($literal in @(
  'API_ATTESTATION=EXACT_MATCH',
  'WEB_ATTESTATION=EXACT_MATCH',
  'BROKER_ATTESTATION=MISMATCH_PROVENANCE_ONLY',
  'SOURCE_COMMIT_MISMATCH',
  'SOURCE_TREE_MISMATCH',
  'DEPLOYMENT_ID_MISMATCH',
  'supervisor',
  'trend',
  'sideway',
  'telegram',
  'regime-notifier',
  'INACTIVE_ATTESTATIONS=STALE_DEAD'
)) {
  Assert-ContainsLiteral $literal 'Runtime-source attestation classification'
}

# Regression: PowerShell nullable parameters are represented as either $null or an unboxed Int32.
# Execute the actual Assert-ApiWebExact function body from the production AST so a .HasValue/.Value
# access fails exactly as it did in the production preflight before any Scheduled Task mutation.
$assertApiWebAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-ApiWebExact'
}, $true)
if ($null -eq $assertApiWebAst) {
  throw 'RED: Assert-ApiWebExact function is missing from reconciliation entrypoint.'
}

$assertApiWebSource = $assertApiWebAst.Extent.Text
& {
  param([string]$FunctionSource)
  Set-StrictMode -Version Latest

  function Get-AttestationComponent($Snapshot, [string]$Name) {
    $matches = @($Snapshot.components | Where-Object { [string]$_.component -eq $Name })
    if ($matches.Count -ne 1) { throw "Expected one component named $Name." }
    return $matches[0]
  }

  Invoke-Expression $FunctionSource
  $snapshot = [pscustomobject]@{
    components = @(
      [pscustomobject]@{ component = 'api'; verdict = 'EXACT_MATCH'; alive = $true; pid = 101 },
      [pscustomobject]@{ component = 'web'; verdict = 'EXACT_MATCH'; alive = $true; pid = 202 }
    )
  }

  [void](Assert-ApiWebExact -Snapshot $snapshot -ExpectedApiPid $null -ExpectedWebPid $null)
  [void](Assert-ApiWebExact -Snapshot $snapshot -ExpectedApiPid 101 -ExpectedWebPid 202)
} $assertApiWebSource

# Canonical task/generation proof before mutation.
foreach ($literal in @(
  'SYSTEM',
  'ServiceAccount',
  'Highest',
  'TASK_OWNERSHIP=CANONICAL',
  'TASK_DRIFT=NONE',
  'BROKER_HEARTBEAT_FRESH=TRUE',
  'STARTUP_RUNNER_LOCK=HELD'
)) {
  Assert-ContainsLiteral $literal 'Canonical Scheduled Task ownership/generation gate'
}

# The only intended mutation is stop/start of the same canonical Scheduled Task.
$stopLiteral = 'Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop'
$startLiteral = 'Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop'
Assert-ContainsLiteral $stopLiteral 'Canonical task stop'
Assert-ContainsLiteral $startLiteral 'Canonical task start'
Assert-ContainsLiteral 'BROKER_PREVIOUS_PID_EXIT=PASS' 'Previous broker exit proof'
Assert-ContainsLiteral 'BROKER_NEW_PID=PASS' 'Fresh broker PID proof'
Assert-ContainsLiteral 'ORPHAN_QUEUED_RETRY=ONCE' 'Bounded known-safe queued retry'

$stopIndex = $source.IndexOf($stopLiteral, [System.StringComparison]::Ordinal)
$startIndex = $source.IndexOf($startLiteral, [System.StringComparison]::Ordinal)
if ($stopIndex -lt 0 -or $startIndex -le $stopIndex) {
  throw 'RED: canonical Scheduled Task START must occur after STOP in the normal running-broker path.'
}

# Regression: Windows can prove the canonical task quiesced, the old PID disappeared, and the startup
# lock released while the read-only API still reports the same just-dead old PID as MISMATCH/alive.
# That API liveness lag must not create a second hard wait after the stronger local stop proof.
# The transition attestation gate must accept either STALE/dead or the exact same old PID retaining
# only the already-approved provenance mismatch reasons. Any PID change, UNKNOWN state, or new reason
# must still fail closed.
$transitionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Assert-StoppedTransitionAttestation'
}, $true)
if ($null -eq $transitionAst) {
  throw 'RED: stopped transition attestation helper is missing.'
}

$transitionSource = $transitionAst.Extent.Text
if ($transitionSource.IndexOf('Assert-DeploymentAttestationIdentity -Snapshot $Snapshot', [System.StringComparison]::Ordinal) -lt 0) {
  throw 'RED: stopped transition helper must retain the accepted deployment identity guard.'
}

& {
  param([string]$FunctionSource)
  Set-StrictMode -Version Latest

  # The deployment guard is tested as a separate production helper and is required above by exact AST literal.
  # This behavior harness isolates only the broker transition classifier while retaining the dependency boundary.
  function Assert-DeploymentAttestationIdentity($Snapshot) {
    if ($null -eq $Snapshot) { throw 'Deployment evidence missing.' }
  }
  function Get-AttestationComponent($Snapshot, [string]$Name) {
    $matches = @($Snapshot.components | Where-Object { [string]$_.component -eq $Name })
    if ($matches.Count -ne 1) { throw "Expected one component named $Name." }
    return $matches[0]
  }
  function Assert-ApiWebExact($Snapshot, [Nullable[int]]$ExpectedApiPid, [Nullable[int]]$ExpectedWebPid) {
    $api = Get-AttestationComponent -Snapshot $Snapshot -Name 'api'
    $web = Get-AttestationComponent -Snapshot $Snapshot -Name 'web'
    if ([string]$api.verdict -ne 'EXACT_MATCH' -or $api.alive -ne $true -or [int]$api.pid -ne [int]$ExpectedApiPid) { throw 'API drift' }
    if ([string]$web.verdict -ne 'EXACT_MATCH' -or $web.alive -ne $true -or [int]$web.pid -ne [int]$ExpectedWebPid) { throw 'Web drift' }
  }
  function Assert-InactiveAttestations($Snapshot) {
    foreach ($name in @('supervisor', 'trend', 'sideway', 'telegram', 'regime-notifier')) {
      $component = Get-AttestationComponent -Snapshot $Snapshot -Name $name
      if ([string]$component.verdict -ne 'STALE' -or $component.alive -ne $false) { throw 'Inactive drift' }
    }
  }

  Invoke-Expression $FunctionSource

  function New-TransitionSnapshot([string]$BrokerVerdict, [bool]$BrokerAlive, [int]$BrokerPid, [object[]]$BrokerReasons) {
    return [pscustomobject]@{
      components = @(
        [pscustomobject]@{ component = 'api'; verdict = 'EXACT_MATCH'; alive = $true; pid = 101 },
        [pscustomobject]@{ component = 'web'; verdict = 'EXACT_MATCH'; alive = $true; pid = 202 },
        [pscustomobject]@{ component = 'lifecycle-broker'; verdict = $BrokerVerdict; alive = $BrokerAlive; pid = $BrokerPid; reasonCodes = $BrokerReasons },
        [pscustomobject]@{ component = 'supervisor'; verdict = 'STALE'; alive = $false; pid = 401 },
        [pscustomobject]@{ component = 'trend'; verdict = 'STALE'; alive = $false; pid = 402 },
        [pscustomobject]@{ component = 'sideway'; verdict = 'STALE'; alive = $false; pid = 403 },
        [pscustomobject]@{ component = 'telegram'; verdict = 'STALE'; alive = $false; pid = 404 },
        [pscustomobject]@{ component = 'regime-notifier'; verdict = 'STALE'; alive = $false; pid = 405 }
      )
    }
  }

  $stale = New-TransitionSnapshot -BrokerVerdict 'STALE' -BrokerAlive $false -BrokerPid 303 -BrokerReasons @('ATTESTED_PID_DEAD')
  $staleResult = Assert-StoppedTransitionAttestation -Snapshot $stale -ExpectedApiPid 101 -ExpectedWebPid 202 -ExpectedBrokerPid 303
  if ([string]$staleResult -ne 'STALE_DEAD') { throw "Expected STALE_DEAD transition, actual=$staleResult" }

  $lag = New-TransitionSnapshot -BrokerVerdict 'MISMATCH' -BrokerAlive $true -BrokerPid 303 -BrokerReasons @('SOURCE_COMMIT_MISMATCH','SOURCE_TREE_MISMATCH','DEPLOYMENT_ID_MISMATCH')
  $lagResult = Assert-StoppedTransitionAttestation -Snapshot $lag -ExpectedApiPid 101 -ExpectedWebPid 202 -ExpectedBrokerPid 303
  if ([string]$lagResult -ne 'API_LIVENESS_LAG') { throw "Expected API_LIVENESS_LAG transition, actual=$lagResult" }

  $pidChanged = New-TransitionSnapshot -BrokerVerdict 'MISMATCH' -BrokerAlive $true -BrokerPid 304 -BrokerReasons @('SOURCE_COMMIT_MISMATCH')
  $pidChangedFailed = $false
  try { [void](Assert-StoppedTransitionAttestation -Snapshot $pidChanged -ExpectedApiPid 101 -ExpectedWebPid 202 -ExpectedBrokerPid 303) }
  catch { $pidChangedFailed = $true }
  if (-not $pidChangedFailed) { throw 'Expected changed broker PID to fail closed.' }

  $badReason = New-TransitionSnapshot -BrokerVerdict 'MISMATCH' -BrokerAlive $true -BrokerPid 303 -BrokerReasons @('PID_MISMATCH')
  $badReasonFailed = $false
  try { [void](Assert-StoppedTransitionAttestation -Snapshot $badReason -ExpectedApiPid 101 -ExpectedWebPid 202 -ExpectedBrokerPid 303) }
  catch { $badReasonFailed = $true }
  if (-not $badReasonFailed) { throw 'Expected non-provenance mismatch reason to fail closed.' }

  $unknown = New-TransitionSnapshot -BrokerVerdict 'UNKNOWN' -BrokerAlive $false -BrokerPid 303 -BrokerReasons @('EVIDENCE_INVALID')
  $unknownFailed = $false
  try { [void](Assert-StoppedTransitionAttestation -Snapshot $unknown -ExpectedApiPid 101 -ExpectedWebPid 202 -ExpectedBrokerPid 303) }
  catch { $unknownFailed = $true }
  if (-not $unknownFailed) { throw 'Expected UNKNOWN transition to fail closed.' }
} $transitionSource

Assert-NotContainsLiteral 'Timed out waiting for stopped lifecycle-broker attestation to converge to STALE/dead.' 'Reconciliation must not require API liveness convergence after local stop proof'
Assert-NotContainsLiteral 'Wait-StoppedBrokerAttestation -ExpectedApiPid $apiPidBefore -ExpectedWebPid $webPidBefore -Seconds $TimeoutSeconds' 'Reconciliation must not insert a second bounded API liveness wait between proven STOP and START'
Assert-ContainsLiteral 'PHASE7C_BROKER_RECONCILE_STOPPED_TRANSITION=' 'Stopped transition classification log'

# Midpoint recovery regression: a prior fail-closed run can leave the canonical task Ready with the old
# broker dead, heartbeat stale, and startup lock released. The same script must be able to resume from
# that already-proven midpoint without requiring an artificial live broker first. Eligibility is strict:
# canonical task has no active/queued instance, no canonical task process exists, runtime generation is
# dead/stale/released, and the raw old broker attestation differs from the accepted deployment only by
# source/deployment provenance while retaining canonical component/launcher/config identity.
$midpointAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Test-StoppedMidpointEligible'
}, $true)
if ($null -eq $midpointAst) {
  throw 'RED: stopped midpoint eligibility helper is missing.'
}

$midpointSource = $midpointAst.Extent.Text
& {
  param([string]$FunctionSource)
  Set-StrictMode -Version Latest

  function Normalize-Phase7CRunnerSha256 {
    param([Parameter(Mandatory = $true)] [string]$Sha256)
    $value = ([string]$Sha256).Trim().ToUpperInvariant()
    if ($value -notmatch '^[0-9A-F]{64}$') {
      throw "Runner SHA256 must be exactly 64 hexadecimal characters. value=$Sha256"
    }
    return $value
  }

  Invoke-Expression $FunctionSource

  $runnerSha256 = 'A' * 64
  $task = [pscustomobject]@{ State = 'Ready' }
  $generation = [pscustomobject]@{
    statusReadState = 'OK'
    heartbeatReadState = 'OK'
    brokerStatusPidMatch = $true
    brokerProcessAlive = $false
    brokerHeartbeatFresh = $false
    startupRunnerLockState = 'RELEASED'
    statusBrokerPid = 9388
  }
  $deployment = [pscustomobject]@{
    deploymentId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    sourceCommit = '1111111111111111111111111111111111111111'
    sourceTree = '2222222222222222222222222222222222222222'
    configFingerprint = 'sha256:' + ('3' * 64)
  }
  $old = [pscustomobject]@{
    component = 'lifecycle-broker'
    deploymentId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    sourceCommit = '4444444444444444444444444444444444444444'
    sourceTree = '5555555555555555555555555555555555555555'
    pid = 9388
    launcherSha256 = 'sha256:' + ('a' * 64)
    configFingerprint = $deployment.configFingerprint
  }

  $eligible = Test-StoppedMidpointEligible -Task $task -Generation $generation -BrokerAttestation $old -Deployment $deployment -RunnerSha256 $runnerSha256 -CanonicalProcessCount 0 -RunningTaskInstanceCount 0
  if (-not $eligible) { throw 'Expected proven stopped midpoint tuple to be eligible.' }

  $generation.brokerProcessAlive = $true
  if (Test-StoppedMidpointEligible -Task $task -Generation $generation -BrokerAttestation $old -Deployment $deployment -RunnerSha256 $runnerSha256 -CanonicalProcessCount 0 -RunningTaskInstanceCount 0) {
    throw 'Live broker must make stopped midpoint ineligible.'
  }
  $generation.brokerProcessAlive = $false

  if (Test-StoppedMidpointEligible -Task $task -Generation $generation -BrokerAttestation $old -Deployment $deployment -RunnerSha256 $runnerSha256 -CanonicalProcessCount 1 -RunningTaskInstanceCount 0) {
    throw 'Canonical task process presence must make stopped midpoint ineligible.'
  }

  $old.launcherSha256 = 'sha256:' + ('7' * 64)
  if (Test-StoppedMidpointEligible -Task $task -Generation $generation -BrokerAttestation $old -Deployment $deployment -RunnerSha256 $runnerSha256 -CanonicalProcessCount 0 -RunningTaskInstanceCount 0) {
    throw 'Launcher identity drift must make stopped midpoint ineligible.'
  }
} $midpointSource

foreach ($literal in @(
  'PHASE7C_BROKER_RECONCILE_ENTRY=MIDPOINT_STOPPED',
  'PHASE7C_BROKER_RECONCILE_MIDPOINT_REPROOF=PASS',
  'phase7c-source-attestation\components\lifecycle-broker.json'
)) {
  Assert-ContainsLiteral $literal 'Stopped midpoint recovery contract'
}

# Postflight must prove the broker is exact at the accepted deployment and everything else stayed stopped/unchanged.
foreach ($literal in @(
  'BROKER_ATTESTATION=EXACT_MATCH',
  'API_PID_UNCHANGED=TRUE',
  'WEB_PID_UNCHANGED=TRUE',
  'BRIDGE_PID_UNCHANGED=TRUE',
  'BRIDGE_SESSION_UNCHANGED=TRUE',
  'POSTFLIGHT_LIFECYCLE=STOPPED',
  'POSTFLIGHT_MODE=PAUSE',
  'POSTFLIGHT_ARM=DISARMED',
  'POSTFLIGHT_POSITIONS=0',
  'POSTFLIGHT_PENDING_ORDERS=0',
  'WHOLE_RUNTIME_RECONCILED=True',
  'WHOLE_RUNTIME_EXACT=False',
  'WHOLE_RUNTIME_OVERALL=STALE',
  'EXECUTORS_STARTED=False',
  'MODE_MUTATION=NONE',
  'ARM_MUTATION=NONE',
  'ORDER_MUTATION=NONE',
  'POSITION_MUTATION=NONE',
  'LIVE_TEST_ORDER=NONE',
  'PHASE7C_BROKER_PROVENANCE_RECONCILIATION=PASS'
)) {
  Assert-ContainsLiteral $literal 'Broker-only postflight/result contract'
}

# Explicitly forbid broad recovery/deploy semantics and any application POST mutation.
foreach ($forbidden in @(
  '-Method Post',
  '/api/v1/phase7c/lifecycle/start',
  '/api/v1/phase7c/lifecycle/restart',
  'Set-ScheduledTask',
  'Register-ScheduledTask',
  'Restart-Service',
  'Stop-Process',
  'taskkill',
  'run-phase7c-executors-local.ps1',
  'Start-Phase7CExecutorRuntime',
  'deploy-phase7c-web-ui-local.ps1',
  'deploy-phase7c-mt5-dashboard-local.ps1'
)) {
  Assert-NotContainsLiteral $forbidden 'Broker-only reconciliation must not broaden mutation scope'
}

Write-Host 'PHASE7C_STOPPED_LIFECYCLE_BROKER_PROVENANCE_RECONCILIATION_SOURCE_TEST=PASS'
