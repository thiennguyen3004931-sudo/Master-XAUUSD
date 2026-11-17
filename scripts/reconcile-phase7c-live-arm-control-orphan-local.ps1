param(
  [Parameter(Mandatory = $true)] [string]$ProjectRoot,
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [Parameter(Mandatory = $true)] [string]$ExpectedRequestId,
  [string]$ExpectedAction = "DISARM_LIVE"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$REQUEST_STALE_MIN_MS = 600000
$ArmTaskName = "XAUUSD-Phase7C-Live-Arm-Control"
$ExpectedAction = ([string]$ExpectedAction).Trim().ToUpperInvariant()
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$ExpectedCommit = ([string]$ExpectedCommit).Trim().ToLowerInvariant()
$ExpectedRequestId = ([string]$ExpectedRequestId).Trim()

if ($ExpectedAction -ne "DISARM_LIVE") { throw "Only the DISARM_LIVE orphan class is eligible for reconciliation." }
if ($ExpectedCommit -notmatch '^[0-9a-f]{40}$') { throw "ExpectedCommit must be an exact 40-character Git commit." }
if ($ExpectedRequestId -notmatch '^[0-9a-fA-F-]{36}$') { throw "ExpectedRequestId must be an exact request id." }
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) { throw "ProjectRoot does not exist: $ProjectRoot" }

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
  catch { throw "$Label is invalid: $($_.Exception.Message)" }
}

function Write-AtomicJson([string]$Path, $Value) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Status directory is missing: $directory" }
  $tmp = "$Path.tmp.$PID.$([guid]::NewGuid().ToString('N'))"
  try {
    $json = $Value | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($tmp, "$json`n", [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

function Read-BridgeArray([string]$Base, [hashtable]$Headers, [string]$Path) {
  $response = Invoke-WebRequest -Uri "$Base$Path" -Headers $Headers -Method Get -UseBasicParsing -TimeoutSec 12
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq '[]') { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

function Get-RunningTaskInstanceCount([string]$Name) {
  $service = New-Object -ComObject "Schedule.Service"
  $service.Connect()
  $root = $service.GetFolder("\")
  $registered = $root.GetTask($Name)
  return [int]$registered.GetInstances(0).Count
}

Write-Host "============================================================"
Write-Host "=== PHASE7C LIVE ARM ORPHAN RECONCILIATION ==="
Write-Host "============================================================"
Write-Host "SCOPE=STALE_CONTROL_TRANSACTION_ONLY"
Write-Host "EXPECTED_ACTION=$ExpectedAction"
Write-Host "REQUEST_STALE_MIN_MS = 600000"
Write-Host "HTTP_METHODS=GET_ONLY"
Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "TASK_MUTATION=NONE"
Write-Host "LIVE_TEST_ORDER=NONE"

# Exact source/worktree guard.
$RunnerRepoPath = "scripts/run-phase7c-live-arm-control-task-runner-local.ps1"
$ExpectedRunnerBlob = ""
Push-Location $ProjectRoot
try {
  $branch = ([string](& git branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') { throw "Production checkout must be main. actual=$branch" }
  $head = ([string](& git rev-parse HEAD)).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedCommit) { throw "Production HEAD mismatch. expected=$ExpectedCommit actual=$head" }
  $dirty = @(& git status --porcelain --untracked-files=normal)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Production worktree must be clean." }
  $ExpectedRunnerBlob = ([string](& git rev-parse "$ExpectedCommit`:$RunnerRepoPath")).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $ExpectedRunnerBlob -notmatch '^[0-9a-f]{40}$') { throw "Could not resolve canonical LIVE ARM runner blob from ExpectedCommit." }
} finally {
  Pop-Location
}
Write-Host "SOURCE_GUARD=PASS|HEAD=$ExpectedCommit"

$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"
$config = Read-JsonFile -Path $ConfigPath -Label "Executor task config"
$WorkDir = Resolve-ProjectPath ([string]$config.workDir)
$EnvFile = Resolve-ProjectPath ([string]$config.envFile)
$ControlApiUrl = ([string]$config.controlApiUrl).Trim().TrimEnd('/')
if ($ControlApiUrl -notmatch '^https?://(127\.0\.0\.1|localhost|\[?::1\]?):\d+$') { throw "Control API must be explicit loopback." }

$AccountLibrary = Join-Path $ProjectRoot "scripts\lib\phase7c-account-mode.ps1"
if (-not (Test-Path -LiteralPath $AccountLibrary -PathType Leaf)) { throw "Account library is missing." }
. $AccountLibrary
$envInfo = Assert-Phase7CAccountEnv -EnvFile $EnvFile -AccountMode "LIVE" -RequireTrading
$BridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
$BridgeHeaders = @{ "x-mt5-api-key" = $envInfo.apiKey }

# Read-only runtime proof.
$Mode = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c/bot-mode" -Method Get -TimeoutSec 12
if ([string]$Mode.state.mode -ne "PAUSE") { throw "Orphan reconciliation requires bot mode PAUSE." }
Write-Host "BOT_MODE=PAUSE"

$Capability = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c-live-arm-control/capability" -Method Get -TimeoutSec 12
if ([string]$Capability.accountMode -ne "LIVE") { throw "LIVE ARM capability is not bound to LIVE." }
if ([string]$Capability.liveArmStatus -ne "DISARMED" -or [bool]$Capability.liveExecutionArmed) {
  throw "Orphan reconciliation requires canonical DISARMED state."
}

$Attestation = Invoke-RestMethod -Uri "$ControlApiUrl/api/v1/phase7c/runtime-source-attestation" -Method Get -TimeoutSec 12
if ([string]$Attestation.overall -ne "EXACT_MATCH" -or $null -eq $Attestation.deployment) { throw "Runtime source attestation is not exact." }
if ([string]$Attestation.deployment.sourceCommit -ne $ExpectedCommit) { throw "Runtime deployment source commit does not match ExpectedCommit." }
$DeploymentId = [string]$Attestation.deployment.deploymentId
if ([string]::IsNullOrWhiteSpace($DeploymentId)) { throw "Runtime source deployment id is missing." }
$components = @($Attestation.components)
if ($components.Count -ne 8) { throw "Runtime source attestation must contain 8 components." }
foreach ($component in $components) {
  if ([string]$component.verdict -ne "EXACT_MATCH" -or [string]$component.sourceCommit -ne $ExpectedCommit -or [string]$component.deploymentId -ne $DeploymentId) {
    throw "Runtime source component is not exact: $($component.component)"
  }
}
Write-Host "RUNTIME_SOURCE_ATTESTATION=8/8_EXACT"

$BridgeHealth = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers $BridgeHeaders -Method Get -TimeoutSec 12
if (-not [bool]$BridgeHealth.connected -or [string]$BridgeHealth.status -ne "ok") { throw "Bridge is not healthy." }
if ([string]$BridgeHealth.configuredAccountMode -ne "LIVE" -or [string]$BridgeHealth.accountMode -ne "real") { throw "Bridge is not LIVE/real." }
if ([string]$BridgeHealth.liveArmStatus -ne "DISARMED" -or [bool]$BridgeHealth.liveExecutionArmed) { throw "Bridge does not confirm DISARMED." }
Write-Host "BRIDGE_LIVE_ARM_STATUS=DISARMED"

$PositionsPath = '/v1/' + 'positions?symbol=XAUUSD'
$OrdersPath = '/v1/' + 'orders?symbol=XAUUSD'
$Positions = @(Read-BridgeArray -Base $BridgeBase -Headers $BridgeHeaders -Path $PositionsPath)
$Orders = @(Read-BridgeArray -Base $BridgeBase -Headers $BridgeHeaders -Path $OrdersPath)
if ($Positions.Count -ne 0) { throw "Reconciliation requires zero XAUUSD positions." }
if ($Orders.Count -ne 0) { throw "Reconciliation requires zero XAUUSD pending orders." }
Write-Host "XAUUSD_POSITIONS=0"
Write-Host "XAUUSD_PENDING_ORDERS=0"

# Scheduled task/worker must already be inactive. No task mutation occurs here.
Import-Module ScheduledTasks -ErrorAction Stop
$Task = Get-ScheduledTask -TaskName $ArmTaskName -ErrorAction Stop
if ([string]$Task.State -ne "Ready") { throw "LIVE ARM task must be Ready before orphan reconciliation. actual=$($Task.State)" }
$TaskActions = @($Task.Actions)
if ($TaskActions.Count -ne 1) { throw "LIVE ARM task must have exactly one action." }
$CanonicalRunner = Join-Path $ProjectRoot "scripts\run-phase7c-live-arm-control-task-runner-local.ps1"
$TaskActionText = "$([string]$TaskActions[0].Execute) $([string]$TaskActions[0].Arguments)"
if ($TaskActionText.IndexOf($CanonicalRunner, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "LIVE ARM task does not point to canonical runner." }
if ([string]$Task.Principal.RunLevel -ne "Highest") { throw "LIVE ARM task must remain RunLevel Highest." }
$ActualRunnerBlob = ([string](& git -C $ProjectRoot hash-object -- $CanonicalRunner)).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $ActualRunnerBlob -ne $ExpectedRunnerBlob) { throw "LIVE ARM runner blob drift. expected=$ExpectedRunnerBlob actual=$ActualRunnerBlob" }
Write-Host "LIVE_ARM_RUNNER_PROVENANCE=PASS|BLOB=$ActualRunnerBlob"
$RunningInstances = Get-RunningTaskInstanceCount -Name $ArmTaskName
if ($RunningInstances -ne 0) { throw "LIVE ARM task still has a running instance. count=$RunningInstances" }
Write-Host "TASK_RUNNING_INSTANCE_COUNT=0"

$ArmProcesses = @(
  Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object {
      $_.Name -in @('powershell.exe','pwsh.exe') -and
      -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
      (
        ([string]$_.CommandLine).IndexOf('run-phase7c-live-arm-control-task-runner-local.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        ([string]$_.CommandLine).IndexOf('arm-phase7c-live-local.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        ([string]$_.CommandLine).IndexOf('disarm-phase7c-live-local.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        ([string]$_.CommandLine).IndexOf('get-phase7c-live-arm-local.ps1', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      )
    }
)
if ($ArmProcesses.Count -ne 0) { throw "LIVE ARM worker process still exists. count=$($ArmProcesses.Count)" }
Write-Host "ARM_CONTROL_PROCESS_COUNT=0"

$RequestPath = Join-Path $WorkDir "phase7c-live-arm-control-request.json"
$StatusPath = Join-Path $WorkDir "phase7c-live-arm-control-status.json"
$LockPath = Join-Path $WorkDir "phase7c-live-arm-control.lock"
$request = Read-JsonFile -Path $RequestPath -Label "LIVE ARM control request"
$status = Read-JsonFile -Path $StatusPath -Label "LIVE ARM control status"

function Assert-OrphanPair($Request, $Status) {
  if ([string]$Request.requestId -ne $ExpectedRequestId -or [string]$Status.requestId -ne $ExpectedRequestId) { throw "Request/status id does not match ExpectedRequestId." }
  if (([string]$Request.action).Trim().ToUpperInvariant() -ne $ExpectedAction -or ([string]$Status.action).Trim().ToUpperInvariant() -ne $ExpectedAction) { throw "Request/status action does not match ExpectedAction." }
  if ([string]$Status.status -ne "RUNNING" -or [string]$Status.phase -ne "PREFLIGHT") { throw "Only stale RUNNING/PREFLIGHT orphan status is eligible." }
  if ([string]$Request.source -ne "LOCAL_WEB" -or [string]$Request.confirmation -ne $ExpectedAction) { throw "Request source/confirmation is not canonical." }
  if ([string]$Request.bridgeSessionId -ne [string]$BridgeHealth.bridgeSessionId) { throw "Request bridge session differs from current bridge session." }
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $requestAgeMs = $nowMs - [long]$Request.createdAt
  $statusAgeMs = $nowMs - [long]$Status.updatedAt
  if ($requestAgeMs -lt $REQUEST_STALE_MIN_MS -or $statusAgeMs -lt $REQUEST_STALE_MIN_MS) {
    throw "Control transaction is not stale enough. requestAgeMs=$requestAgeMs statusAgeMs=$statusAgeMs"
  }
  return [pscustomobject]@{ requestAgeMs = $requestAgeMs; statusAgeMs = $statusAgeMs }
}

$ages = Assert-OrphanPair -Request $request -Status $status
Write-Host "ORPHAN_REQUEST_ID=$ExpectedRequestId"
Write-Host "ORPHAN_REQUEST_AGE_MS=$($ages.requestAgeMs)"
Write-Host "ORPHAN_STATUS_AGE_MS=$($ages.statusAgeMs)"

# Exclusive lock proves the terminated worker is not still holding the control lock.
$lockStream = $null
try {
  try {
    $lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    throw "LIVE ARM control lock is still held; reconciliation refused."
  }

  # Re-read under the lock to prevent evidence changing between proof and mutation.
  $requestLocked = Read-JsonFile -Path $RequestPath -Label "Locked LIVE ARM control request"
  $statusLocked = Read-JsonFile -Path $StatusPath -Label "Locked LIVE ARM control status"
  [void](Assert-OrphanPair -Request $requestLocked -Status $statusLocked)

  # Terminalize the matching status first. The durable request remains present
  # until status persistence succeeds, so any failure stays fail-closed.
  $completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-AtomicJson -Path $StatusPath -Value ([ordered]@{
    version = 1
    requestId = $ExpectedRequestId
    action = $ExpectedAction
    status = "PASS"
    phase = "RECONCILED_AFTER_TERMINATED_WORKER"
    message = "DISARM side effect already confirmed; stale control transaction reconciled after terminated worker."
    startedAt = [long]$statusLocked.startedAt
    updatedAt = $completedAt
    completedAt = $completedAt
    finalArmStatus = "DISARMED"
  })
  Remove-Item -LiteralPath $RequestPath -Force
} finally {
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}

if (Test-Path -LiteralPath $RequestPath -PathType Leaf) { throw "Stale control request still exists after reconciliation." }
$finalStatus = Read-JsonFile -Path $StatusPath -Label "Reconciled LIVE ARM control status"
if ([string]$finalStatus.requestId -ne $ExpectedRequestId -or [string]$finalStatus.status -ne "PASS" -or [string]$finalStatus.phase -ne "RECONCILED_AFTER_TERMINATED_WORKER" -or [string]$finalStatus.finalArmStatus -ne "DISARMED") {
  throw "Reconciled control status postcondition failed."
}

Write-Host "ORDER_MUTATION=NONE"
Write-Host "POSITION_MUTATION=NONE"
Write-Host "MODE_MUTATION=NONE"
Write-Host "ARM_MUTATION=NONE"
Write-Host "TASK_MUTATION=NONE"
Write-Host "LIVE_TEST_ORDER=NONE"
Write-Host "PHASE7C_LIVE_ARM_ORPHAN_RECONCILIATION=PASS"
