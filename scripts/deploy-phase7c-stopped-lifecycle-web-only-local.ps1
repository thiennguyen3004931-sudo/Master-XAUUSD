param(
  [string]$WorkDir = ".runtime",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$StartupTimeoutSeconds = 90,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedCommit,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedTree,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{32}$')]
  [string]$ExpectedDeploymentId
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WebTask = "XAUUSD-Phase7B-Web"
$ExpectedWebRunner = Join-Path $PSScriptRoot "run-phase7b-web-autostart.ps1"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
$ExecutorConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"

foreach ($required in @($ExpectedWebRunner, $AccountLibrary, $RuntimeSourceAttestationLibrary, $ExecutorConfigPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Stopped-lifecycle Web-only deploy required file is missing: $required"
  }
}
. $AccountLibrary
. $RuntimeSourceAttestationLibrary

if ($ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw "ApiPort is invalid." }
if ($WebPort -lt 1024 -or $WebPort -gt 65535) { throw "WebPort is invalid." }
if ($ApiPort -eq $WebPort) { throw "ApiPort and WebPort must be different." }
if ($StartupTimeoutSeconds -lt 30 -or $StartupTimeoutSeconds -gt 300) {
  throw "StartupTimeoutSeconds must be between 30 and 300."
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing: $Path"
  }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label file is invalid JSON: $Path. $($_.Exception.Message)" }
}

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "Path value is required." }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Invoke-ControlGet([string]$Path) {
  return Invoke-RestMethod -Uri "$ControlApiUrl$Path" -Method Get -TimeoutSec 8
}

function Invoke-BridgeGet([string]$Path) {
  return Invoke-RestMethod -Uri "$BridgeBase$Path" -Headers $BridgeHeaders -Method Get -TimeoutSec 8
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

function Get-ProcessTable {
  $table = @{}
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    $table[[int]$process.ProcessId] = $process
  }
  return $table
}

function Test-ProcessDescendant {
  param(
    [Parameter(Mandatory = $true)] [int]$ProcessId,
    [Parameter(Mandatory = $true)] [int]$AncestorProcessId,
    [Parameter(Mandatory = $true)] [hashtable]$ProcessTable
  )

  $cursor = $ProcessId
  for ($depth = 0; $depth -lt 32; $depth++) {
    if ($cursor -eq $AncestorProcessId) { return $true }
    if (-not $ProcessTable.ContainsKey($cursor)) { break }
    $parentProcessId = [int]$ProcessTable[$cursor].ParentProcessId
    if ($parentProcessId -le 0) { break }
    $cursor = $parentProcessId
  }
  return $false
}

function Get-SingleListenerPid([int]$Port, [string]$Label) {
  $listeners = @(
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [string]$_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0', '::') }
  )
  if ($listeners.Count -ne 1) {
    throw "$Label requires exactly one listener on port $Port. current=$($listeners.Count)"
  }
  return [int]$listeners[0].OwningProcess
}

function Assert-LifecycleStopped($State, [string]$Stage) {
  if ($null -eq $State) { throw "$Stage lifecycle state is missing." }
  if ([bool]$State.running) { throw "$Stage requires LIFECYCLE_RUNNING=false." }
  if ([bool]$State.ready) { throw "$Stage requires LIFECYCLE_READY=false." }
  if ($null -eq $State.processes) { throw "$Stage lifecycle process status is unavailable." }

  $alive = @()
  foreach ($property in @($State.processes.PSObject.Properties)) {
    if ($null -ne $property.Value -and [bool]$property.Value.alive) {
      $alive += [string]$property.Name
    }
  }
  if ($alive.Count -ne 0) {
    throw "$Stage requires zero alive lifecycle processes. alive=$($alive -join ',')"
  }

  foreach ($requiredRole in @('supervisor', 'trend', 'sideway')) {
    $roleProperty = $State.processes.PSObject.Properties[$requiredRole]
    if ($null -ne $roleProperty -and $null -ne $roleProperty.Value -and [bool]$roleProperty.Value.alive) {
      throw "$Stage requires stopped $requiredRole process."
    }
  }
}

function Get-SafetySnapshot([string]$Stage) {
  $mode = Invoke-ControlGet "/api/v1/phase7c/bot-mode"
  if ([string]$mode.state.mode -ne "PAUSE") {
    throw "$Stage requires BOT_MODE=PAUSE. actual=$($mode.state.mode)"
  }

  $arm = Invoke-ControlGet "/api/v1/phase7c-live-arm-control/capability"
  if (
    [string]$arm.accountMode -ne "LIVE" -or
    [string]$arm.liveArmStatus -ne "DISARMED" -or
    [bool]$arm.liveExecutionArmed
  ) {
    throw "$Stage requires canonical LIVE ARM=DISARMED."
  }

  $lifecycle = Invoke-ControlGet "/api/v1/phase7c/lifecycle"
  Assert-LifecycleStopped -State $lifecycle -Stage $Stage

  $positions = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  $positionCount = [int]$positions.Count
  $pendingOrderCount = [int]$orders.Count
  if ($positionCount -ne 0) { throw "$Stage requires XAUUSD positions=0. current=$positionCount" }
  if ($pendingOrderCount -ne 0) { throw "$Stage requires XAUUSD pending orders=0. current=$pendingOrderCount" }

  $health = Invoke-BridgeGet "/health"
  if (-not [bool]$health.connected -or [string]$health.status -ne "ok") {
    throw "$Stage Bridge health is not connected/ok."
  }
  if ([string]$health.configuredAccountMode -ne "LIVE" -or [string]$health.accountMode -ne "real") {
    throw "$Stage Bridge is not canonical LIVE/real."
  }
  $bridgeSessionId = [string]$health.bridgeSessionId
  if ([string]::IsNullOrWhiteSpace($bridgeSessionId)) {
    throw "$Stage Bridge health is missing bridgeSessionId."
  }
  $bridgePid = Get-SingleListenerPid -Port $BridgePort -Label "$Stage Bridge"

  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_BOT_MODE=PAUSE"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_ARM=DISARMED"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_LIFECYCLE_RUNNING=false"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_LIFECYCLE_READY=false"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_POSITIONS=$positionCount"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_PENDING_ORDERS=$pendingOrderCount"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_BRIDGE_SESSION_ID=$bridgeSessionId"
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_BRIDGE_PID=$bridgePid"

  return [pscustomobject]@{
    mode = "PAUSE"
    arm = "DISARMED"
    lifecycleRunning = $false
    lifecycleReady = $false
    positionCount = $positionCount
    pendingOrderCount = $pendingOrderCount
    bridgeSessionId = $bridgeSessionId
    bridgePid = $bridgePid
  }
}

function Get-WebTaskSignature {
  $task = Get-ScheduledTask -TaskName $WebTask -ErrorAction Stop
  if ([string]$task.State -ne "Running") {
    throw "Web-only reload requires Scheduled Task '$WebTask' to already be Running. current=$($task.State)"
  }

  $actions = @($task.Actions)
  if ($actions.Count -ne 1) {
    throw "Web-only reload requires exactly one Web Scheduled Task action. current=$($actions.Count)"
  }
  $execute = ([string]$actions[0].Execute).Trim().Trim('"')
  if ([System.IO.Path]::GetFileName($execute) -ne "powershell.exe") {
    throw "Web-only reload requires powershell.exe as the Web task action. actual=$execute"
  }
  $arguments = [string]$actions[0].Arguments
  $runnerToken = [regex]::Escape($ExpectedWebRunner)
  $runnerPattern = '(?i)(?:^|\s)-File\s+(?:"' + $runnerToken + '"|''' + $runnerToken + '''|' + $runnerToken + ')(?:\s|$)'
  if ($arguments -notmatch $runnerPattern) {
    throw "Web task action does not point directly to canonical run-phase7b-web-autostart.ps1."
  }
  if ($arguments -match '(?i)-EncodedCommand') {
    throw "Web-only reload refuses encoded-command Web task actions."
  }

  return [pscustomobject]@{
    state = [string]$task.State
    execute = $execute
    arguments = $arguments
    workingDirectory = [string]$actions[0].WorkingDirectory
    principalUserId = [string]$task.Principal.UserId
    principalLogonType = [string]$task.Principal.LogonType
    principalRunLevel = [string]$task.Principal.RunLevel
  }
}

function ConvertTo-TaskDefinitionSignature($TaskSignature) {
  return @(
    [string]$TaskSignature.execute,
    [string]$TaskSignature.arguments,
    [string]$TaskSignature.workingDirectory,
    [string]$TaskSignature.principalUserId,
    [string]$TaskSignature.principalLogonType,
    [string]$TaskSignature.principalRunLevel
  ) -join '|'
}

function Read-ExistingWebRunnerPid {
  if (-not (Test-Path -LiteralPath $WebComponentPath -PathType Leaf)) {
    throw "Existing Web source attestation is required before Web-only mutation: $WebComponentPath"
  }
  $record = Read-JsonFile -Path $WebComponentPath -Label "Existing Web component attestation"
  if ([string]$record.component -ne "web" -or [int]$record.pid -le 0) {
    throw "Existing Web component attestation is invalid."
  }
  $pidValue = [int]$record.pid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
  if ($null -eq $process) { throw "Existing attested Web runner PID is not alive: $pidValue" }
  if ([string]$process.CommandLine -notmatch '(?i)run-phase7b-web-autostart\.ps1') {
    throw "Existing attested Web runner PID does not have canonical Web runner ancestry marker. PID=$pidValue"
  }
  return $pidValue
}

function Assert-CurrentWebPortAncestry([int]$WebRunnerPid, [string]$Stage) {
  $table = Get-ProcessTable
  if (-not $table.ContainsKey($WebRunnerPid)) { throw "$Stage Web runner PID is not alive: $WebRunnerPid" }
  $apiListenerPid = Get-SingleListenerPid -Port $ApiPort -Label "$Stage API"
  $webListenerPid = Get-SingleListenerPid -Port $WebPort -Label "$Stage Web"
  if (-not (Test-ProcessDescendant -ProcessId $apiListenerPid -AncestorProcessId $WebRunnerPid -ProcessTable $table)) {
    throw "$Stage API listener is not a descendant of the attested Web runner. API_PID=$apiListenerPid WEB_RUNNER_PID=$WebRunnerPid"
  }
  if (-not (Test-ProcessDescendant -ProcessId $webListenerPid -AncestorProcessId $WebRunnerPid -ProcessTable $table)) {
    throw "$Stage Web listener is not a descendant of the attested Web runner. WEB_PID=$webListenerPid WEB_RUNNER_PID=$WebRunnerPid"
  }
  Write-Host "PHASE7C_STOPPED_WEB_${Stage}_PROCESS_ANCESTRY=PASS|WEB_RUNNER_PID=$WebRunnerPid|API_LISTENER_PID=$apiListenerPid|WEB_LISTENER_PID=$webListenerPid"
}

function Wait-WebPortsReleased {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    $listeners = @(
      Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { [int]$_.LocalPort -in @($ApiPort, $WebPort) }
    )
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  $remaining = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [int]$_.LocalPort -in @($ApiPort, $WebPort) } |
      ForEach-Object { "PORT=$($_.LocalPort)|PID=$($_.OwningProcess)" }
  )
  throw "Web Scheduled Task stopped but API/Web ports did not release. Direct process killing is intentionally forbidden. remaining=$($remaining -join ',')"
}

function Wait-OldWebRunnerExit([int]$ProcessId) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Old Web runner remained alive after stopping only '$WebTask'. PID=$ProcessId"
}

function Wait-WebReady {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $lastError = "No successful API/Web probe yet."
  while ((Get-Date) -lt $deadline) {
    try {
      $api = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7b-demo" -Method Get -TimeoutSec 4
      $ui = Invoke-WebRequest -Uri "http://127.0.0.1:$WebPort/phase7b-ops" -Method Get -UseBasicParsing -TimeoutSec 4
      if ($null -ne $api -and $ui.StatusCode -ge 200 -and $ui.StatusCode -lt 400) { return }
      $lastError = "API/Web response did not satisfy readiness."
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
  }
  throw "Stopped-lifecycle Web-only reload did not become ready. detail=$lastError"
}

function Assert-FreshComponentAttestation {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] [string]$Component,
    [Parameter(Mandatory = $true)] [long]$ReloadStartedAt
  )

  $record = Read-JsonFile -Path $Path -Label "$Component component attestation"
  if ([int]$record.version -ne 1 -or [string]$record.component -ne $Component) {
    throw "$Component component attestation identity is invalid."
  }
  if ([string]$record.deploymentId -ne [string]$Deployment.deploymentId) {
    throw "$Component deploymentId mismatch. expected=$($Deployment.deploymentId) actual=$($record.deploymentId)"
  }
  if ([string]$record.sourceCommit -ne [string]$Deployment.sourceCommit -or [string]$record.sourceTree -ne [string]$Deployment.sourceTree) {
    throw "$Component source provenance does not match accepted deployment."
  }
  if ([string]$record.configFingerprint -ne [string]$Deployment.configFingerprint) {
    throw "$Component config fingerprint does not match accepted deployment."
  }
  if ([long]$record.startedAt -lt $ReloadStartedAt) {
    throw "$Component attestation is stale relative to this Web-only reload."
  }
  $pidValue = [int]$record.pid
  if ($pidValue -le 0 -or $null -eq (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
    throw "$Component attested PID is not alive. PID=$pidValue"
  }
  return $record
}

function Assert-PostReloadProvenance([long]$ReloadStartedAt) {
  $apiRecord = Assert-FreshComponentAttestation -Path $ApiComponentPath -Component "api" -ReloadStartedAt $ReloadStartedAt
  $webRecord = Assert-FreshComponentAttestation -Path $WebComponentPath -Component "web" -ReloadStartedAt $ReloadStartedAt
  $table = Get-ProcessTable
  $webRunnerPid = [int]$webRecord.pid
  $apiPid = [int]$apiRecord.pid

  if (-not $table.ContainsKey($webRunnerPid) -or -not $table.ContainsKey($apiPid)) {
    throw "Post-reload attested API/Web process is missing from the process table."
  }
  if ([string]$table[$webRunnerPid].CommandLine -notmatch '(?i)run-phase7b-web-autostart\.ps1') {
    throw "Post-reload Web attestation PID is not the canonical Web runner."
  }
  if (-not (Test-ProcessDescendant -ProcessId $apiPid -AncestorProcessId $webRunnerPid -ProcessTable $table)) {
    throw "Post-reload API attestation PID is not a descendant of the Web runner. API_PID=$apiPid WEB_RUNNER_PID=$webRunnerPid"
  }

  $apiListenerPid = Get-SingleListenerPid -Port $ApiPort -Label "POST API"
  $webListenerPid = Get-SingleListenerPid -Port $WebPort -Label "POST Web"
  foreach ($listenerPid in @($apiListenerPid, $webListenerPid)) {
    if (-not (Test-ProcessDescendant -ProcessId $listenerPid -AncestorProcessId $webRunnerPid -ProcessTable $table)) {
      throw "Post-reload API/Web listener is outside canonical Web process tree. PID=$listenerPid"
    }
  }

  Write-Host "PHASE7C_STOPPED_WEB_POST_API_PROVENANCE=PASS|PID=$apiPid|DEPLOYMENT_ID=$($apiRecord.deploymentId)"
  Write-Host "PHASE7C_STOPPED_WEB_POST_WEB_PROVENANCE=PASS|PID=$webRunnerPid|DEPLOYMENT_ID=$($webRecord.deploymentId)"
  Write-Host "PHASE7C_STOPPED_WEB_POST_PROCESS_ANCESTRY=PASS|API_LISTENER_PID=$apiListenerPid|WEB_LISTENER_PID=$webListenerPid"
}

Push-Location $ProjectRoot
try {
  $git = Get-Command git -ErrorAction Stop
  $pnpm = Get-Command pnpm -ErrorAction Stop

  $branch = (& $git.Source branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    throw "Stopped-lifecycle Web-only deploy requires branch main. actual=$branch"
  }
  $dirty = @(& $git.Source status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw "Stopped-lifecycle Web-only deploy requires a clean worktree. No runtime process was restarted."
  }
  $actualCommit = (& $git.Source rev-parse HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit.Trim().ToLowerInvariant()) {
    throw "Stopped-lifecycle Web-only deploy exact commit mismatch. expected=$ExpectedCommit actual=$actualCommit"
  }
  $actualTree = (& $git.Source rev-parse "HEAD^{tree}").Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualTree -ne $ExpectedTree.Trim().ToLowerInvariant()) {
    throw "Stopped-lifecycle Web-only deploy exact tree mismatch. expected=$ExpectedTree actual=$actualTree"
  }

  $executorConfig = Read-JsonFile -Path $ExecutorConfigPath -Label "Executor task config"
  if ([int]$executorConfig.version -ne 2) { throw "Executor task config version 2 is required." }
  $resolvedWorkDir = Resolve-ProjectPath $WorkDir
  $configuredWorkDir = Resolve-ProjectPath ([string]$executorConfig.workDir)
  if ($resolvedWorkDir -ne $configuredWorkDir) {
    throw "WorkDir must match canonical runtime root. requested=$resolvedWorkDir configured=$configuredWorkDir"
  }
  $WorkDir = $resolvedWorkDir
  $ControlApiUrl = ([string]$executorConfig.controlApiUrl).TrimEnd('/')
  if ($ControlApiUrl -ne "http://127.0.0.1:$ApiPort") {
    throw "Control API URL/ApiPort mismatch. configured=$ControlApiUrl expected=http://127.0.0.1:$ApiPort"
  }

  $accountStatePath = Join-Path $WorkDir "phase7c-account-mode.json"
  $accountState = Read-JsonFile -Path $accountStatePath -Label "Canonical account-mode state"
  if ([int]$accountState.version -ne 1 -or (ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)) -ne "LIVE" -or -not [bool]$accountState.liveExecutionEnabled) {
    throw "Stopped-lifecycle Web-only deploy requires canonical LIVE account-mode state."
  }
  $envFile = Resolve-ProjectPath ([string]$accountState.envFile)
  $envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode "LIVE" -RequireTrading
  $BridgePort = [int]$envInfo.bridgePort
  $BridgeBase = "http://$($envInfo.bridgeHost):$BridgePort"
  $BridgeHeaders = @{ "x-mt5-api-key" = $envInfo.apiKey }

  $AttestationRoot = Join-Path $WorkDir "phase7c-source-attestation"
  $ApiComponentPath = Join-Path $AttestationRoot "components\api.json"
  $WebComponentPath = Join-Path $AttestationRoot "components\web.json"
  $Deployment = Read-Phase7CRuntimeSourceDeployment -RuntimeRoot $WorkDir
  if ([string]$Deployment.deploymentId -ne $ExpectedDeploymentId.Trim().ToLowerInvariant()) {
    throw "Accepted deploymentId mismatch. expected=$ExpectedDeploymentId actual=$($Deployment.deploymentId)"
  }
  if ([string]$Deployment.sourceCommit -ne $actualCommit -or [string]$Deployment.sourceTree -ne $actualTree -or [string]$Deployment.branch -ne "main" -or -not [bool]$Deployment.worktreeClean) {
    throw "Accepted deployment manifest does not match exact clean source."
  }
  $configIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
    -RuntimeRoot $WorkDir `
    -AccountMode LIVE `
    -LiveExecutionEnabled $true `
    -ControlApiUrl $ControlApiUrl
  $expectedConfigFingerprint = Get-Phase7CRuntimeSourceConfigFingerprint -ConfigIdentity $configIdentity
  if ([string]$Deployment.configFingerprint -ne $expectedConfigFingerprint) {
    throw "Accepted deployment configFingerprint does not match canonical LIVE runtime configuration."
  }

  $taskBefore = Get-WebTaskSignature
  $taskDefinitionBefore = ConvertTo-TaskDefinitionSignature $taskBefore
  $oldWebRunnerPid = Read-ExistingWebRunnerPid
  Assert-CurrentWebPortAncestry -WebRunnerPid $oldWebRunnerPid -Stage "PREFLIGHT"
  $pre = Get-SafetySnapshot -Stage "PREFLIGHT"

  Write-Host "PHASE7C_STOPPED_WEB_PREFLIGHT_DEPLOYMENT_ID=$($Deployment.deploymentId)"
  Write-Host "PHASE7C_STOPPED_WEB_PREFLIGHT_SOURCE_COMMIT=$actualCommit"
  Write-Host "PHASE7C_STOPPED_WEB_PREFLIGHT_SOURCE_TREE=$actualTree"
  Write-Host "PHASE7C_STOPPED_WEB_PREFLIGHT_TASK_ACTION=CANONICAL"
  Write-Host "PHASE7C_STOPPED_WEB_PREFLIGHT=PASS"

  # Build before mutation. API is built again by its canonical runtime launcher;
  # the Web bundle is prepared here so the Scheduled Task restart only launches it.
  & $pnpm.Source --filter '@xauusd/mt5-broker' build
  if ($LASTEXITCODE -ne 0) { throw "MT5 broker build failed before Web-only reload." }
  $env:VITE_API_BASE_URL = $ControlApiUrl
  try {
    & $pnpm.Source --filter '@xauusd/web' build
    if ($LASTEXITCODE -ne 0) { throw "Web build failed before Web-only reload." }
  } finally {
    Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
  }
  Write-Host "PHASE7C_STOPPED_WEB_BUILD=PASS"

  $reloadStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Stop-ScheduledTask -TaskName $WebTask -ErrorAction Stop
  Write-Host "PHASE7C_STOPPED_WEB_TASK_STOP=PASS"
  Wait-OldWebRunnerExit -ProcessId $oldWebRunnerPid
  Wait-WebPortsReleased
  Write-Host "PHASE7C_STOPPED_WEB_JOB_OBJECT_CHILD_SHUTDOWN=PASS"

  # Bridge is independent and must survive the Web/API stop with identical identity.
  $bridgeDuring = Invoke-BridgeGet "/health"
  $bridgeDuringPid = Get-SingleListenerPid -Port $BridgePort -Label "DURING Bridge"
  if ([string]$bridgeDuring.bridgeSessionId -ne [string]$pre.bridgeSessionId -or $bridgeDuringPid -ne [int]$pre.bridgePid) {
    throw "Bridge identity changed during Web-only reload before Web task restart."
  }
  $positionsDuring = @(Read-BridgeArray "/v1/positions?symbol=XAUUSD")
  $ordersDuring = @(Read-BridgeArray "/v1/orders?symbol=XAUUSD")
  if ($positionsDuring.Count -ne 0 -or $ordersDuring.Count -ne 0) {
    throw "Broker flatness changed while Web/API was stopped. positions=$($positionsDuring.Count) pendingOrders=$($ordersDuring.Count)"
  }
  Write-Host "PHASE7C_STOPPED_WEB_DURING_BRIDGE_UNCHANGED=PASS|PID=$bridgeDuringPid|SESSION_ID=$($bridgeDuring.bridgeSessionId)"
  Write-Host "PHASE7C_STOPPED_WEB_DURING_POSITIONS=0"
  Write-Host "PHASE7C_STOPPED_WEB_DURING_PENDING_ORDERS=0"

  Start-ScheduledTask -TaskName $WebTask -ErrorAction Stop
  Write-Host "PHASE7C_STOPPED_WEB_TASK_START=PASS"
  Wait-WebReady

  $post = Get-SafetySnapshot -Stage "POST"
  if ([string]$post.mode -ne [string]$pre.mode -or [string]$post.arm -ne [string]$pre.arm) {
    throw "MODE/ARM changed during stopped-lifecycle Web-only reload."
  }
  if ([string]$post.bridgeSessionId -ne [string]$pre.bridgeSessionId -or [int]$post.bridgePid -ne [int]$pre.bridgePid) {
    throw "Bridge identity changed during stopped-lifecycle Web-only reload."
  }
  if ($post.positionCount -ne $pre.positionCount -or $post.pendingOrderCount -ne $pre.pendingOrderCount) {
    throw "XAUUSD positions/orders changed during stopped-lifecycle Web-only reload."
  }

  $taskAfter = Get-WebTaskSignature
  $taskDefinitionAfter = ConvertTo-TaskDefinitionSignature $taskAfter
  if ($taskDefinitionAfter -ne $taskDefinitionBefore) {
    throw "Web Scheduled Task definition/principal changed during stop/start reload."
  }
  Assert-PostReloadProvenance -ReloadStartedAt $reloadStartedAt

  Write-Host "PHASE7C_STOPPED_WEB_POST_DEPLOYMENT_ID=$($Deployment.deploymentId)"
  Write-Host "PHASE7C_STOPPED_WEB_POST_MODE_UNCHANGED=PAUSE"
  Write-Host "PHASE7C_STOPPED_WEB_POST_ARM_UNCHANGED=DISARMED"
  Write-Host "PHASE7C_STOPPED_WEB_POST_BRIDGE_UNCHANGED=PASS"
  Write-Host "PHASE7C_STOPPED_WEB_POST_EXECUTORS_UNCHANGED=STOPPED"
  Write-Host "PHASE7C_STOPPED_WEB_POST_POSITIONS=0"
  Write-Host "PHASE7C_STOPPED_WEB_POST_PENDING_ORDERS=0"
  Write-Host "PHASE7C_STOPPED_WEB_POST_LIFECYCLE_RUNNING=false"
  Write-Host "PHASE7C_STOPPED_WEB_POST_LIFECYCLE_READY=false"
  Write-Host "PHASE7C_STOPPED_LIFECYCLE_WEB_ONLY_STATUS=PASS"
} finally {
  Pop-Location
}
