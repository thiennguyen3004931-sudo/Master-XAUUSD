param(
  [string]$TaskName = 'XAUUSD-Phase7C-Executors',
  [string]$ProjectRoot = '',
  [switch]$Repair,
  [switch]$Create,
  [string]$PrincipalUserId = '',
  [ValidateSet('', 'Interactive', 'S4U', 'ServiceAccount')]
  [string]$PrincipalLogonType = '',
  [string]$ApiUserSid = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $ProjectRoot)) { throw "ProjectRoot not found: $ProjectRoot" }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

$helperPath = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
if (-not (Test-Path -LiteralPath $helperPath)) { throw "Scheduled task ownership helper not found: $helperPath" }
. $helperPath

$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) {
  throw "Windows PowerShell executable not found: $PowerShellExe"
}

$BrokerRoot = Join-Path $ProjectRoot '.runtime\phase7c-lifecycle-broker'
$BrokerInbox = Join-Path $BrokerRoot 'inbox'
$BrokerState = Join-Path $BrokerRoot 'state'
$BrokerResults = Join-Path $BrokerRoot 'results'
$BrokerLogs = Join-Path $BrokerRoot 'logs'
$ApiSidRecord = Join-Path $BrokerState 'api-user-sid.txt'
$BrokerHeartbeat = Join-Path $BrokerState 'heartbeat.json'

function Assert-Phase7CAdministrator {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Write-Host 'PHASE7C_TASK_ADMIN=REQUIRED'
      throw 'Run this script from PowerShell Administrator.'
    }
  } catch {
    if ($_.Exception.Message -eq 'Run this script from PowerShell Administrator.') { throw }
    Write-Host 'PHASE7C_TASK_ADMIN=UNAVAILABLE'
    throw "Cannot verify Administrator context. $($_.Exception.Message)"
  }
  Write-Host 'PHASE7C_TASK_ADMIN=PASS'
}

function New-Phase7CCanonicalAction([string]$RunnerPath, [string]$RunnerSha256) {
  $arguments = New-Phase7CExecutorTaskGuardArguments -RunnerPath $RunnerPath -RunnerSha256 $RunnerSha256
  return New-ScheduledTaskAction -Execute $PowerShellExe -Argument $arguments
}

function New-Phase7CCanonicalTrigger {
  return New-ScheduledTaskTrigger -AtStartup
}

function New-Phase7CCanonicalSettings {
  # The lifecycle broker is a long-lived safety/control service. It must be able
  # to start and remain alive while the Windows host is running on battery.
  # Demand start remains allowed by default; ScheduledTasks exposes only the
  # inverse -DisallowDemandStart switch on supported Windows versions.
  return New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
}

function Resolve-Phase7CApiUserSid([string]$RequestedSid) {
  $value = ([string]$RequestedSid).Trim()
  if ([string]::IsNullOrWhiteSpace($value) -and (Test-Path -LiteralPath $ApiSidRecord)) {
    $value = ([string](Get-Content -LiteralPath $ApiSidRecord -Raw)).Trim()
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    Write-Host 'PHASE7C_BROKER_API_SID=REQUIRED'
    throw 'Lifecycle broker installation requires -ApiUserSid for the Windows identity that runs the Web/API process.'
  }
  try {
    return New-Object System.Security.Principal.SecurityIdentifier($value)
  } catch {
    throw "ApiUserSid is not a valid Windows SecurityIdentifier: $value"
  }
}

function New-Phase7CBrokerDirectoryAcl(
  [string]$Path,
  [System.Security.Principal.SecurityIdentifier]$ApiSid,
  [System.Security.AccessControl.FileSystemRights]$ApiRights
) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null

  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $systemSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $adminsSid = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)

  foreach ($sid in @($systemSid, $adminsSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inherit,
      $propagation,
      $allow
    )
    [void]$acl.AddAccessRule($rule)
  }

  $apiRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $ApiSid,
    $ApiRights,
    $inherit,
    $propagation,
    $allow
  )
  [void]$acl.AddAccessRule($apiRule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-Phase7CLifecycleBrokerAcl([System.Security.Principal.SecurityIdentifier]$ApiSid) {
  # Root grants only traversal/read to the configured API identity. Child ACLs are
  # protected independently so state/results/logs cannot inherit inbox write rights.
  New-Phase7CBrokerDirectoryAcl -Path $BrokerRoot -ApiSid $ApiSid -ApiRights ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
  New-Phase7CBrokerDirectoryAcl -Path $BrokerInbox -ApiSid $ApiSid -ApiRights ([System.Security.AccessControl.FileSystemRights]::Modify)
  New-Phase7CBrokerDirectoryAcl -Path $BrokerState -ApiSid $ApiSid -ApiRights ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
  New-Phase7CBrokerDirectoryAcl -Path $BrokerResults -ApiSid $ApiSid -ApiRights ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
  New-Phase7CBrokerDirectoryAcl -Path $BrokerLogs -ApiSid $ApiSid -ApiRights ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)

  [System.IO.File]::WriteAllText($ApiSidRecord, "$($ApiSid.Value)`r`n", [System.Text.UTF8Encoding]::new($false))
  Write-Host "PHASE7C_BROKER_ACL=PASS|API_SID=$($ApiSid.Value)"
}

function Test-Phase7CSystemPrincipal($Principal) {
  if ($null -eq $Principal) { return $false }
  $user = ([string]$Principal.UserId).Trim()
  $logon = ([string]$Principal.LogonType).Trim()
  $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
  return $systemUser -and $logon -eq 'ServiceAccount' -and ([string]$Principal.RunLevel) -eq 'Highest'
}

function Test-Phase7CBrokerHeartbeatFresh {
  if (-not (Test-Path -LiteralPath $BrokerHeartbeat)) { return $false }
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

function Start-AndVerifyPhase7CBroker {
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    if (Test-Phase7CBrokerHeartbeatFresh) {
      Write-Host 'PHASE7C_BROKER_HEARTBEAT=PASS'
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  Write-Host 'PHASE7C_BROKER_HEARTBEAT=FAIL'
  throw 'Scheduled Task exists but lifecycle broker heartbeat.json did not become fresh.'
}

Assert-Phase7CAdministrator
Import-Module ScheduledTasks -ErrorAction Stop

# Prove runner source provenance before any ACL or Scheduled Task mutation. The
# task action pins this exact accepted worktree byte hash and rechecks it at run time.
$runnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $ProjectRoot
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw "Executor task runner not found: $runnerPath" }
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $ProjectRoot -Path $runnerPath
Write-Host "PHASE7C_TASK_EXPECTED_RUNNER=$runnerPath"
Write-Host "PHASE7C_TASK_EXPECTED_RUNNER_SHA256=$trustedRunnerSha256"
Write-Host "PHASE7C_TASK_EXPECTED_POWERSHELL=$PowerShellExe"

$resolvedApiSid = Resolve-Phase7CApiUserSid -RequestedSid $ApiUserSid
Set-Phase7CLifecycleBrokerAcl -ApiSid $resolvedApiSid

$task = $null
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
} catch {
  $classification = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
  Write-Host "PHASE7C_TASK_PROVIDER=$classification"
  if ($classification -ne 'NOT_FOUND') {
    throw "Cannot inspect Scheduled Task '$TaskName'; mutation blocked. classification=$classification"
  }
}

if ($null -eq $task) {
  Write-Host 'PHASE7C_TASK_STATE=NOT_FOUND'
  if (-not $Create) {
    Write-Host 'PHASE7C_TASK_MUTATION=BLOCKED'
    throw "Task '$TaskName' does not exist. Re-run with -Create, -PrincipalUserId SYSTEM, -PrincipalLogonType ServiceAccount, and -ApiUserSid after review."
  }
  if ([string]::IsNullOrWhiteSpace($PrincipalUserId)) {
    Write-Host 'PHASE7C_TASK_PRINCIPAL=REQUIRED'
    throw '-Create requires explicit -PrincipalUserId SYSTEM.'
  }
  if ([string]::IsNullOrWhiteSpace($PrincipalLogonType)) {
    Write-Host 'PHASE7C_TASK_LOGON_TYPE=REQUIRED'
    throw '-Create requires explicit -PrincipalLogonType ServiceAccount.'
  }
  if ($PrincipalUserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or $PrincipalLogonType -ne 'ServiceAccount') {
    Write-Host 'PHASE7C_TASK_PRINCIPAL=BLOCKED_NON_SYSTEM'
    throw 'The canonical lifecycle broker task must run as SYSTEM with ServiceAccount logon semantics.'
  }

  $action = New-Phase7CCanonicalAction -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256
  $trigger = New-Phase7CCanonicalTrigger
  $settings = New-Phase7CCanonicalSettings
  $principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest

  try {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -Principal $principal `
      -ErrorAction Stop | Out-Null
  } catch {
    $classification = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
    Write-Host "PHASE7C_TASK_CREATE=$classification"
    throw "Scheduled Task creation failed. classification=$classification. $($_.Exception.Message)"
  }

  $created = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $createdOwnership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $created.Actions `
    -ExpectedRunnerPath $runnerPath `
    -ExpectedRunnerSha256 $trustedRunnerSha256
  if (-not $createdOwnership.owned -or -not $createdOwnership.canonical -or $createdOwnership.repairRequired) {
    throw "Scheduled Task creation did not persist the canonical trusted runner guard. ownership=$($createdOwnership.reason)"
  }
  if (-not (Test-Phase7CSystemPrincipal $created.Principal)) {
    throw 'Scheduled Task creation did not persist SYSTEM + ServiceAccount + Highest.'
  }
  Write-Host 'PHASE7C_TASK_OWNERSHIP=OWNED'
  Write-Host 'PHASE7C_TASK_ACTION_PROVENANCE=CANONICAL_HASH_GUARD'
  Write-Host 'PHASE7C_TASK_CREATE=PASS'
  Start-AndVerifyPhase7CBroker
  Write-Host 'PHASE7C_TASK_STATUS=PASS'
  exit 0
}

$ownership = Test-Phase7CExecutorTaskActionOwnership `
  -Actions $task.Actions `
  -ExpectedRunnerPath $runnerPath `
  -ExpectedRunnerSha256 $trustedRunnerSha256
Write-Host "PHASE7C_TASK_OWNERSHIP=$($ownership.reason)"
if (-not $ownership.owned) {
  Write-Host 'PHASE7C_TASK_MUTATION=BLOCKED'
  throw "Task '$TaskName' ownership cannot be proven from its exact action. No mutation was attempted. reason=$($ownership.reason)"
}
if (-not (Test-Phase7CSystemPrincipal $task.Principal)) {
  Write-Host 'PHASE7C_TASK_PRINCIPAL_REPAIR=BLOCKED'
  throw 'Owned task is not SYSTEM + ServiceAccount + Highest. Automatic principal replacement is intentionally blocked.'
}

$drift = @(Get-Phase7CExecutorTaskDrift -Task $task)
if ([string]$task.Actions[0].Execute -ne $PowerShellExe) { $drift += 'ACTION_EXECUTABLE' }
if ([bool]$ownership.repairRequired -or -not [bool]$ownership.canonical) {
  $drift += ("ACTION_PROVENANCE:{0}" -f [string]$ownership.reason)
}
Write-Host "PHASE7C_TASK_DRIFT=$(if ($drift.Count -eq 0) { 'NONE' } else { $drift -join ',' })"
Write-Host "PHASE7C_TASK_PRINCIPAL_USER=$($task.Principal.UserId)"
Write-Host "PHASE7C_TASK_PRINCIPAL_RUN_LEVEL=$($task.Principal.RunLevel)"
Write-Host "PHASE7C_TASK_PRINCIPAL_LOGON_TYPE=$($task.Principal.LogonType)"

if ($drift.Count -eq 0) {
  if (-not $ownership.canonical -or $ownership.repairRequired) {
    Write-Host 'PHASE7C_TASK_ACTION_PROVENANCE=VERIFY_FAILED'
    throw 'Task drift evaluation reached start with a non-canonical runner provenance action.'
  }
  Write-Host 'PHASE7C_TASK_MUTATION=NOT_REQUIRED'
  Write-Host 'PHASE7C_TASK_ACTION_PROVENANCE=CANONICAL_HASH_GUARD'
  Start-AndVerifyPhase7CBroker
  Write-Host 'PHASE7C_TASK_STATUS=PASS'
  exit 0
}

if ($drift -contains 'PRINCIPAL_RUN_LEVEL') {
  Write-Host 'PHASE7C_TASK_PRINCIPAL_REPAIR=BLOCKED'
  throw 'Task principal is not RunLevel=Highest. Automatic principal replacement is intentionally blocked.'
}
if (-not $Repair) {
  Write-Host 'PHASE7C_TASK_MUTATION=REPAIR_REQUIRED'
  throw 'Owned task has canonical-definition or runner-provenance drift. Re-run with -Repair after confirming PAUSE and zero XAUUSD positions.'
}
if ([string]$task.State -eq 'Running') {
  Write-Host 'PHASE7C_TASK_RUNTIME_MIGRATION=BLOCKED_RUNNING'
  throw 'Stop the existing executor runtime safely before repairing the SYSTEM task definition; installer will not terminate a running task implicitly.'
}

$action = New-Phase7CCanonicalAction -RunnerPath $runnerPath -RunnerSha256 $trustedRunnerSha256
$trigger = New-Phase7CCanonicalTrigger
$settings = New-Phase7CCanonicalSettings
try {
  Set-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $task.Principal `
    -ErrorAction Stop | Out-Null
} catch {
  $classification = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
  Write-Host "PHASE7C_TASK_REPAIR=$classification"
  throw "Scheduled Task repair failed. classification=$classification. $($_.Exception.Message)"
}

$verified = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$verifiedOwnership = Test-Phase7CExecutorTaskActionOwnership `
  -Actions $verified.Actions `
  -ExpectedRunnerPath $runnerPath `
  -ExpectedRunnerSha256 $trustedRunnerSha256
$verifiedDrift = @(Get-Phase7CExecutorTaskDrift -Task $verified)
if ([string]$verified.Actions[0].Execute -ne $PowerShellExe) { $verifiedDrift += 'ACTION_EXECUTABLE' }
if ([bool]$verifiedOwnership.repairRequired -or -not [bool]$verifiedOwnership.canonical) {
  $verifiedDrift += ("ACTION_PROVENANCE:{0}" -f [string]$verifiedOwnership.reason)
}
if (-not $verifiedOwnership.owned -or -not $verifiedOwnership.canonical -or $verifiedOwnership.repairRequired -or $verifiedDrift.Count -ne 0 -or -not (Test-Phase7CSystemPrincipal $verified.Principal)) {
  Write-Host 'PHASE7C_TASK_REPAIR=VERIFY_FAILED'
  throw "Scheduled Task repair did not converge to the canonical SYSTEM-owned trusted runner definition. ownership=$($verifiedOwnership.reason) drift=$($verifiedDrift -join ',')"
}

Write-Host 'PHASE7C_TASK_REPAIR=PASS'
Write-Host 'PHASE7C_TASK_ACTION_PROVENANCE=CANONICAL_HASH_GUARD'
Start-AndVerifyPhase7CBroker
Write-Host 'PHASE7C_TASK_STATUS=PASS'
