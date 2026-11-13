param(
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$OwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"
$RuntimeOwnershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-ownership-probe.ps1"
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
$WebApiDeploy = Join-Path $PSScriptRoot "deploy-phase7c-web-ui-local.ps1"
$TaskInstaller = Join-Path $PSScriptRoot "register-phase7c-executor-task-local.ps1"
$TaskName = "XAUUSD-Phase7C-Executors"
$BrokerState = Join-Path $ProjectRoot ".runtime\phase7c-lifecycle-broker\state"
$BrokerHeartbeat = Join-Path $BrokerState "heartbeat.json"
$ApiSidRecord = Join-Path $BrokerState "api-user-sid.txt"
$ReadyStableMs = 5000

if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
  throw "ExpectedCommit must be an exact 40-character Git SHA."
}
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) {
  throw "TimeoutSeconds must be between 30 and 600."
}
foreach ($required in @($ConfigPath, $AccountLibrary, $OwnershipLibrary, $RuntimeOwnershipLibrary, $RuntimeSourceAttestationLibrary, $WebApiDeploy, $TaskInstaller)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Runtime-ready stable recovery deploy required file not found: $required"
  }
}

. $AccountLibrary
. $OwnershipLibrary
. $RuntimeOwnershipLibrary
. $RuntimeSourceAttestationLibrary
$ExpectedCommit = $ExpectedCommit.ToLowerInvariant()
$gitExe = (Get-Command git -ErrorAction Stop).Source

function Resolve-ConfigPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing: $Path"
  }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label file is invalid: $Path. $($_.Exception.Message)" }
}

function Get-Phase7CRecordedApiUserSid {
  if (-not (Test-Path -LiteralPath $ApiSidRecord -PathType Leaf)) {
    throw "Lifecycle broker API SID record is missing before task repair: $ApiSidRecord"
  }
  $value = ([string](Get-Content -LiteralPath $ApiSidRecord -Raw)).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Lifecycle broker API SID record is empty before task repair: $ApiSidRecord"
  }
  try {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($value)
  } catch {
    throw "Lifecycle broker API SID record is invalid before task repair: $value"
  }
  return [string]$sid.Value
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-ApiPost([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod `
    -Uri "$ControlApiUrl$Path" `
    -Method Post `
    -ContentType "application/json" `
    -Body $json `
    -TimeoutSec 55
}

function Set-Pause([string]$Source) {
  $result = Invoke-ApiPost "/api/v1/phase7c/bot-mode" @{ mode = "PAUSE"; source = $Source }
  if ([string]$result.state.mode -ne "PAUSE") {
    throw "Control API did not confirm PAUSE."
  }
}

function Invoke-CanonicalDisarm {
  $preflight = Invoke-ApiPost "/api/v1/phase7c-live-arm-control/preflight" @{ action = "DISARM_LIVE" }
  if (-not [bool]$preflight.approved -or [string]::IsNullOrWhiteSpace([string]$preflight.preflightToken)) {
    throw "DISARM_LIVE preflight rejected. blockedBy=$(@($preflight.blockedBy) -join ',')"
  }

  $request = Invoke-ApiPost "/api/v1/phase7c-live-arm-control/execute" @{
    action = "DISARM_LIVE"
    preflightToken = [string]$preflight.preflightToken
    confirmation = "DISARM_LIVE"
  }
  $requestId = [string]$request.requestId
  if ([string]::IsNullOrWhiteSpace($requestId)) {
    throw "DISARM_LIVE execute did not return requestId."
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
      $status = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/status?requestId=$requestId"
    } catch { continue }
    if ([string]$status.status -eq "PASS") { return }
    if ([string]$status.status -eq "FAIL") {
      throw "DISARM_LIVE failed. phase=$($status.phase) message=$($status.message)"
    }
  }
  throw "DISARM_LIVE timed out after $TimeoutSeconds seconds."
}

function Read-BridgeArray([string]$Path) {
  $response = Invoke-WebRequest `
    -Uri "$BridgeBase$Path" `
    -Headers $BridgeHeaders `
    -Method Get `
    -UseBasicParsing `
    -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Assert-FlatBroker([string]$Stage) {
  $positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0) {
    throw "$Stage requires zero XAUUSD positions. current=$($positions.Count)"
  }
  if ($orders.Count -ne 0) {
    throw "$Stage requires zero pending XAUUSD orders. current=$($orders.Count)"
  }
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_${Stage}_POSITIONS=0"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_${Stage}_PENDING_ORDERS=0"
}

function Get-BridgeHealth {
  return Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
}

function Assert-BridgeSession([string]$ExpectedSession, [string]$Stage) {
  $health = Get-BridgeHealth
  if (-not [bool]$health.connected -or [string]$health.status -ne "ok") {
    throw "$Stage bridge is not healthy."
  }
  if ([string]$health.configuredAccountMode -ne "LIVE" -or [string]$health.accountMode -ne "real") {
    throw "$Stage bridge is not LIVE/real."
  }
  $actualSession = [string]$health.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($actualSession) -or $actualSession -ne $ExpectedSession) {
    throw "$Stage bridge session changed. expected=$ExpectedSession actual=$actualSession"
  }
}

function Assert-PauseDisarmed([string]$Stage) {
  $mode = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$mode.state.mode -ne "PAUSE") {
    throw "$Stage current bot mode PAUSE is required. actual=$($mode.state.mode)"
  }

  $arm = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([string]$arm.accountMode -ne "LIVE" -or [string]$arm.liveArmStatus -ne "DISARMED" -or [bool]$arm.liveExecutionArmed) {
    throw "$Stage canonical LIVE ARM=DISARMED is required."
  }
}

function Test-Phase7CLifecycleHasAliveProcess {
  param([Parameter(Mandatory = $true)] $State)

  if ($null -eq $State) { return $true }
  if ($null -eq $State.processes) { return $true }
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) {
      return $true
    }
  }
  return $false
}

function Wait-LifecycleStopped {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
      $state = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
      if (-not [bool]$state.running -and -not (Test-Phase7CLifecycleHasAliveProcess -State $state)) { return }
    } catch {}
  }
  throw "Lifecycle did not stop within $TimeoutSeconds seconds."
}

function Assert-LifecycleExecutorsStopped([string]$Stage) {
  $state = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
  if ([bool]$state.running) {
    throw "$Stage requires lifecycle running=false before Scheduled Task repair."
  }
  if ($null -eq $state.processes) {
    throw "$Stage lifecycle process status is unavailable."
  }
  $alive = @()
  foreach ($property in @($state.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) {
      $alive += [string]$property.Name
    }
  }
  if ($alive.Count -ne 0) {
    throw "$Stage requires every executor process stopped before Scheduled Task repair. alive=$($alive -join ',')"
  }
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_${Stage}_EXECUTORS_STOPPED=PASS"
}

function Test-Phase7CSystemTaskPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and ([string]$Principal.LogonType) -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Get-Phase7CCanonicalTaskProcessIds($Task) {
  try {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return @(-1) }
    $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$actions[0].Arguments))
    if ($tokens.Count -ne 5 -or -not $tokens[3].Equals('-EncodedCommand', [System.StringComparison]::OrdinalIgnoreCase)) {
      return @(-1)
    }
    $encodedToken = [string]$tokens[4]
    if ([string]::IsNullOrWhiteSpace($encodedToken)) { return @(-1) }
    $matches = @(
      Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
          ([string]$_.CommandLine).Contains($encodedToken)
        }
    )
    return @($matches | ForEach-Object { [int]$_.ProcessId })
  } catch {
    return @(-1)
  }
}
function Get-Phase7CCanonicalTaskProcessCount($Task) {
  try {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { return -1 }
    $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$actions[0].Arguments))
    if ($tokens.Count -ne 5 -or -not $tokens[3].Equals('-EncodedCommand', [System.StringComparison]::OrdinalIgnoreCase)) {
      return -1
    }
    $encodedToken = [string]$tokens[4]
    if ([string]::IsNullOrWhiteSpace($encodedToken)) { return -1 }
    $matches = @(
      Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
          ([string]$_.CommandLine).Contains($encodedToken)
        }
    )
    return [int]$matches.Count
  } catch {
    return -1
  }
}

function Get-Phase7CRunningTaskInstanceCount([string]$Name) {
  try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $root = $service.GetFolder('\')
    $registered = $root.GetTask($Name)
    $instances = $registered.GetInstances(0)
    return [int]$instances.Count
  } catch {
    return -1
  }
}

function Get-Phase7CBrokerPidFromHeartbeat {
  if (-not (Test-Path -LiteralPath $BrokerHeartbeat -PathType Leaf)) { return 0 }
  try {
    $heartbeat = Get-Content -LiteralPath $BrokerHeartbeat -Raw | ConvertFrom-Json
    if ([int]$heartbeat.version -ne 1) { return 0 }
    $brokerPid = [int]$heartbeat.brokerPid
    if ($brokerPid -le 0) { return 0 }
    return $brokerPid
  } catch {
    return 0
  }
}

function Test-Phase7CBrokerHeartbeatFresh {
  if (-not (Test-Path -LiteralPath $BrokerHeartbeat -PathType Leaf)) { return $false }
  try {
    $heartbeat = Get-Content -LiteralPath $BrokerHeartbeat -Raw | ConvertFrom-Json
    if ([int]$heartbeat.version -ne 1) { return $false }
    $brokerPid = [int]$heartbeat.brokerPid
    if ($brokerPid -le 0 -or $null -eq (Get-Process -Id $brokerPid -ErrorAction SilentlyContinue)) { return $false }
    $updatedAt = [long]$heartbeat.updatedAt
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $updatedAt
    return $age -ge 0 -and $age -le 5000
  } catch {
    return $false
  }
}

function Wait-LifecycleReadyStable([int]$ProbeTimeoutSeconds) {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_READY_STABLE_MS=5000"
  $deadline = (Get-Date).AddSeconds($ProbeTimeoutSeconds)
  $stableSinceMs = 0L

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $sampleReady = $false
    try {
      $state = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
      $sampleReady = `
        [bool]$state.running -and `
        [bool]$state.ready -and `
        [string]$state.mode.mode -eq "PAUSE" -and `
        [string]$state.accountMode.accountMode -eq "LIVE" -and `
        [bool]$state.accountMode.valid
    } catch {
      $sampleReady = $false
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($sampleReady) {
      if ($stableSinceMs -le 0) {
        $stableSinceMs = $nowMs
      }
      if (($nowMs - $stableSinceMs) -ge $ReadyStableMs) {
        return $true
      }
    } else {
      if ($stableSinceMs -gt 0) {
        Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_READY_STABLE_RESET=TRUE"
      }
      $stableSinceMs = 0L
    }
  }
  return $false
}

Push-Location $ProjectRoot
try {
  $branch = ([string](& $gitExe branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    throw "Runtime-ready stable recovery deploy requires branch main. actual=$branch"
  }
  $dirty = @(& $gitExe status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Runtime-ready stable recovery deploy requires a clean worktree."
  }

  $actualCommit = ([string](& $gitExe rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) {
    throw "Runtime-ready stable recovery deploy exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
  $sourceTree = ([string](& $gitExe rev-parse "$ExpectedCommit`^{tree}")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') {
    throw "Could not resolve exact source tree for runtime attestation."
  }
} finally {
  Pop-Location
}
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GIT_GUARD=PASS"
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_EXPECTED_COMMIT=$ExpectedCommit"

Import-Module ScheduledTasks -ErrorAction Stop
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_EXPECTED_RUNNER=$runnerPath"
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_EXPECTED_RUNNER_SHA256=$trustedRunnerSha256"

$task = $null
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
} catch {
  $classification = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVIDER=$classification"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=BLOCKED_UNPROVEN_OWNERSHIP"
  throw "Cannot prove canonical Scheduled Task ownership before recovery mutation. classification=$classification"
}
if ($null -eq $task) {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=BLOCKED_UNPROVEN_OWNERSHIP"
  throw "Canonical Scheduled Task '$TaskName' is missing; recovery deploy will not create it implicitly."
}

$taskOwnership = Test-Phase7CExecutorTaskActionOwnership `
  -Actions $task.Actions `
  -ExpectedRunnerPath $runnerPath `
  -ExpectedRunnerSha256 $trustedRunnerSha256
if (-not [bool]$taskOwnership.owned) {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=BLOCKED_UNPROVEN_OWNERSHIP"
  throw "Scheduled Task ownership cannot be proven; recovery mutation blocked. reason=$($taskOwnership.reason)"
}
if (-not (Test-Phase7CSystemTaskPrincipal $task.Principal)) {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=BLOCKED_UNPROVEN_OWNERSHIP"
  throw "Owned Scheduled Task is not SYSTEM + ServiceAccount + Highest; automatic principal replacement is blocked."
}

$taskDefinitionDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)
$taskProvenanceRepairRequired = [bool]$taskOwnership.repairRequired -or -not [bool]$taskOwnership.canonical
$taskBatterySettingsRepairRequired = $false
if (-not $taskProvenanceRepairRequired -and $taskDefinitionDrift.Count -gt 0) {
  if (Test-Phase7CBatteryOnlyTaskDrift -Drift $taskDefinitionDrift) {
    $taskBatterySettingsRepairRequired = $true
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_DEFINITION_REPAIR=BATTERY_SETTINGS_REQUIRED"
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_DEFINITION_DRIFT=$($taskDefinitionDrift -join ',')"
  } else {
    throw "Owned canonical Scheduled Task has unsupported definition drift; automatic recovery repair is blocked. drift=$($taskDefinitionDrift -join ',')"
  }
}
$taskRepairRequired = $taskProvenanceRepairRequired -or $taskBatterySettingsRepairRequired

$apiUserSid = ""
if ($taskRepairRequired) {
  if ($taskProvenanceRepairRequired) {
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE=OWNED_REPAIR_REQUIRED"
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REASON=$($taskOwnership.reason)"
  } else {
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE=CANONICAL_HASH_GUARD"
  }
  $apiUserSid = Get-Phase7CRecordedApiUserSid
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_API_SID_PREFLIGHT=PASS"
} else {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE=CANONICAL_HASH_GUARD"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=SKIPPED_ALREADY_CANONICAL"
}

$config = Read-JsonFile -Path $ConfigPath -Label "Executor task config"
if ([int]$config.version -ne 2) {
  throw "Runtime-ready stable recovery deploy requires executor task config version 2."
}
if ((ConvertTo-Phase7CAccountMode ([string]$config.accountMode)) -ne "LIVE") {
  throw "Runtime-ready stable recovery deploy requires configured LIVE account mode."
}
if (-not [bool]$config.liveExecutionEnabled) {
  throw "Runtime-ready stable recovery deploy requires liveExecutionEnabled=true."
}
if (-not [bool]$config.armed) {
  throw "Runtime-ready stable recovery deploy requires executor task config armed=true."
}

$WorkDir = Resolve-ConfigPath ([string]$config.workDir)
$EnvFile = Resolve-ConfigPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($ControlApiUrl)) {
  throw "Executor task controlApiUrl is missing."
}

$attestationConfigIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
  -RuntimeRoot $WorkDir `
  -AccountMode LIVE `
  -LiveExecutionEnabled $true `
  -ControlApiUrl $ControlApiUrl
$previousDeployment = $null
try {
  $previousDeployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
} catch {
  $previousDeployment = $null
}
$deployment = Initialize-Phase7CRuntimeSourceDeployment `
  -RuntimeRoot $WorkDir `
  -SourceCommit $ExpectedCommit `
  -SourceTree $sourceTree `
  -Branch main `
  -ConfigIdentity $attestationConfigIdentity
$runtimeSourceGenerationDecision = Get-Phase7CRuntimeSourceGenerationReloadDecision `
  -RuntimeRoot $WorkDir `
  -PreviousDeployment $previousDeployment `
  -TargetDeployment $deployment
$runtimeSourceGenerationReloadRequired = [bool]$runtimeSourceGenerationDecision.reloadRequired
if ($runtimeSourceGenerationReloadRequired) {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=REQUIRED"
} else {
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=NOT_REQUIRED"
}
$runtimeSourceGenerationReloadReasons = @($runtimeSourceGenerationDecision.reloadReasons)
$runtimeSourceGenerationMismatchComponents = @($runtimeSourceGenerationDecision.mismatchComponents)
$runtimeSourceGenerationMismatchReasons = @($runtimeSourceGenerationDecision.reasonCodes)
$runtimeSourceGenerationReloadReasonText = if ($runtimeSourceGenerationReloadReasons.Count -eq 0) { "NONE" } else { $runtimeSourceGenerationReloadReasons -join ',' }
$runtimeSourceGenerationMismatchComponentText = if ($runtimeSourceGenerationMismatchComponents.Count -eq 0) { "NONE" } else { $runtimeSourceGenerationMismatchComponents -join ',' }
$runtimeSourceGenerationMismatchReasonText = if ($runtimeSourceGenerationMismatchReasons.Count -eq 0) { "NONE" } else { $runtimeSourceGenerationMismatchReasons -join ',' }
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD_REASONS=$runtimeSourceGenerationReloadReasonText"
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_MISMATCH_COMPONENTS=$runtimeSourceGenerationMismatchComponentText"
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_MISMATCH_REASONS=$runtimeSourceGenerationMismatchReasonText"
Write-Host "PHASE7C_RUNTIME_SOURCE_DEPLOYMENT_ID=$($deployment.deploymentId)"
Write-Host "PHASE7C_RUNTIME_SOURCE_COMMIT=$($deployment.sourceCommit)"
Write-Host "PHASE7C_RUNTIME_SOURCE_TREE=$($deployment.sourceTree)"
Write-Host "PHASE7C_RUNTIME_SOURCE_MANIFEST=READY"

$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode "LIVE" -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ "x-mt5-api-key" = $envInfo.apiKey }

Assert-PauseDisarmed -Stage "PREFLIGHT"
$healthBefore = Get-BridgeHealth
if (-not [bool]$healthBefore.connected -or [string]$healthBefore.status -ne "ok") {
  throw "PREFLIGHT bridge is not healthy."
}
if ([string]$healthBefore.configuredAccountMode -ne "LIVE" -or [string]$healthBefore.accountMode -ne "real") {
  throw "PREFLIGHT bridge is not LIVE/real."
}
$bridgeSessionId = [string]$healthBefore.bridgeSessionId
if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) {
  throw "PREFLIGHT bridge health is missing bridgeSessionId."
}
Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "PREFLIGHT"
Assert-FlatBroker -Stage "PREFLIGHT"
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_PREFLIGHT_MODE=PAUSE"
Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_PREFLIGHT_ARM=DISARMED"

$mutationStarted = $false
try {
  $mutationStarted = $true

# A previous repair attempt can leave an already-canonical task stranded in
# Queued/STOPPED state solely because the old task definition blocked battery
# starts. Repair that exact outage before Web/API deploy so the ordinary strict
# verifier remains unchanged and never needs a broker/executor outage bypass.
if ($taskBatterySettingsRepairRequired) {
  $runtimeGenerationBeforeBatteryRepair = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  $lifecycleBeforeBatteryRepair = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
  $taskBeforeBatteryRepair = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $lockStateBeforeBatteryRepair = [string]$runtimeGenerationBeforeBatteryRepair.startupRunnerLockState
  $lockAbsentBeforeBatteryRepair = $lockStateBeforeBatteryRepair -in @('MISSING', 'RELEASED')
  $lockHeldBeforeBatteryRepair = $lockStateBeforeBatteryRepair -eq 'HELD'
  $batteryRuntimeUnavailable = `
    [string]$taskBeforeBatteryRepair.State -ne 'Running' -or `
    -not [bool]$runtimeGenerationBeforeBatteryRepair.brokerProcessAlive -or `
    -not [bool]$runtimeGenerationBeforeBatteryRepair.brokerHeartbeatFresh -or `
    $lockAbsentBeforeBatteryRepair
  $batteryLifecycleStoppedNoExecutors = `
    -not [bool]$lifecycleBeforeBatteryRepair.running -and `
    -not (Test-Phase7CLifecycleHasAliveProcess -State $lifecycleBeforeBatteryRepair)

  $batteryStrandedOutageEligible = `
    [string]$taskBeforeBatteryRepair.State -ne 'Running' -and `
    [string]$runtimeGenerationBeforeBatteryRepair.statusReadState -eq 'OK' -and `
    [string]$runtimeGenerationBeforeBatteryRepair.heartbeatReadState -eq 'OK' -and `
    [bool]$runtimeGenerationBeforeBatteryRepair.brokerStatusPidMatch -and `
    -not [bool]$runtimeGenerationBeforeBatteryRepair.brokerProcessAlive -and `
    -not [bool]$runtimeGenerationBeforeBatteryRepair.brokerHeartbeatFresh -and `
    $lockAbsentBeforeBatteryRepair -and `
    $batteryLifecycleStoppedNoExecutors

  $batteryHealthyBrokerStoppedLifecycleEligible = `
    [string]$taskBeforeBatteryRepair.State -eq 'Running' -and `
    [string]$runtimeGenerationBeforeBatteryRepair.statusReadState -eq 'OK' -and `
    [string]$runtimeGenerationBeforeBatteryRepair.heartbeatReadState -eq 'OK' -and `
    [bool]$runtimeGenerationBeforeBatteryRepair.brokerStatusPidMatch -and `
    [bool]$runtimeGenerationBeforeBatteryRepair.brokerProcessAlive -and `
    [bool]$runtimeGenerationBeforeBatteryRepair.brokerHeartbeatFresh -and `
    $lockHeldBeforeBatteryRepair -and `
    $batteryLifecycleStoppedNoExecutors

  $batteryPreWebRepairEligible = `
    $batteryStrandedOutageEligible -or `
    $batteryHealthyBrokerStoppedLifecycleEligible

  $batteryPreWebRepairRequired = `
    $batteryRuntimeUnavailable -or `
    -not [bool]$lifecycleBeforeBatteryRepair.running

  if ($batteryPreWebRepairRequired -and -not $batteryPreWebRepairEligible) {
    throw "Battery-settings task drift is paired with an unproven runtime/lifecycle state; pre-Web repair blocked. taskState=$($taskBeforeBatteryRepair.State) lifecycleRunning=$($lifecycleBeforeBatteryRepair.running) brokerAlive=$($runtimeGenerationBeforeBatteryRepair.brokerProcessAlive) heartbeatFresh=$($runtimeGenerationBeforeBatteryRepair.brokerHeartbeatFresh) lock=$lockStateBeforeBatteryRepair"
  }

  if ($batteryPreWebRepairEligible) {
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_REPAIR=ELIGIBLE"
    Assert-LifecycleExecutorsStopped -Stage "BATTERY_PRE_WEB_REPAIR"
    Assert-PauseDisarmed -Stage "BATTERY_PRE_WEB_REPAIR"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "BATTERY_PRE_WEB_REPAIR"
    Assert-FlatBroker -Stage "BATTERY_PRE_WEB_REPAIR"

    $brokerPidBeforeBatteryRepair = Get-Phase7CBrokerPidFromHeartbeat
    if ($batteryHealthyBrokerStoppedLifecycleEligible -and $brokerPidBeforeBatteryRepair -le 0) {
      throw "Healthy-broker battery repair could not capture the current broker PID before task stop."
    }

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $taskStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    $taskQuiesced = $false
    do {
      Start-Sleep -Milliseconds 250
      $taskAfterStop = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      if ([string]$taskAfterStop.State -notin @('Running', 'Queued')) {
        $taskQuiesced = $true
        break
      }
    } while ([DateTime]::UtcNow -lt $taskStopDeadline)
    if (-not $taskQuiesced) {
      throw "Battery Scheduled Task did not quiesce before canonical settings repair. state=$($taskAfterStop.State)"
    }

    $brokerProcessStopped = $brokerPidBeforeBatteryRepair -le 0
    $brokerStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    while (-not $brokerProcessStopped -and [DateTime]::UtcNow -lt $brokerStopDeadline) {
      if ($null -eq (Get-Process -Id $brokerPidBeforeBatteryRepair -ErrorAction SilentlyContinue)) {
        $brokerProcessStopped = $true
        break
      }
      Start-Sleep -Milliseconds 250
    }
    if (-not $brokerProcessStopped) {
      throw "Previous lifecycle broker process remained alive after battery Scheduled Task stop. pid=$brokerPidBeforeBatteryRepair"
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_PREVIOUS_BROKER_EXIT=PASS|PREVIOUS_PID=$brokerPidBeforeBatteryRepair"

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $TaskInstaller `
      -TaskName $TaskName `
      -ProjectRoot $ProjectRoot `
      -Repair `
      -ApiUserSid $apiUserSid
    if ($LASTEXITCODE -ne 0) {
      throw "Canonical Scheduled Task battery settings repair failed with exit code $LASTEXITCODE."
    }

    $repairedBatteryTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $repairedBatteryOwnership = Test-Phase7CExecutorTaskActionOwnership `
      -Actions $repairedBatteryTask.Actions `
      -ExpectedRunnerPath $runnerPath `
      -ExpectedRunnerSha256 $trustedRunnerSha256
    $repairedBatteryDrift = @(Get-Phase7CExecutorTaskDrift -Task $repairedBatteryTask)
    if (-not [bool]$repairedBatteryOwnership.owned -or -not [bool]$repairedBatteryOwnership.canonical -or [bool]$repairedBatteryOwnership.repairRequired -or $repairedBatteryDrift.Count -ne 0) {
      throw "Battery settings repair did not converge to the canonical trusted task definition. ownership=$($repairedBatteryOwnership.reason) drift=$($repairedBatteryDrift -join ',')"
    }
    if (-not (Test-Phase7CSystemTaskPrincipal $repairedBatteryTask.Principal)) {
      throw "Battery settings repair did not preserve SYSTEM + ServiceAccount + Highest."
    }
    if (-not (Test-Phase7CBrokerHeartbeatFresh)) {
      throw "Battery settings repair did not return a fresh lifecycle broker heartbeat."
    }

    $batteryPostRepairLockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
    $batteryPostRepairLockState = Get-Phase7CReadOnlyLockState -Path $batteryPostRepairLockPath
    if ($batteryPostRepairLockState -ne 'HELD') {
      throw "Battery settings repair did not restore the startup-runner singleton lock. state=$batteryPostRepairLockState"
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_TASK_REPAIR=PASS"
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_STARTUP_RUNNER_LOCK=HELD"

    [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
    if (-not (Wait-LifecycleReadyStable -ProbeTimeoutSeconds ([Math]::Min($TimeoutSeconds, 30)))) {
      throw "Lifecycle did not return to stable READY after battery settings pre-Web repair."
    }
    Assert-PauseDisarmed -Stage "BATTERY_POST_REPAIR"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "BATTERY_POST_REPAIR"
    Assert-FlatBroker -Stage "BATTERY_POST_REPAIR"
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BATTERY_PRE_WEB_LIFECYCLE_READY=PASS"

    $taskBatterySettingsRepairRequired = $false
    $taskRepairRequired = $taskProvenanceRepairRequired
  }
}

# Strict dashboard deploy requires live executor PID files and strict Telegram
# verification. If the new deployment identity requires a generation reload while the
# lifecycle is RUNNING+READY with a proven canonical SYSTEM broker but a RELEASED or
# MISSING singleton lock, quiesce the lifecycle first. The unchanged stopped-lifecycle
# path below then performs the exact Scheduled Task restart and restores HELD before
# lifecycle start and strict Web/API verification.
if ($runtimeSourceGenerationReloadRequired -and -not $taskRepairRequired) {
  $preWebRuntimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
  $preWebLifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
  $preWebTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $preWebExpectedLauncherSha256 = 'sha256:' + $trustedRunnerSha256.ToLowerInvariant()
  $preWebBrokerAttestationPath = Join-Path $WorkDir "phase7c-source-attestation\components\lifecycle-broker.json"

  $preWebLifecycleRunningReady = `
    [bool]$preWebLifecycle.running -and `
    [bool]$preWebLifecycle.ready -and `
    [string]$preWebLifecycle.mode.mode -eq 'PAUSE' -and `
    [string]$preWebLifecycle.accountMode.accountMode -eq 'LIVE' -and `
    [bool]$preWebLifecycle.accountMode.valid
  $preWebRunningReleasedLockObserved = `
    $preWebLifecycleRunningReady -and `
    [string]$preWebRuntimeGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED')
  $preWebRunningReleasedLockCandidate = `
    $preWebRunningReleasedLockObserved -and `
    [string]$preWebTask.State -eq 'Running' -and `
    [string]$preWebRuntimeGeneration.statusReadState -eq 'OK' -and `
    [string]$preWebRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
    [bool]$preWebRuntimeGeneration.brokerStatusPidMatch -and `
    [bool]$preWebRuntimeGeneration.brokerProcessAlive -and `
    [bool]$preWebRuntimeGeneration.brokerHeartbeatFresh

  $preWebRunningCanonicalProcessIds = @()
  $preWebRunningInstanceCount = -1
  $preWebRunningBrokerAttestation = $null
  $preWebRunningAttestedLauncherSha256 = ''
  $preWebRunningOwnership = $null
  $preWebRunningDrift = @('UNREAD')
  $preWebRunningReleasedLockRepairEligible = $false
  if ($preWebRunningReleasedLockCandidate) {
    try {
      $preWebRunningCanonicalProcessIds = @(Get-Phase7CCanonicalTaskProcessIds -Task $preWebTask)
      $preWebRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
      $preWebRunningBrokerAttestation = Read-JsonFile -Path $preWebBrokerAttestationPath -Label "Lifecycle broker source attestation before RUNNING+READY released-lock quiesce"
      $preWebRunningAttestedLauncherSha256 = ([string]$preWebRunningBrokerAttestation.launcherSha256).Trim().ToLowerInvariant()
      $preWebRunningOwnership = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $preWebTask.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $preWebRunningDrift = @(Get-Phase7CExecutorTaskDrift -Task $preWebTask)
      $preWebRunningReleasedLockRepairEligible = `
        $preWebRunningCanonicalProcessIds.Count -eq 1 -and `
        $preWebRunningInstanceCount -eq 1 -and `
        [int]$preWebRunningCanonicalProcessIds[0] -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
        [string]$preWebRunningBrokerAttestation.component -eq 'lifecycle-broker' -and `
        [int]$preWebRunningBrokerAttestation.pid -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
        $preWebRunningAttestedLauncherSha256 -eq $preWebExpectedLauncherSha256 -and `
        [bool]$preWebRunningOwnership.owned -and `
        [bool]$preWebRunningOwnership.canonical -and `
        -not [bool]$preWebRunningOwnership.repairRequired -and `
        $preWebRunningDrift.Count -eq 0 -and `
        (Test-Phase7CSystemTaskPrincipal $preWebTask.Principal)
    } catch {
      $preWebRunningReleasedLockRepairEligible = $false
    }
  }

  if ($preWebRunningReleasedLockObserved) {
    if (-not $preWebRunningReleasedLockRepairEligible) {
      throw "RUNNING+READY lifecycle with RELEASED/MISSING startup lock requires an exact canonical SYSTEM broker tuple before lifecycle quiesce. taskState=$($preWebTask.State) brokerAlive=$($preWebRuntimeGeneration.brokerProcessAlive) heartbeatFresh=$($preWebRuntimeGeneration.brokerHeartbeatFresh) lock=$($preWebRuntimeGeneration.startupRunnerLockState) canonicalProcesses=$($preWebRunningCanonicalProcessIds.Count) taskInstances=$preWebRunningInstanceCount"
    }

    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK=ELIGIBLE_QUIESCE_REQUIRED"
    Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"
    Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"

    # Re-prove the exact RUNNING+READY abnormal singleton tuple immediately before
    # the canonical lifecycle mutation. Any evidence change fails closed before stop.
    $preWebTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $preWebRuntimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $preWebLifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
    $preWebRunningCanonicalProcessIds = @(Get-Phase7CCanonicalTaskProcessIds -Task $preWebTask)
    $preWebRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
    $preWebRunningBrokerAttestation = Read-JsonFile -Path $preWebBrokerAttestationPath -Label "Lifecycle broker source attestation during RUNNING+READY released-lock safety recheck"
    $preWebRunningAttestedLauncherSha256 = ([string]$preWebRunningBrokerAttestation.launcherSha256).Trim().ToLowerInvariant()
    $preWebRunningOwnership = Test-Phase7CExecutorTaskActionOwnership `
      -Actions $preWebTask.Actions `
      -ExpectedRunnerPath $runnerPath `
      -ExpectedRunnerSha256 $trustedRunnerSha256
    $preWebRunningDrift = @(Get-Phase7CExecutorTaskDrift -Task $preWebTask)
    $preWebRunningReleasedLockStillEligible = `
      [bool]$preWebLifecycle.running -and `
      [bool]$preWebLifecycle.ready -and `
      [string]$preWebLifecycle.mode.mode -eq 'PAUSE' -and `
      [string]$preWebLifecycle.accountMode.accountMode -eq 'LIVE' -and `
      [bool]$preWebLifecycle.accountMode.valid -and `
      [string]$preWebTask.State -eq 'Running' -and `
      [string]$preWebRuntimeGeneration.statusReadState -eq 'OK' -and `
      [string]$preWebRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
      [bool]$preWebRuntimeGeneration.brokerStatusPidMatch -and `
      [bool]$preWebRuntimeGeneration.brokerProcessAlive -and `
      [bool]$preWebRuntimeGeneration.brokerHeartbeatFresh -and `
      [string]$preWebRuntimeGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED') -and `
      $preWebRunningCanonicalProcessIds.Count -eq 1 -and `
      $preWebRunningInstanceCount -eq 1 -and `
      [int]$preWebRunningCanonicalProcessIds[0] -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
      [string]$preWebRunningBrokerAttestation.component -eq 'lifecycle-broker' -and `
      [int]$preWebRunningBrokerAttestation.pid -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
      $preWebRunningAttestedLauncherSha256 -eq $preWebExpectedLauncherSha256 -and `
      [bool]$preWebRunningOwnership.owned -and `
      [bool]$preWebRunningOwnership.canonical -and `
      -not [bool]$preWebRunningOwnership.repairRequired -and `
      $preWebRunningDrift.Count -eq 0 -and `
      (Test-Phase7CSystemTaskPrincipal $preWebTask.Principal)
    if (-not $preWebRunningReleasedLockStillEligible) {
      throw "RUNNING+READY released-lock canonical broker tuple changed during safety recheck; lifecycle stop blocked."
    }

    Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"
    Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK"
    [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})
    Wait-LifecycleStopped
    Assert-LifecycleExecutorsStopped -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"
    Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"
    Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_POST_STOP"
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RUNNING_RELEASED_LOCK_LIFECYCLE_STOP=PASS"

    # Re-snapshot after lifecycle quiesce; the existing stopped-lifecycle proof below
    # must independently re-authorize the exact Scheduled Task generation restart.
    $preWebRuntimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
    $preWebLifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
    $preWebTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  }

  $preWebLifecycleStopped = `
    -not [bool]$preWebLifecycle.running -and `
    -not (Test-Phase7CLifecycleHasAliveProcess -State $preWebLifecycle)
  $preWebHealthyGenerationEligible = `
    $preWebLifecycleStopped -and `
    [string]$preWebTask.State -eq 'Running' -and `
    [string]$preWebRuntimeGeneration.statusReadState -eq 'OK' -and `
    [string]$preWebRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
    [bool]$preWebRuntimeGeneration.brokerStatusPidMatch -and `
    [bool]$preWebRuntimeGeneration.brokerProcessAlive -and `
    [bool]$preWebRuntimeGeneration.brokerHeartbeatFresh -and `
    [string]$preWebRuntimeGeneration.startupRunnerLockState -eq 'HELD'

  $preWebCanonicalProcessIds = @()
  $preWebRunningInstanceCount = -1
  $preWebBrokerAttestation = $null
  $preWebAttestedLauncherSha256 = ''
  $preWebReleasedOwnership = $null
  $preWebReleasedDrift = @('UNREAD')
  $preWebReleasedLockRepairEligible = $false
  $preWebReleasedLockCandidate = `
    $preWebLifecycleStopped -and `
    [string]$preWebTask.State -eq 'Running' -and `
    [string]$preWebRuntimeGeneration.statusReadState -eq 'OK' -and `
    [string]$preWebRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
    [bool]$preWebRuntimeGeneration.brokerStatusPidMatch -and `
    [bool]$preWebRuntimeGeneration.brokerProcessAlive -and `
    [bool]$preWebRuntimeGeneration.brokerHeartbeatFresh -and `
    [string]$preWebRuntimeGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED')

  if ($preWebReleasedLockCandidate) {
    try {
      $preWebCanonicalProcessIds = @(Get-Phase7CCanonicalTaskProcessIds -Task $preWebTask)
      $preWebRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
      $preWebBrokerAttestation = Read-JsonFile -Path $preWebBrokerAttestationPath -Label "Lifecycle broker source attestation before pre-Web generation reload"
      $preWebAttestedLauncherSha256 = ([string]$preWebBrokerAttestation.launcherSha256).Trim().ToLowerInvariant()
      $preWebReleasedOwnership = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $preWebTask.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $preWebReleasedDrift = @(Get-Phase7CExecutorTaskDrift -Task $preWebTask)
      $preWebReleasedLockRepairEligible = `
        $preWebCanonicalProcessIds.Count -eq 1 -and `
        $preWebRunningInstanceCount -eq 1 -and `
        [int]$preWebCanonicalProcessIds[0] -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
        [string]$preWebBrokerAttestation.component -eq 'lifecycle-broker' -and `
        [int]$preWebBrokerAttestation.pid -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
        $preWebAttestedLauncherSha256 -eq $preWebExpectedLauncherSha256 -and `
        [bool]$preWebReleasedOwnership.owned -and `
        [bool]$preWebReleasedOwnership.canonical -and `
        -not [bool]$preWebReleasedOwnership.repairRequired -and `
        $preWebReleasedDrift.Count -eq 0 -and `
        (Test-Phase7CSystemTaskPrincipal $preWebTask.Principal)
    } catch {
      $preWebReleasedLockRepairEligible = $false
    }
  }

  $preWebGenerationEligible = $preWebHealthyGenerationEligible -or $preWebReleasedLockRepairEligible

  if ($preWebLifecycleStopped) {
    if (-not $preWebGenerationEligible) {
      throw "Stopped lifecycle requires a proven canonical SYSTEM generation before strict Web/API deploy. taskState=$($preWebTask.State) brokerAlive=$($preWebRuntimeGeneration.brokerProcessAlive) heartbeatFresh=$($preWebRuntimeGeneration.brokerHeartbeatFresh) lock=$($preWebRuntimeGeneration.startupRunnerLockState) canonicalProcesses=$($preWebCanonicalProcessIds.Count) taskInstances=$preWebRunningInstanceCount"
    }
    if ($preWebReleasedLockRepairEligible) {
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RELEASED_LOCK=ELIGIBLE_REPAIR_REQUIRED"
      Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"
      Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"
    }

    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB=ELIGIBLE"
    Assert-LifecycleExecutorsStopped -Stage "GENERATION_PRE_WEB"
    Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB"
    Assert-FlatBroker -Stage "GENERATION_PRE_WEB"

    $preWebOwnership = Test-Phase7CExecutorTaskActionOwnership `
      -Actions $preWebTask.Actions `
      -ExpectedRunnerPath $runnerPath `
      -ExpectedRunnerSha256 $trustedRunnerSha256
    $preWebDrift = @(Get-Phase7CExecutorTaskDrift -Task $preWebTask)
    if (-not [bool]$preWebOwnership.owned -or -not [bool]$preWebOwnership.canonical -or [bool]$preWebOwnership.repairRequired -or $preWebDrift.Count -ne 0) {
      throw "Canonical pre-Web source generation reload requires the Scheduled Task to remain exact canonical. ownership=$($preWebOwnership.reason) drift=$($preWebDrift -join ',')"
    }
    if (-not (Test-Phase7CSystemTaskPrincipal $preWebTask.Principal)) {
      throw "Canonical pre-Web source generation reload requires SYSTEM + ServiceAccount + Highest."
    }

    if ($preWebReleasedLockRepairEligible) {
      # Re-prove the exact abnormal singleton tuple immediately before stopping
      # the only canonical SYSTEM task. A released lock is repair-required and
      # is never normalized to a healthy generation state.
      $preWebTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $preWebRuntimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
      $preWebCanonicalProcessIds = @(Get-Phase7CCanonicalTaskProcessIds -Task $preWebTask)
      $preWebRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
      $preWebBrokerAttestation = Read-JsonFile -Path $preWebBrokerAttestationPath -Label "Lifecycle broker source attestation during released-lock safety recheck"
      $preWebAttestedLauncherSha256 = ([string]$preWebBrokerAttestation.launcherSha256).Trim().ToLowerInvariant()
      $preWebReleasedOwnership = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $preWebTask.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $preWebReleasedDrift = @(Get-Phase7CExecutorTaskDrift -Task $preWebTask)
      $preWebReleasedLockStillEligible = `
        [string]$preWebTask.State -eq 'Running' -and `
        [string]$preWebRuntimeGeneration.statusReadState -eq 'OK' -and `
        [string]$preWebRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
        [bool]$preWebRuntimeGeneration.brokerStatusPidMatch -and `
        [bool]$preWebRuntimeGeneration.brokerProcessAlive -and `
        [bool]$preWebRuntimeGeneration.brokerHeartbeatFresh -and `
        [string]$preWebRuntimeGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED') -and `
        $preWebCanonicalProcessIds.Count -eq 1 -and `
        $preWebRunningInstanceCount -eq 1 -and `
        [int]$preWebCanonicalProcessIds[0] -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
        [string]$preWebBrokerAttestation.component -eq 'lifecycle-broker' -and `
        [int]$preWebBrokerAttestation.pid -eq [int]$preWebRuntimeGeneration.statusBrokerPid -and `
        $preWebAttestedLauncherSha256 -eq $preWebExpectedLauncherSha256 -and `
        [bool]$preWebReleasedOwnership.owned -and `
        [bool]$preWebReleasedOwnership.canonical -and `
        -not [bool]$preWebReleasedOwnership.repairRequired -and `
        $preWebReleasedDrift.Count -eq 0 -and `
        (Test-Phase7CSystemTaskPrincipal $preWebTask.Principal)
      if (-not $preWebReleasedLockStillEligible) {
        throw "Released-lock canonical broker tuple changed during safety recheck; task restart blocked."
      }
      Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"
      Assert-FlatBroker -Stage "GENERATION_PRE_WEB_RELEASED_LOCK"
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_RELEASED_LOCK_RECHECK=PASS"
    }

    $preWebBrokerPidBeforeStop = Get-Phase7CBrokerPidFromHeartbeat
    if ($preWebBrokerPidBeforeStop -le 0) {
      throw "Canonical pre-Web source generation reload could not capture the current lifecycle broker PID."
    }

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $preWebTaskStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    $preWebTaskStopped = $false
    do {
      Start-Sleep -Milliseconds 250
      $preWebTaskAfterStop = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      if ([string]$preWebTaskAfterStop.State -notin @('Running', 'Queued')) {
        $preWebTaskStopped = $true
        break
      }
    } while ([DateTime]::UtcNow -lt $preWebTaskStopDeadline)
    if (-not $preWebTaskStopped) {
      throw "Canonical pre-Web source generation Scheduled Task did not quiesce. state=$($preWebTaskAfterStop.State)"
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_STOP=PASS"

    $preWebBrokerStopped = $false
    $preWebBrokerStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    while (-not $preWebBrokerStopped -and [DateTime]::UtcNow -lt $preWebBrokerStopDeadline) {
      if ($null -eq (Get-Process -Id $preWebBrokerPidBeforeStop -ErrorAction SilentlyContinue)) {
        $preWebBrokerStopped = $true
        break
      }
      Start-Sleep -Milliseconds 250
    }
    if (-not $preWebBrokerStopped) {
      throw "Previous lifecycle broker process remained alive after canonical pre-Web generation task stop. pid=$preWebBrokerPidBeforeStop"
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_BROKER_PROCESS_STOP=PASS|PREVIOUS_PID=$preWebBrokerPidBeforeStop"

    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $preWebTaskRestartDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
    $preWebBrokerPid = 0
    $preWebTaskRestarted = $false
    do {
      Start-Sleep -Milliseconds 250
      $preWebTaskAfterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      if ([string]$preWebTaskAfterStart.State -eq 'Running' -and (Test-Phase7CBrokerHeartbeatFresh)) {
        $preWebBrokerPid = Get-Phase7CBrokerPidFromHeartbeat
        if ($preWebBrokerPid -gt 0 -and $preWebBrokerPid -ne $preWebBrokerPidBeforeStop) {
          $preWebTaskRestarted = $true
          break
        }
      }
    } while ([DateTime]::UtcNow -lt $preWebTaskRestartDeadline)
    if (-not $preWebTaskRestarted) {
      $orphanQueuedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $orphanRuntimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
      $orphanCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $orphanQueuedTask
      $orphanRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
      $orphanOwnership = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $orphanQueuedTask.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $orphanDrift = @(Get-Phase7CExecutorTaskDrift -Task $orphanQueuedTask)
      $orphanQueuedEligible = `
        [string]$orphanQueuedTask.State -eq 'Queued' -and `
        $orphanCanonicalProcessCount -eq 0 -and `
        $orphanRunningInstanceCount -eq 0 -and `
        [string]$orphanRuntimeGeneration.statusReadState -eq 'OK' -and `
        [string]$orphanRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
        [bool]$orphanRuntimeGeneration.brokerStatusPidMatch -and `
        -not [bool]$orphanRuntimeGeneration.brokerProcessAlive -and `
        -not [bool]$orphanRuntimeGeneration.brokerHeartbeatFresh -and `
        [string]$orphanRuntimeGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED') -and `
        [bool]$orphanOwnership.owned -and `
        [bool]$orphanOwnership.canonical -and `
        -not [bool]$orphanOwnership.repairRequired -and `
        $orphanDrift.Count -eq 0 -and `
        (Test-Phase7CSystemTaskPrincipal $orphanQueuedTask.Principal)

      if ($orphanQueuedEligible) {
        Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED"
        Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED"
        Assert-FlatBroker -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED"

        # Re-sample the exact production tuple immediately before the only new
        # mutation. Any unreadable/changed evidence fails closed instead of clearing
        # an unproven Scheduler state.
        $orphanQueuedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $orphanRuntimeGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
        $orphanCanonicalProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $orphanQueuedTask
        $orphanRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
        $orphanOwnership = Test-Phase7CExecutorTaskActionOwnership `
          -Actions $orphanQueuedTask.Actions `
          -ExpectedRunnerPath $runnerPath `
          -ExpectedRunnerSha256 $trustedRunnerSha256
        $orphanDrift = @(Get-Phase7CExecutorTaskDrift -Task $orphanQueuedTask)
        $orphanStillEligible = `
          [string]$orphanQueuedTask.State -eq 'Queued' -and `
          $orphanCanonicalProcessCount -eq 0 -and `
          $orphanRunningInstanceCount -eq 0 -and `
          [string]$orphanRuntimeGeneration.statusReadState -eq 'OK' -and `
          [string]$orphanRuntimeGeneration.heartbeatReadState -eq 'OK' -and `
          [bool]$orphanRuntimeGeneration.brokerStatusPidMatch -and `
          -not [bool]$orphanRuntimeGeneration.brokerProcessAlive -and `
          -not [bool]$orphanRuntimeGeneration.brokerHeartbeatFresh -and `
          [string]$orphanRuntimeGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED') -and `
          [bool]$orphanOwnership.owned -and `
          [bool]$orphanOwnership.canonical -and `
          -not [bool]$orphanOwnership.repairRequired -and `
          $orphanDrift.Count -eq 0 -and `
          (Test-Phase7CSystemTaskPrincipal $orphanQueuedTask.Principal)
        if (-not $orphanStillEligible) {
          throw "Canonical pre-Web orphan queue changed during safety recheck; bounded retry blocked."
        }

        Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED=ELIGIBLE"
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $orphanClearDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
        $orphanQueueCleared = $false
        do {
          Start-Sleep -Milliseconds 250
          $orphanAfterClear = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
          $orphanAfterClearGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
          $orphanAfterClearProcessCount = Get-Phase7CCanonicalTaskProcessCount -Task $orphanAfterClear
          $orphanAfterClearInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
          if (`
            [string]$orphanAfterClear.State -notin @('Running', 'Queued') -and `
            $orphanAfterClearProcessCount -eq 0 -and `
            $orphanAfterClearInstanceCount -eq 0 -and `
            -not [bool]$orphanAfterClearGeneration.brokerProcessAlive -and `
            [string]$orphanAfterClearGeneration.startupRunnerLockState -in @('MISSING', 'RELEASED')
          ) {
            $orphanQueueCleared = $true
            break
          }
        } while ([DateTime]::UtcNow -lt $orphanClearDeadline)
        if (-not $orphanQueueCleared) {
          throw "Canonical pre-Web orphan queued request did not clear safely. taskState=$($orphanAfterClear.State) canonicalProcesses=$orphanAfterClearProcessCount taskInstances=$orphanAfterClearInstanceCount lock=$($orphanAfterClearGeneration.startupRunnerLockState)"
        }
        Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED_CLEAR=PASS"

        $orphanRetryTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $orphanRetryOwnership = Test-Phase7CExecutorTaskActionOwnership `
          -Actions $orphanRetryTask.Actions `
          -ExpectedRunnerPath $runnerPath `
          -ExpectedRunnerSha256 $trustedRunnerSha256
        $orphanRetryDrift = @(Get-Phase7CExecutorTaskDrift -Task $orphanRetryTask)
        if (-not [bool]$orphanRetryOwnership.owned -or -not [bool]$orphanRetryOwnership.canonical -or [bool]$orphanRetryOwnership.repairRequired -or $orphanRetryDrift.Count -ne 0 -or -not (Test-Phase7CSystemTaskPrincipal $orphanRetryTask.Principal)) {
          throw "Canonical pre-Web orphan queue clear changed task definition; retry blocked."
        }
        Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED_PRE_RETRY"
        Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED_PRE_RETRY"
        Assert-FlatBroker -Stage "GENERATION_PRE_WEB_ORPHAN_QUEUED_PRE_RETRY"

        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_ORPHAN_QUEUED_RESTART_RETRY=ONCE"
        $orphanRetryDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
        do {
          Start-Sleep -Milliseconds 250
          $preWebTaskAfterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
          if ([string]$preWebTaskAfterStart.State -eq 'Running' -and (Test-Phase7CBrokerHeartbeatFresh)) {
            $preWebBrokerPid = Get-Phase7CBrokerPidFromHeartbeat
            if ($preWebBrokerPid -gt 0 -and $preWebBrokerPid -ne $preWebBrokerPidBeforeStop) {
              $preWebTaskRestarted = $true
              break
            }
          }
        } while ([DateTime]::UtcNow -lt $orphanRetryDeadline)
      }
    }
    if (-not $preWebTaskRestarted) {
      $failureTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      $failureGeneration = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir
      $failureCanonicalProcessCount = if ($null -ne $failureTask) { Get-Phase7CCanonicalTaskProcessCount -Task $failureTask } else { -1 }
      $failureRunningInstanceCount = Get-Phase7CRunningTaskInstanceCount -Name $TaskName
      throw "Canonical pre-Web source generation task restart did not produce a fresh new lifecycle broker. previousPid=$preWebBrokerPidBeforeStop currentPid=$preWebBrokerPid taskState=$([string]$failureTask.State) canonicalProcesses=$failureCanonicalProcessCount taskInstances=$failureRunningInstanceCount brokerAlive=$($failureGeneration.brokerProcessAlive) heartbeatFresh=$($failureGeneration.brokerHeartbeatFresh) lock=$($failureGeneration.startupRunnerLockState)"
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_TASK_RESTART=PASS|BROKER_PID=$preWebBrokerPid"

    $preWebTaskVerified = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $preWebOwnershipVerified = Test-Phase7CExecutorTaskActionOwnership `
      -Actions $preWebTaskVerified.Actions `
      -ExpectedRunnerPath $runnerPath `
      -ExpectedRunnerSha256 $trustedRunnerSha256
    $preWebDriftVerified = @(Get-Phase7CExecutorTaskDrift -Task $preWebTaskVerified)
    if (-not [bool]$preWebOwnershipVerified.owned -or -not [bool]$preWebOwnershipVerified.canonical -or [bool]$preWebOwnershipVerified.repairRequired -or $preWebDriftVerified.Count -ne 0) {
      throw "Canonical pre-Web source generation task changed definition during restart. ownership=$($preWebOwnershipVerified.reason) drift=$($preWebDriftVerified -join ',')"
    }
    if (-not (Test-Phase7CSystemTaskPrincipal $preWebTaskVerified.Principal)) {
      throw "Canonical pre-Web source generation task restart did not preserve SYSTEM + ServiceAccount + Highest."
    }

    $preWebBrokerAttestationPath = Join-Path $WorkDir "phase7c-source-attestation\components\lifecycle-broker.json"
    $preWebBrokerAttestation = Read-JsonFile -Path $preWebBrokerAttestationPath -Label "Lifecycle broker source attestation after pre-Web generation reload"
    if ([string]$preWebBrokerAttestation.component -ne 'lifecycle-broker' -or `
        [string]$preWebBrokerAttestation.deploymentId -ne [string]$deployment.deploymentId -or `
        [string]$preWebBrokerAttestation.sourceCommit -ne [string]$deployment.sourceCommit -or `
        [string]$preWebBrokerAttestation.sourceTree -ne [string]$deployment.sourceTree -or `
        [int]$preWebBrokerAttestation.pid -ne $preWebBrokerPid) {
      throw "Canonical pre-Web source generation broker attestation does not match the new deployment."
    }

    $preWebLockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
    $preWebLockState = Get-Phase7CReadOnlyLockState -Path $preWebLockPath
    if ($preWebLockState -ne 'HELD') {
      throw "Canonical pre-Web source generation task restart did not restore the startup-runner singleton lock. state=$preWebLockState"
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_STARTUP_RUNNER_LOCK=HELD"

    Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_POST_TASK_RESTART"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_POST_TASK_RESTART"
    Assert-FlatBroker -Stage "GENERATION_PRE_WEB_POST_TASK_RESTART"

    [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
    if (-not (Wait-LifecycleReadyStable -ProbeTimeoutSeconds ([Math]::Min($TimeoutSeconds, 30)))) {
      throw "Lifecycle did not return to stable READY after canonical pre-Web source generation reload."
    }
    Assert-PauseDisarmed -Stage "GENERATION_PRE_WEB_READY"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "GENERATION_PRE_WEB_READY"
    Assert-FlatBroker -Stage "GENERATION_PRE_WEB_READY"
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_PRE_WEB_LIFECYCLE_READY=PASS"

    $runtimeSourceGenerationReloadRequired = $false
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_SOURCE_GENERATION_RELOAD=SATISFIED_PRE_WEB"
  }
}

  # Load the exact accepted Web/API source before any ordinary executor or SYSTEM task stop.
  # Proven battery and stopped-lifecycle generation outages may be restored above first so
  # the unchanged strict dashboard verifier always sees a healthy executor generation.
  $webApiDeployArgs = @()
  if ($taskProvenanceRepairRequired) {
    $webApiDeployArgs += @(
      '-AllowOwnedTaskProvenanceMigration',
      '-ExpectedRunnerSha256', $trustedRunnerSha256
    )
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_WEB_API_MIGRATION_WINDOW=ENABLED_OWNED_REPAIR_REQUIRED"
  } else {
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_WEB_API_MIGRATION_WINDOW=DISABLED_CANONICAL_TASK"
  }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $WebApiDeploy `
    -WorkDir $WorkDir `
    -ExpectedCommit $ExpectedCommit `
    @webApiDeployArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Canonical Web/API deploy failed with exit code $LASTEXITCODE."
  }
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_WEB_API_DEPLOY=PASS"

  Assert-PauseDisarmed -Stage "POST_WEB_API_DEPLOY"
  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_WEB_API_DEPLOY"
  Assert-FlatBroker -Stage "POST_WEB_API_DEPLOY"

  $stableBeforeRecovery = Wait-LifecycleReadyStable -ProbeTimeoutSeconds 8
  if ($stableBeforeRecovery -and -not $taskRepairRequired -and -not $runtimeSourceGenerationReloadRequired) {
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_LIFECYCLE_RECOVERY=SKIPPED_ALREADY_STABLE"
  } else {
    Assert-PauseDisarmed -Stage "PRE_LIFECYCLE_RECOVERY"
    Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "PRE_LIFECYCLE_RECOVERY"
    Assert-FlatBroker -Stage "PRE_LIFECYCLE_RECOVERY"

    $currentLifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
    $currentLifecycleNeedsStop = [bool]$currentLifecycle.running -or (Test-Phase7CLifecycleHasAliveProcess -State $currentLifecycle)
    if ($currentLifecycleNeedsStop) {
      [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/stop" @{})
      Wait-LifecycleStopped
      Assert-PauseDisarmed -Stage "POST_STOP"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_STOP"
      Assert-FlatBroker -Stage "POST_STOP"
    }

    if ($taskRepairRequired) {
      Assert-LifecycleExecutorsStopped -Stage "PRE_TASK_REPAIR"
      Assert-PauseDisarmed -Stage "PRE_TASK_REPAIR"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "PRE_TASK_REPAIR"
      Assert-FlatBroker -Stage "PRE_TASK_REPAIR"

      $brokerPidBeforeTaskStop = Get-Phase7CBrokerPidFromHeartbeat
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $taskStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
      $taskStopped = $false
      do {
        Start-Sleep -Milliseconds 250
        $stoppedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ([string]$stoppedTask.State -ne 'Running') {
          $taskStopped = $true
          break
        }
      } while ([DateTime]::UtcNow -lt $taskStopDeadline)
      if (-not $taskStopped) {
        throw "Owned Scheduled Task did not stop before provenance repair."
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_STOP=PASS"

      $brokerProcessStopped = $brokerPidBeforeTaskStop -le 0
      $brokerStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
      while (-not $brokerProcessStopped -and [DateTime]::UtcNow -lt $brokerStopDeadline) {
        if ($null -eq (Get-Process -Id $brokerPidBeforeTaskStop -ErrorAction SilentlyContinue)) {
          $brokerProcessStopped = $true
          break
        }
        Start-Sleep -Milliseconds 250
      }
      if (-not $brokerProcessStopped) {
        throw "Previous lifecycle broker process remained alive after Scheduled Task stop. pid=$brokerPidBeforeTaskStop"
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BROKER_PROCESS_STOP=PASS|PREVIOUS_PID=$brokerPidBeforeTaskStop"

      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $TaskInstaller `
        -TaskName $TaskName `
        -ProjectRoot $ProjectRoot `
        -Repair `
        -ApiUserSid $apiUserSid
      if ($LASTEXITCODE -ne 0) {
        throw "Canonical Scheduled Task provenance repair failed with exit code $LASTEXITCODE."
      }

      $repairedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $repairedOwnership = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $repairedTask.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $repairedDefinitionDrift = @(Get-Phase7CExecutorTaskDrift -Task $repairedTask)
      if (-not [bool]$repairedOwnership.owned -or -not [bool]$repairedOwnership.canonical -or [bool]$repairedOwnership.repairRequired -or $repairedDefinitionDrift.Count -ne 0) {
        throw "Scheduled Task repair did not converge to the canonical trusted definition. ownership=$($repairedOwnership.reason) drift=$($repairedDefinitionDrift -join ',')"
      }
      if (-not (Test-Phase7CSystemTaskPrincipal $repairedTask.Principal)) {
        throw "Scheduled Task provenance repair did not preserve SYSTEM + ServiceAccount + Highest."
      }
      if (-not (Test-Phase7CBrokerHeartbeatFresh)) {
        throw "Scheduled Task provenance repair did not return a fresh lifecycle broker heartbeat."
      }

      $postRepairLockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
      $postRepairLockState = Get-Phase7CReadOnlyLockState -Path $postRepairLockPath
      if ($postRepairLockState -ne 'HELD') {
        throw "Scheduled Task provenance repair did not restore the startup-runner singleton lock. state=$postRepairLockState"
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_POST_REPAIR_STARTUP_RUNNER_LOCK=HELD"

      Assert-PauseDisarmed -Stage "POST_TASK_REPAIR"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_TASK_REPAIR"
      Assert-FlatBroker -Stage "POST_TASK_REPAIR"
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE=CANONICAL_HASH_GUARD"
      if ($taskProvenanceRepairRequired) {
        Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_PROVENANCE_REPAIR=PERFORMED"
      } else {
        Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_TASK_DEFINITION_REPAIR=PERFORMED_BATTERY_SETTINGS"
      }
    } elseif ($runtimeSourceGenerationReloadRequired) {
      Assert-LifecycleExecutorsStopped -Stage "PRE_GENERATION_RELOAD"
      Assert-PauseDisarmed -Stage "PRE_GENERATION_RELOAD"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "PRE_GENERATION_RELOAD"
      Assert-FlatBroker -Stage "PRE_GENERATION_RELOAD"

      $generationTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $generationOwnership = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $generationTask.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $generationDrift = @(Get-Phase7CExecutorTaskDrift -Task $generationTask)
      if (-not [bool]$generationOwnership.owned -or -not [bool]$generationOwnership.canonical -or [bool]$generationOwnership.repairRequired -or $generationDrift.Count -ne 0) {
        throw "Canonical source generation reload requires the Scheduled Task to remain exact canonical. ownership=$($generationOwnership.reason) drift=$($generationDrift -join ',')"
      }
      if (-not (Test-Phase7CSystemTaskPrincipal $generationTask.Principal)) {
        throw "Canonical source generation reload requires SYSTEM + ServiceAccount + Highest."
      }

      $brokerPidBeforeGenerationStop = Get-Phase7CBrokerPidFromHeartbeat
      if ($brokerPidBeforeGenerationStop -le 0) {
        throw "Canonical source generation reload could not capture the current lifecycle broker PID."
      }

      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $generationTaskStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
      $generationTaskStopped = $false
      do {
        Start-Sleep -Milliseconds 250
        $generationTaskAfterStop = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ([string]$generationTaskAfterStop.State -notin @('Running', 'Queued')) {
          $generationTaskStopped = $true
          break
        }
      } while ([DateTime]::UtcNow -lt $generationTaskStopDeadline)
      if (-not $generationTaskStopped) {
        throw "Canonical source generation Scheduled Task did not quiesce. state=$($generationTaskAfterStop.State)"
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_TASK_STOP=PASS"

      $generationBrokerStopped = $false
      $generationBrokerStopDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
      while (-not $generationBrokerStopped -and [DateTime]::UtcNow -lt $generationBrokerStopDeadline) {
        if ($null -eq (Get-Process -Id $brokerPidBeforeGenerationStop -ErrorAction SilentlyContinue)) {
          $generationBrokerStopped = $true
          break
        }
        Start-Sleep -Milliseconds 250
      }
      if (-not $generationBrokerStopped) {
        throw "Previous lifecycle broker process remained alive after canonical source generation task stop. pid=$brokerPidBeforeGenerationStop"
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_BROKER_PROCESS_STOP=PASS|PREVIOUS_PID=$brokerPidBeforeGenerationStop"

      Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $generationTaskRestartDeadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 30))
      $generationBrokerPid = 0
      $generationTaskRestarted = $false
      do {
        Start-Sleep -Milliseconds 250
        $generationTaskAfterStart = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ([string]$generationTaskAfterStart.State -eq 'Running' -and (Test-Phase7CBrokerHeartbeatFresh)) {
          $generationBrokerPid = Get-Phase7CBrokerPidFromHeartbeat
          if ($generationBrokerPid -gt 0 -and $generationBrokerPid -ne $brokerPidBeforeGenerationStop) {
            $generationTaskRestarted = $true
            break
          }
        }
      } while ([DateTime]::UtcNow -lt $generationTaskRestartDeadline)
      if (-not $generationTaskRestarted) {
        throw "Canonical source generation task restart did not produce a fresh new lifecycle broker. previousPid=$brokerPidBeforeGenerationStop currentPid=$generationBrokerPid"
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_TASK_RESTART=PASS|BROKER_PID=$generationBrokerPid"

      $generationTaskVerified = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $generationOwnershipVerified = Test-Phase7CExecutorTaskActionOwnership `
        -Actions $generationTaskVerified.Actions `
        -ExpectedRunnerPath $runnerPath `
        -ExpectedRunnerSha256 $trustedRunnerSha256
      $generationDriftVerified = @(Get-Phase7CExecutorTaskDrift -Task $generationTaskVerified)
      if (-not [bool]$generationOwnershipVerified.owned -or -not [bool]$generationOwnershipVerified.canonical -or [bool]$generationOwnershipVerified.repairRequired -or $generationDriftVerified.Count -ne 0) {
        throw "Canonical source generation task changed definition during restart. ownership=$($generationOwnershipVerified.reason) drift=$($generationDriftVerified -join ',')"
      }
      if (-not (Test-Phase7CSystemTaskPrincipal $generationTaskVerified.Principal)) {
        throw "Canonical source generation task restart did not preserve SYSTEM + ServiceAccount + Highest."
      }

      $generationBrokerAttestationPath = Join-Path $WorkDir "phase7c-source-attestation\components\lifecycle-broker.json"
      $generationBrokerAttestation = Read-JsonFile -Path $generationBrokerAttestationPath -Label "Lifecycle broker source attestation after generation reload"
      if ([string]$generationBrokerAttestation.component -ne 'lifecycle-broker' -or `
          [string]$generationBrokerAttestation.deploymentId -ne [string]$deployment.deploymentId -or `
          [string]$generationBrokerAttestation.sourceCommit -ne [string]$deployment.sourceCommit -or `
          [string]$generationBrokerAttestation.sourceTree -ne [string]$deployment.sourceTree -or `
          [int]$generationBrokerAttestation.pid -ne $generationBrokerPid) {
        throw "Canonical source generation broker attestation does not match the new deployment."
      }

      $generationLockPath = Join-Path $WorkDir "phase7c-executors\startup-runner.lock"
      $generationLockState = Get-Phase7CReadOnlyLockState -Path $generationLockPath
      if ($generationLockState -ne 'HELD') {
        throw "Canonical source generation task restart did not restore the startup-runner singleton lock. state=$generationLockState"
      }
      Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_GENERATION_STARTUP_RUNNER_LOCK=HELD"

      Assert-PauseDisarmed -Stage "POST_GENERATION_RELOAD"
      Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "POST_GENERATION_RELOAD"
      Assert-FlatBroker -Stage "POST_GENERATION_RELOAD"
    }

    [void](Invoke-ApiPost "/api/v1/phase7c/lifecycle/start" @{})
    if (-not (Wait-LifecycleReadyStable -ProbeTimeoutSeconds ([Math]::Min($TimeoutSeconds, 30)))) {
      throw "Lifecycle did not remain continuously READY for 5000ms after controlled recovery."
    }
    Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_LIFECYCLE_RECOVERY=PERFORMED"
  }

  Assert-PauseDisarmed -Stage "FINAL"
  Assert-BridgeSession -ExpectedSession $bridgeSessionId -Stage "FINAL"
  Assert-FlatBroker -Stage "FINAL"

  $finalRuntimeSourceGenerationStatus = Get-Phase7CRuntimeSourceGenerationAttestationStatus `
    -RuntimeRoot $WorkDir `
    -TargetDeployment $deployment
  if (-not [bool]$finalRuntimeSourceGenerationStatus.exactMatch) {
    $finalMismatchComponents = @($finalRuntimeSourceGenerationStatus.mismatchComponents) -join ','
    $finalMismatchReasons = @($finalRuntimeSourceGenerationStatus.reasonCodes) -join ','
    throw "FINAL runtime source attestation mismatch. components=$finalMismatchComponents reasons=$finalMismatchReasons"
  }
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_FINAL_SOURCE_ATTESTATION=EXACT"

  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_STATUS=PASS"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_FINAL_MODE=PAUSE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_FINAL_ARM=DISARMED"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BRIDGE_SESSION_UNCHANGED=PASS"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_LIVE_TEST_ORDER=NONE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_NEXT_ACTION=VERIFY_THEN_EXPLICIT_ARM_ONLY"
} catch {
  $originalError = $_.Exception.Message
  if ($mutationStarted) {
    try { Set-Pause "runtime-ready-stable-recovery-fail-closed" } catch {}
    try {
      $armNow = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
      if ([string]$armNow.liveArmStatus -ne "DISARMED" -or [bool]$armNow.liveExecutionArmed) {
        Invoke-CanonicalDisarm
      }
    } catch {}
  }
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_FAIL_CLOSED_MODE=PAUSE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_FAIL_CLOSED_ARM=DISARMED_BEST_EFFORT"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_BRIDGE_RESTART=NONE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_ORDER_MUTATION=NONE"
  Write-Host "PHASE7C_RUNTIME_READY_STABLE_RECOVERY_LIVE_TEST_ORDER=NONE"
  throw $originalError
}