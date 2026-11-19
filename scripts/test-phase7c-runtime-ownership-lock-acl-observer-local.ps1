$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProbeLibrary = Join-Path $PSScriptRoot 'lib\phase7c-runtime-ownership-probe.ps1'
$GuardLibrary = Join-Path $PSScriptRoot 'lib\phase7c-startup-runner-guard.ps1'
foreach ($required in @($ProbeLibrary, $GuardLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required production source missing: $required"
  }
}
. $ProbeLibrary

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'ACL observer regression requires Administrator on the CI host.'
}

Import-Module ScheduledTasks -ErrorAction Stop

$tempRoot = Join-Path $env:ProgramData ("phase7c-lock-acl-observer-{0}" -f [Guid]::NewGuid().ToString('N'))
$executorDir = Join-Path $tempRoot 'phase7c-executors'
$brokerStateDir = Join-Path $tempRoot 'phase7c-lifecycle-broker\state'
$resultDir = Join-Path $tempRoot 'observer-results'
$ownerScript = Join-Path $tempRoot 'system-owner.ps1'
$observerScript = Join-Path $tempRoot 'network-service-observer.ps1'
$guardCopy = Join-Path $tempRoot 'phase7c-startup-runner-guard.ps1'
$probeCopy = Join-Path $tempRoot 'phase7c-runtime-ownership-probe.ps1'
$lockPath = Join-Path $executorDir 'startup-runner.lock'
$statusPath = Join-Path $brokerStateDir 'status.json'
$heartbeatPath = Join-Path $brokerStateDir 'heartbeat.json'
$readyPath = Join-Path $resultDir 'owner-ready.txt'
$observerOutputPath = Join-Path $resultDir 'snapshot.json'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$ownerTaskName = "Phase7C-CI-AclOwner-$([Guid]::NewGuid().ToString('N'))"
$observerTaskName = "Phase7C-CI-AclObserver-$([Guid]::NewGuid().ToString('N'))"

$systemSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
$networkServiceSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::NetworkServiceSid, $null)
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None

function Set-DirectoryAcl {
  param(
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $true)] $Rules
  )

  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($ruleSpec in @($Rules)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $ruleSpec.Sid,
      $ruleSpec.Rights,
      $inherit,
      $propagation,
      $allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
Copy-Item -LiteralPath $GuardLibrary -Destination $guardCopy -Force
Copy-Item -LiteralPath $ProbeLibrary -Destination $probeCopy -Force

$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$readExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
$modify = [System.Security.AccessControl.FileSystemRights]::Modify

# The broker state remains readable by the API-like observer, while the executor
# runtime directory is intentionally SYSTEM/Admin only. This mirrors the
# production ACL asymmetry under investigation without touching a live runtime.
Set-DirectoryAcl -Path $tempRoot -Rules @(
  [pscustomobject]@{ Sid = $systemSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $adminsSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $networkServiceSid; Rights = $readExecute }
)
Set-DirectoryAcl -Path $executorDir -Rules @(
  [pscustomobject]@{ Sid = $systemSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $adminsSid; Rights = $fullControl }
)
Set-DirectoryAcl -Path (Split-Path -Parent $brokerStateDir) -Rules @(
  [pscustomobject]@{ Sid = $systemSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $adminsSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $networkServiceSid; Rights = $readExecute }
)
Set-DirectoryAcl -Path $brokerStateDir -Rules @(
  [pscustomobject]@{ Sid = $systemSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $adminsSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $networkServiceSid; Rights = $readExecute }
)
Set-DirectoryAcl -Path $resultDir -Rules @(
  [pscustomobject]@{ Sid = $systemSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $adminsSid; Rights = $fullControl },
  [pscustomobject]@{ Sid = $networkServiceSid; Rights = $modify }
)

$ownerSource = @'
param(
  [Parameter(Mandatory = $true)] [string]$GuardLibrary,
  [Parameter(Mandatory = $true)] [string]$LockPath,
  [Parameter(Mandatory = $true)] [string]$StatusPath,
  [Parameter(Mandatory = $true)] [string]$HeartbeatPath,
  [Parameter(Mandatory = $true)] [string]$ReadyPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $GuardLibrary

function Write-StateFile([string]$Path, [hashtable]$Value) {
  $json = $Value | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

$runnerLock = $null
try {
  $runnerLock = Open-Phase7CStartupRunnerLock -Path $LockPath
  Write-StateFile -Path $StatusPath -Value @{ version = 1; brokerPid = $PID; state = 'RUNNING' }
  Write-StateFile -Path $HeartbeatPath -Value @{ version = 1; brokerPid = $PID; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  [System.IO.File]::WriteAllText($ReadyPath, "$PID", [System.Text.UTF8Encoding]::new($false))

  while ($true) {
    Write-StateFile -Path $HeartbeatPath -Value @{ version = 1; brokerPid = $PID; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    Start-Sleep -Milliseconds 100
  }
} finally {
  if ($null -ne $runnerLock) { $runnerLock.Dispose() }
}
'@
[System.IO.File]::WriteAllText($ownerScript, $ownerSource, [System.Text.UTF8Encoding]::new($false))

$observerSource = @'
param(
  [Parameter(Mandatory = $true)] [string]$ProbeLibrary,
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [Parameter(Mandatory = $true)] [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$payload = $null
try {
  . $ProbeLibrary
  $snapshot = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $WorkDir -HeartbeatMaxAgeMs 5000
  $payload = [ordered]@{
    success = $true
    snapshot = $snapshot
  }
} catch {
  $payload = [ordered]@{
    success = $false
    errorType = $_.Exception.GetType().FullName
    message = [string]$_.Exception.Message
    fullyQualifiedErrorId = [string]$_.FullyQualifiedErrorId
    category = [string]$_.CategoryInfo.Category
    scriptStackTrace = [string]$_.ScriptStackTrace
  }
}

$json = $payload | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
'@
[System.IO.File]::WriteAllText($observerScript, $observerSource, [System.Text.UTF8Encoding]::new($false))

$ownerRegistered = $false
$observerRegistered = $false
try {
  $ownerArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -GuardLibrary "{1}" -LockPath "{2}" -StatusPath "{3}" -HeartbeatPath "{4}" -ReadyPath "{5}"' -f $ownerScript, $guardCopy, $lockPath, $statusPath, $heartbeatPath, $readyPath
  $ownerAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument $ownerArguments
  $ownerTrigger = New-ScheduledTaskTrigger -AtStartup
  $ownerSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $ownerPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $ownerTaskName -Action $ownerAction -Trigger $ownerTrigger -Settings $ownerSettings -Principal $ownerPrincipal -ErrorAction Stop | Out-Null
  $ownerRegistered = $true
  Start-ScheduledTask -TaskName $ownerTaskName -ErrorAction Stop

  $ownerDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $ownerDeadline) { throw 'Timed out waiting for SYSTEM broker owner readiness.' }
    Start-Sleep -Milliseconds 50
  }

  $ownerPid = [int](([string](Get-Content -LiteralPath $readyPath -Raw)).Trim())
  if ($ownerPid -le 0 -or $null -eq (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
    throw "SYSTEM broker owner is not alive. PID=$ownerPid"
  }

  # Establish the exact healthy baseline before switching to the restricted
  # observer. This proves the fixture has a live/fresh/PID-matched broker and
  # a real HELD startup lock rather than merely synthesizing JSON fields.
  $baseline = Get-Phase7CRuntimeGenerationSnapshot -WorkDir $tempRoot -HeartbeatMaxAgeMs 5000
  if (-not [bool]$baseline.brokerProcessAlive) { throw 'Fixture baseline broker process is not alive.' }
  if (-not [bool]$baseline.brokerHeartbeatFresh) { throw 'Fixture baseline heartbeat is not fresh.' }
  if (-not [bool]$baseline.brokerStatusPidMatch) { throw 'Fixture baseline broker PID does not match.' }
  if ([string]$baseline.startupRunnerLockState -ne 'HELD') {
    throw "Fixture baseline startup lock is not HELD. state=$($baseline.startupRunnerLockState)"
  }

  $observerArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ProbeLibrary "{1}" -WorkDir "{2}" -OutputPath "{3}"' -f $observerScript, $probeCopy, $tempRoot, $observerOutputPath
  $observerAction = New-ScheduledTaskAction -Execute $powerShellExe -Argument $observerArguments
  $observerTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(5))
  $observerSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2))
  $observerPrincipal = New-ScheduledTaskPrincipal -UserId 'NETWORK SERVICE' -LogonType ServiceAccount -RunLevel Limited
  Register-ScheduledTask -TaskName $observerTaskName -Action $observerAction -Trigger $observerTrigger -Settings $observerSettings -Principal $observerPrincipal -ErrorAction Stop | Out-Null
  $observerRegistered = $true
  Start-ScheduledTask -TaskName $observerTaskName -ErrorAction Stop

  $observerDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $observerOutputPath -PathType Leaf)) {
    $task = Get-ScheduledTask -TaskName $observerTaskName -ErrorAction Stop
    if ([string]$task.State -eq 'Ready') {
      $info = Get-ScheduledTaskInfo -TaskName $observerTaskName -ErrorAction Stop
      if ([int]$info.LastTaskResult -ne 0 -and [int]$info.LastTaskResult -ne 267009) {
        throw "NETWORK SERVICE observer failed before writing diagnostics. LastTaskResult=$($info.LastTaskResult)"
      }
    }
    if ([DateTime]::UtcNow -ge $observerDeadline) { throw 'Timed out waiting for NETWORK SERVICE ownership diagnostics.' }
    Start-Sleep -Milliseconds 50
  }

  $observerResult = Get-Content -LiteralPath $observerOutputPath -Raw | ConvertFrom-Json
  if (-not [bool]$observerResult.success) {
    $permissionDenied = ([string]$observerResult.errorType -eq 'System.UnauthorizedAccessException') -or ([string]$observerResult.category -eq 'PermissionDenied')
    if (-not $permissionDenied) {
      throw "ACL observer fixture failed for a non-permission reason. type=$($observerResult.errorType) category=$($observerResult.category) message=$($observerResult.message)"
    }

    # Access denial is not the production tuple under investigation. It means
    # the restricted observer failed closed before it could classify the lock
    # as physically MISSING, so this ACL mechanism does not reproduce the exact
    # generation-mismatch detector state.
    Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_ACL_OBSERVER_TEST=PASS'
    Write-Host 'ACL_FALSE_MISSING_HYPOTHESIS=REJECTED'
    Write-Host 'ACL_OBSERVER_OUTCOME=ACCESS_DENIED_NOT_MISSING'
    Write-Host "ACL_OBSERVER_ERROR_TYPE=$($observerResult.errorType)"
    Write-Host "ACL_OBSERVER_ERROR_CATEGORY=$($observerResult.category)"
    Write-Host "BASELINE_BROKER_PROCESS_ALIVE=$($baseline.brokerProcessAlive)"
    Write-Host "BASELINE_BROKER_HEARTBEAT_FRESH=$($baseline.brokerHeartbeatFresh)"
    Write-Host "BASELINE_BROKER_STATUS_PID_MATCH=$($baseline.brokerStatusPidMatch)"
    Write-Host "BASELINE_STARTUP_RUNNER_LOCK_STATE=$($baseline.startupRunnerLockState)"
    return
  }

  $snapshot = $observerResult.snapshot
  if (-not [bool]$snapshot.brokerProcessAlive) { throw 'Expected broker process to remain alive during ACL observation.' }
  if (-not [bool]$snapshot.brokerHeartbeatFresh) { throw 'Expected broker heartbeat to remain fresh during ACL observation.' }
  if (-not [bool]$snapshot.brokerStatusPidMatch) { throw 'Expected broker status/heartbeat PID to match during ACL observation.' }

  # This is the only outcome that reproduces the incident detector tuple: the
  # observer returned a normal snapshot while the real SYSTEM lock owner was
  # alive, yet classified that held lock as MISSING/non-HELD.
  if ([string]$snapshot.startupRunnerLockState -eq 'MISSING') {
    throw "RED: observer access denial was misclassified as MISSING while SYSTEM broker remained alive/fresh/PID-matched. exactGate=$($snapshot.exactGenerationMismatchGate)"
  }
  if ([bool]$snapshot.exactGenerationMismatchGate) {
    throw "RED: ACL observer produced a false exact generation mismatch. lockState=$($snapshot.startupRunnerLockState)"
  }

  Write-Host 'PHASE7C_RUNTIME_OWNERSHIP_ACL_OBSERVER_TEST=PASS'
  Write-Host 'ACL_FALSE_MISSING_HYPOTHESIS=REJECTED'
  Write-Host "ACL_OBSERVER_OUTCOME=SNAPSHOT_$($snapshot.startupRunnerLockState)"
  Write-Host "BROKER_PROCESS_ALIVE=$($snapshot.brokerProcessAlive)"
  Write-Host "BROKER_HEARTBEAT_FRESH=$($snapshot.brokerHeartbeatFresh)"
  Write-Host "BROKER_STATUS_PID_MATCH=$($snapshot.brokerStatusPidMatch)"
  Write-Host "STARTUP_RUNNER_LOCK_STATE=$($snapshot.startupRunnerLockState)"
  Write-Host "EXACT_GENERATION_MISMATCH_GATE=$($snapshot.exactGenerationMismatchGate)"
} finally {
  if ($observerRegistered) {
    try { Stop-ScheduledTask -TaskName $observerTaskName -ErrorAction SilentlyContinue } catch { }
    try { Unregister-ScheduledTask -TaskName $observerTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
  if ($ownerRegistered) {
    try { Stop-ScheduledTask -TaskName $ownerTaskName -ErrorAction SilentlyContinue } catch { }
    Start-Sleep -Milliseconds 250
    try { Unregister-ScheduledTask -TaskName $ownerTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
