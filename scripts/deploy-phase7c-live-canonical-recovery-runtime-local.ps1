param(
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$CanonicalHelper = Join-Path $PSScriptRoot "phase7c-canonical-daily-recovery-executor.mjs"

if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw "ExpectedCommit must be an exact 40-character Git SHA." }
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) { throw "TimeoutSeconds must be between 30 and 600." }
foreach ($required in @($ConfigPath, $AccountLibrary, $CanonicalHelper)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "LIVE canonical runtime deploy required file not found: $required" }
}

. $AccountLibrary
$ExpectedCommit = $ExpectedCommit.ToLowerInvariant()
$gitExe = (Get-Command git -ErrorAction Stop).Source

function Resolve-ConfigPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label file is missing: $Path" }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label file is invalid: $Path. $($_.Exception.Message)" }
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-ApiPost([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Post -ContentType "application/json" -Body $json -TimeoutSec 55
}

function Set-Pause([string]$Source) {
  $result = Invoke-ApiPost "/api/v1/phase7c/bot-mode" @{ mode = "PAUSE"; source = $Source }
  if ([string]$result.state.mode -ne "PAUSE") { throw "Control API did not confirm PAUSE." }
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_MODE=PAUSE|SOURCE=$Source"
}

function Invoke-LiveArmAction([ValidateSet("ARM_LIVE", "DISARM_LIVE")] [string]$Action) {
  $preflight = Invoke-ApiPost "/api/v1/phase7c-live-arm-control/preflight" @{ action = $Action }
  if (-not [bool]$preflight.approved -or [string]::IsNullOrWhiteSpace([string]$preflight.preflightToken)) {
    throw "$Action preflight rejected. blockedBy=$(@($preflight.blockedBy) -join ',')"
  }
  $request = Invoke-ApiPost "/api/v1/phase7c-live-arm-control/execute" @{
    action = $Action
    preflightToken = [string]$preflight.preflightToken
    confirmation = $Action
  }
  $requestId = [string]$request.requestId
  if ([string]::IsNullOrWhiteSpace($requestId)) { throw "$Action execute did not return requestId." }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $status = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/status?requestId=$requestId" } catch { continue }
    if ([string]$status.status -eq "PASS") {
      Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_${Action}=PASS"
      return $status
    }
    if ([string]$status.status -eq "FAIL") { throw "$Action failed. phase=$($status.phase) message=$($status.message)" }
  }
  throw "$Action timed out after $TimeoutSeconds seconds."
}

function Get-BridgeHealth {
  return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
}

function Assert-BridgeSession([string]$ExpectedSession, [string]$Stage) {
  $health = Get-BridgeHealth
  if (-not [bool]$health.connected -or [string]$health.status -ne "ok") { throw "$Stage bridge is not healthy." }
  if ([string]$health.configuredAccountMode -ne "LIVE" -or [string]$health.accountMode -ne "real") { throw "$Stage bridge is not bound to LIVE/real." }
  if ([string]::IsNullOrWhiteSpace([string]$health.bridgeSessionId) -or [string]$health.bridgeSessionId -ne $ExpectedSession) {
    throw "$Stage bridge session changed. expected=$ExpectedSession actual=$($health.bridgeSessionId)"
  }
  return $health
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -UseBasicParsing -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-FlatBroker([string]$Stage) {
  $positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0) { throw "$Stage requires zero XAUUSD positions. current=$($positions.Count)" }
  if ($orders.Count -ne 0) { throw "$Stage requires zero pending XAUUSD orders. current=$($orders.Count)" }
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_${Stage}_POSITIONS=0"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_${Stage}_PENDING_ORDERS=0"
}

function Wait-LifecycleState([bool]$ShouldBeReady) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try { $last = Invoke-ApiGet "/api/v1/phase7c/lifecycle" } catch { continue }
    if ($ShouldBeReady) {
      if ([bool]$last.ready -and [bool]$last.running) { return $last }
    } else {
      if (-not [bool]$last.running) { return $last }
    }
  }
  $actual = if ($null -eq $last) { "UNAVAILABLE" } else { "running=$($last.running);ready=$($last.ready)" }
  throw "Lifecycle did not reach expected state ready=$ShouldBeReady. last=$actual"
}

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") { throw "LIVE canonical runtime deploy requires branch main. actual=$branch" }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "LIVE canonical runtime deploy requires a clean worktree." }
  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
    throw "LIVE canonical runtime deploy exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
} finally { Pop-Location }
Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_GIT_GUARD=PASS"
Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_EXPECTED_COMMIT=$ExpectedCommit"

$canonicalText = Get-Content -LiteralPath $CanonicalHelper -Raw
if (-not $canonicalText.Contains('/api/v1/phase7c/daily-recovery') -or
    -not $canonicalText.Contains('Canonical positive/flat day attempted Recovery before SEND') -or
    -not $canonicalText.Contains('changed before SEND')) {
  throw "Canonical Daily Recovery executor source verification failed."
}
Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_CANONICAL_DAILY_RECOVERY_SOURCE=PASS"

$config = Read-JsonFile -Path $ConfigPath -Label "Executor task config"
if ([int]$config.version -ne 2) { throw "LIVE canonical runtime deploy requires executor task config version 2." }
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne "LIVE") { throw "LIVE canonical runtime deploy requires configured LIVE account mode." }
if (-not [bool]$config.liveExecutionEnabled) { throw "LIVE canonical runtime deploy requires liveExecutionEnabled=true." }
if (-not [bool]$config.armed) { throw "LIVE canonical runtime deploy requires executor task config armed=true." }

$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) { throw "Executor task controlApiUrl is missing." }
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode "LIVE" -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ "x-mt5-api-key" = $envInfo.apiKey }

$lifecycleBefore = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
if (-not [bool]$lifecycleBefore.ready -or -not [bool]$lifecycleBefore.running) { throw "Lifecycle must be ready/running before canonical runtime deploy." }
if ([string]$lifecycleBefore.accountMode.accountMode -ne "LIVE" -or -not [bool]$lifecycleBefore.accountMode.valid) { throw "Lifecycle account mode must be valid LIVE." }
$oldSupervisorPid = [int]$lifecycleBefore.processes.supervisor.pid
$oldTrendPid = [int]$lifecycleBefore.processes.trend.pid
$oldSidewayPid = [int]$lifecycleBefore.processes.sideway.pid
if ($oldSupervisorPid -le 0 -or $oldTrendPid -le 0 -or $oldSidewayPid -le 0) { throw "Lifecycle PID snapshot is incomplete before deploy." }

$healthBefore = Get-BridgeHealth
if (-not [bool]$healthBefore.connected -or [string]$healthBefore.status -ne "ok") { throw "PREFLIGHT bridge is not healthy." }
$bridgeSessionId = [string]$healthBefore.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) { throw "PREFLIGHT bridge health is missing bridgeSessionId." }
[void](Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "PREFLIGHT")
Assert-FlatBroker -Stage "PREFLIGHT"

$mutationStarted = $false
try {
  $mutationStarted = $true
  Set-Pause "canonical-recovery-runtime-deploy"
  $modeFrozen = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeFrozen.state.mode -ne "PAUSE") { throw "Runtime deploy could not confirm PAUSE before DISARM." }
  [void](Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_PAUSE")
  Assert-FlatBroker -Stage "POST_PAUSE"

  $armBefore = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armBefore.accountMode -ne "LIVE") { throw "Canonical LIVE ARM capability is not LIVE." }
  if ([bool]$armBefore.liveExecutionArmed -or [string]$armBefore.liveArmStatus -eq "ARMED") {
    [void](Invoke-LiveArmAction "DISARM_LIVE")
  }
  $armFrozen = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armFrozen.liveArmStatus -ne "DISARMED" -or [bool]$armFrozen.liveExecutionArmed) { throw "Canonical LIVE ARM did not reach DISARMED before lifecycle STOP." }
  [void](Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_DISARM")
  Assert-FlatBroker -Stage "POST_DISARM"

  [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})
  [void](Wait-LifecycleState -ShouldBeReady $false)
  [void](Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_STOP")
  Assert-FlatBroker -Stage "POST_STOP"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_LIFECYCLE_STOP=PASS"

  [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
  $lifecycleAfter = Wait-LifecycleState -ShouldBeReady $true
  if ([string]$lifecycleAfter.mode.mode -ne "PAUSE") { throw "Deployed lifecycle must remain PAUSE before ARM." }
  if ([string]$lifecycleAfter.accountMode.accountMode -ne "LIVE" -or -not [bool]$lifecycleAfter.accountMode.valid) { throw "Deployed lifecycle is not valid LIVE." }
  $newSupervisorPid = [int]$lifecycleAfter.processes.supervisor.pid
  $newTrendPid = [int]$lifecycleAfter.processes.trend.pid
  $newSidewayPid = [int]$lifecycleAfter.processes.sideway.pid
  if ($newSupervisorPid -le 0 -or $newTrendPid -le 0 -or $newSidewayPid -le 0) { throw "Deployed lifecycle PID snapshot is incomplete." }
  if ($newSupervisorPid -eq $oldSupervisorPid -or $newTrendPid -eq $oldTrendPid -or $newSidewayPid -eq $oldSidewayPid) {
    throw "Controlled canonical runtime deploy did not replace all required runtime PIDs."
  }
  [void](Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_START")
  Assert-FlatBroker -Stage "POST_START"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_LIFECYCLE_START=PASS"

  [void](Invoke-LiveArmAction "ARM_LIVE")
  $armAfter = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$armAfter.liveArmStatus -ne "ARMED" -or -not [bool]$armAfter.liveExecutionArmed) { throw "Canonical LIVE ARM was not restored after deploy." }
  $modeAfter = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$modeAfter.state.mode -ne "PAUSE") { throw "Runtime deploy must finish in PAUSE." }
  [void](Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "FINAL")
  Assert-FlatBroker -Stage "FINAL"

  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_FINAL_MODE=PAUSE"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_FINAL_ARM=ARMED"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_WEB_API_RESTART=NONE"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_LIVE_TEST_ORDER=NONE"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_NEXT_ACTION=MANUAL_WEB_AUTO_ONLY"
  Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_STATUS=PASS"
} catch {
  if ($mutationStarted) {
    try { Set-Pause "runtime-deploy-fail-closed" } catch {}
    try {
      $armNow = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
      if ([bool]$armNow.liveExecutionArmed -or [string]$armNow.liveArmStatus -eq "ARMED") {
        [void](Invoke-LiveArmAction "DISARM_LIVE")
      }
    } catch {}
    Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_FAIL_CLOSED_MODE=PAUSE"
    Write-Host "PHASE7C_LIVE_CANONICAL_RUNTIME_DEPLOY_FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT"
  }
  throw
}
