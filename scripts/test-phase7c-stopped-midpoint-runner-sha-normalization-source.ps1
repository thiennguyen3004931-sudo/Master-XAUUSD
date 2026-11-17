$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReconcilePath = Join-Path $PSScriptRoot 'reconcile-phase7c-stopped-lifecycle-broker-provenance-local.ps1'

if (-not (Test-Path -LiteralPath $ReconcilePath -PathType Leaf)) {
  throw "RED: broker provenance reconciliation entrypoint is missing: $ReconcilePath"
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ReconcilePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) {
  throw "PowerShell syntax error in ${ReconcilePath}: $($errors[0].Message)"
}

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

  $runnerSha = ('B036EE4253437DA009A4D02B9A19E60ECA878A8DD607FED05406274E02030212').ToUpperInvariant()
  $runtimeLauncherSha = 'sha256:' + $runnerSha.ToLowerInvariant()

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
    launcherSha256 = $runtimeLauncherSha
    configFingerprint = $deployment.configFingerprint
  }

  $eligible = Test-StoppedMidpointEligible `
    -Task $task `
    -Generation $generation `
    -BrokerAttestation $old `
    -Deployment $deployment `
    -RunnerSha256 $runnerSha `
    -CanonicalProcessCount 0 `
    -RunningTaskInstanceCount 0

  if (-not $eligible) {
    throw 'RED: canonical bare runner SHA256 must match runtime-source attestation sha256:<lowercase> launcher identity.'
  }

  $old.launcherSha256 = 'sha256:' + ('7' * 64)
  if (Test-StoppedMidpointEligible `
      -Task $task `
      -Generation $generation `
      -BrokerAttestation $old `
      -Deployment $deployment `
      -RunnerSha256 $runnerSha `
      -CanonicalProcessCount 0 `
      -RunningTaskInstanceCount 0) {
    throw 'Launcher hash drift must still make stopped midpoint ineligible.'
  }
} $midpointSource

Write-Host 'PHASE7C_STOPPED_MIDPOINT_RUNNER_SHA_NORMALIZATION_CONTRACT=PASS'
