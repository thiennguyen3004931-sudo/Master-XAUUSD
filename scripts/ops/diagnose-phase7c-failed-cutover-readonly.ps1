# Strictly read-only evidence collection for a failed LIVE source cutover.
# No process termination, task changes, source checkout, ARM/mode actions or broker requests.
param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [string]$ExpectedSource = '196a8420ff008548773f5d385cf5785a9f84e297',
  [string]$ReceiptPath = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ExpectedSource -notmatch '^[a-f0-9]{40}$') { throw 'EXPECTED_SOURCE_NOT_PINNED' }
if (-not (Test-Path -LiteralPath $ProductionRoot -PathType Container)) { throw 'PRODUCTION_ROOT_MISSING' }

$source = (& git -C $ProductionRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'READ_ONLY_PRODUCTION_HEAD_FAILED' }
$branch = (& git -C $ProductionRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) { throw 'READ_ONLY_PRODUCTION_BRANCH_FAILED' }
$tracked = @(& git -C $ProductionRoot status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw 'READ_ONLY_PRODUCTION_WORKTREE_FAILED' }
$sourceMatches = $source -eq $ExpectedSource
Write-Host "DIAGNOSTIC_PRODUCTION_HEAD=$source"
Write-Host "DIAGNOSTIC_PRODUCTION_BRANCH=$branch"
Write-Host "DIAGNOSTIC_PRODUCTION_TRACKED_DIRTY_COUNT=$($tracked.Count)"
Write-Host "DIAGNOSTIC_EXPECTED_SOURCE_MATCH=$sourceMatches"

function Read-Control([string]$Path) {
  try {
    return [pscustomobject]@{ observed = $true; data = (Invoke-RestMethod -Uri ("http://127.0.0.1:3711" + $Path) -Method Get -TimeoutSec 4); error = '' }
  } catch {
    return [pscustomobject]@{ observed = $false; data = $null; error = $_.Exception.GetType().Name }
  }
}
$life = Read-Control '/api/v1/phase7c/lifecycle'
$mode = Read-Control '/api/v1/phase7c/bot-mode'
$arm = Read-Control '/api/v1/phase7c-live-arm-control/capability'
$attestation = Read-Control '/api/v1/phase7c/runtime-source-attestation'
$botMode = if ($mode.observed) { [string]$mode.data.state.mode } else { 'UNVERIFIED' }
$armStatus = if ($arm.observed) { [string]$arm.data.liveArmStatus } else { 'UNVERIFIED' }
$lifecycleRunning = if ($life.observed) { [string]$life.data.running } else { 'UNVERIFIED' }
$lifecycleReady = if ($life.observed) { [string]$life.data.ready } else { 'UNVERIFIED' }
$runtimeSource = if ($attestation.observed) { [string]$attestation.data.overall } else { 'UNVERIFIED' }
Write-Host "DIAGNOSTIC_BOT_MODE=$botMode"
Write-Host "DIAGNOSTIC_ARM_STATUS=$armStatus"
Write-Host "DIAGNOSTIC_LIFECYCLE_RUNNING=$lifecycleRunning"
Write-Host "DIAGNOSTIC_LIFECYCLE_READY=$lifecycleReady"
Write-Host "DIAGNOSTIC_RUNTIME_SOURCE_ATTESTATION=$runtimeSource"
Write-Host "DIAGNOSTIC_API_LIFECYCLE_READ=$($life.observed)"
Write-Host "DIAGNOSTIC_API_MODE_READ=$($mode.observed)"
Write-Host "DIAGNOSTIC_API_ARM_READ=$($arm.observed)"
Write-Host "DIAGNOSTIC_API_ATTESTATION_READ=$($attestation.observed)"

$ports = @(3711, 5717)
$observations = @()
for ($sample = 1; $sample -le 3; $sample++) {
  try {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $ports -contains [int]$_.LocalPort })
    foreach ($listener in $listeners) {
      $pidValue = [int]$listener.OwningProcess
      $processName = 'UNVERIFIED'
      $parentId = $null
      if ($pidValue -gt 0) {
        $wmiProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
        if ($null -ne $wmiProcess) {
          $processName = [string]$wmiProcess.Name
          $parentId = [int]$wmiProcess.ParentProcessId
        }
      }
      $row = [pscustomobject]@{
        sample = $sample
        localAddress = [string]$listener.LocalAddress
        localPort = [int]$listener.LocalPort
        owningPid = $pidValue
        processName = $processName
        parentPid = $parentId
        ownerVerified = ($pidValue -gt 0 -and $processName -ne 'UNVERIFIED')
      }
      $observations += $row
      Write-Host ("DIAGNOSTIC_LISTENER=sample:{0}|addr:{1}|port:{2}|pid:{3}|process:{4}|ownerVerified:{5}" -f
        $sample, $row.localAddress, $row.localPort, $row.owningPid, $row.processName, $row.ownerVerified)
    }
    if ($listeners.Count -eq 0) { Write-Host "DIAGNOSTIC_LISTENER_SAMPLE=$sample|NONE" }
  } catch {
    Write-Host "DIAGNOSTIC_LISTENER_SAMPLE=$sample|READ_ERROR=$($_.Exception.GetType().Name)"
  }
  if ($sample -lt 3) { Start-Sleep -Seconds 1 }
}

$tasks = @()
foreach ($taskName in @('XAUUSD-Phase7B-Web', 'XAUUSD-Phase7C-Executors')) {
  try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    $tasks += [pscustomobject]@{
      name = $taskName; state = [string]$task.State
      lastTaskResult = [string]$info.LastTaskResult
      lastRunTime = [string]$info.LastRunTime
    }
    Write-Host "DIAGNOSTIC_TASK=$taskName|STATE=$($task.State)|LAST_RESULT=$($info.LastTaskResult)"
  } catch {
    $tasks += [pscustomobject]@{ name = $taskName; state = 'UNVERIFIED'; lastTaskResult = ''; lastRunTime = '' }
    Write-Host "DIAGNOSTIC_TASK=$taskName|STATE=UNVERIFIED"
  }
}
$pidZero5717 = @($observations | Where-Object { $_.localPort -eq 5717 -and $_.owningPid -eq 0 }).Count -gt 0
$ownerUnknown5717 = @($observations | Where-Object { $_.localPort -eq 5717 -and -not $_.ownerVerified }).Count -gt 0
$disposition = if (-not $sourceMatches) { 'SOURCE_DRIFT_BLOCKED' }
  elseif ($pidZero5717 -or $ownerUnknown5717) { 'PORT_OWNER_UNVERIFIED_BLOCKED' }
  else { 'REVIEW_REQUIRED_NO_AUTO_RECOVERY' }
Write-Host "DIAGNOSTIC_DISPOSITION=$disposition"
Write-Host 'DIAGNOSTIC_LIVE_CUTOVER_ALLOWED=FALSE'
Write-Host 'DIAGNOSTIC_SOURCE_MUTATION=NONE'
Write-Host 'DIAGNOSTIC_BOT_MODE_MUTATION=NONE'
Write-Host 'DIAGNOSTIC_ARM_MUTATION=NONE'
Write-Host 'DIAGNOSTIC_PROCESS_OR_TASK_MUTATION=NONE'
Write-Host 'DIAGNOSTIC_MT5_BRIDGE_REQUESTS=NONE'
Write-Host 'DIAGNOSTIC_ORDER_MUTATION=NONE'
$report = [ordered]@{
  version = 1
  observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  productionHead = $source
  expectedSource = $ExpectedSource
  sourceMatches = $sourceMatches
  branch = $branch
  trackedDirtyCount = $tracked.Count
  botMode = $botMode
  armStatus = $armStatus
  lifecycleRunning = $lifecycleRunning
  lifecycleReady = $lifecycleReady
  sourceAttestation = $runtimeSource
  controlReads = [ordered]@{ lifecycle = $life.observed; mode = $mode.observed; arm = $arm.observed; attestation = $attestation.observed }
  controlReadErrorTypes = [ordered]@{ lifecycle = $life.error; mode = $mode.error; arm = $arm.error; attestation = $attestation.error }
  ports = @($observations)
  tasks = @($tasks)
  disposition = $disposition
  liveCutoverAllowed = $false
  tradingMutations = 0
  processAndTaskMutations = 0
}
if (-not [string]::IsNullOrWhiteSpace($ReceiptPath)) {
  $json = $report | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($ReceiptPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host 'DIAGNOSTIC_SANITIZED_RECEIPT=WRITTEN'
}
Write-Host 'PHASE7C_FAILED_CUTOVER_READ_ONLY_DIAGNOSTIC=COMPLETE'
