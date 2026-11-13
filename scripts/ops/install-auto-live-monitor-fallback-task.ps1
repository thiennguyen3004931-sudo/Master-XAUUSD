param(
  [string]$TaskName = 'XAUUSD-AUTO-LIVE-ReadOnly-Monitor-Clock',
  [string]$Repository = 'thiennguyen3004931-sudo/xauusd-ai-master-core',
  [string]$Workflow = 'auto-live-event-monitor.yml',
  [string]$Ref = 'main',
  [int]$IntervalMinutes = 5,
  [switch]$CheckPrerequisitesOnly,
  [switch]$Prime
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($IntervalMinutes -ne 5) {
  throw "FALLBACK_INTERVAL_MUST_BE_5_MINUTES actual=$IntervalMinutes"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GH_CLI_NOT_FOUND'
}

$originalGhToken = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'Process')
$originalGithubToken = [Environment]::GetEnvironmentVariable('GITHUB_TOKEN', 'Process')
try {
  [Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'Process')
  [Environment]::SetEnvironmentVariable('GITHUB_TOKEN', $null, 'Process')
  & gh auth status --hostname github.com
  if ($LASTEXITCODE -ne 0) {
    throw 'GH_PERSISTENT_AUTH_NOT_READY'
  }
} finally {
  [Environment]::SetEnvironmentVariable('GH_TOKEN', $originalGhToken, 'Process')
  [Environment]::SetEnvironmentVariable('GITHUB_TOKEN', $originalGithubToken, 'Process')
}

Write-Host 'GH_PERSISTENT_AUTH=PASS'
Write-Host 'PRODUCTION_MUTATION=NONE'
Write-Host 'PRODUCTION_HTTP_METHODS=NONE'

if ($CheckPrerequisitesOnly) {
  Write-Host 'WINDOWS_FALLBACK_PREREQUISITES=PASS'
  exit 0
}

$sourceTrigger = Join-Path $PSScriptRoot 'trigger-auto-live-monitor-workflow.ps1'
if (-not (Test-Path -LiteralPath $sourceTrigger)) {
  throw "FALLBACK_TRIGGER_SOURCE_MISSING=$sourceTrigger"
}

$runnerRoot = $null
if ($env:RUNNER_TEMP) {
  $workRoot = Split-Path -Parent $env:RUNNER_TEMP
  if ($workRoot) {
    $runnerRoot = Split-Path -Parent $workRoot
  }
}
if (-not $runnerRoot -or -not (Test-Path -LiteralPath $runnerRoot)) {
  $runnerRoot = 'C:\actions-runner'
}
if (-not (Test-Path -LiteralPath $runnerRoot)) {
  throw "RUNNER_ROOT_NOT_FOUND=$runnerRoot"
}

$installRoot = Join-Path $runnerRoot '_xauusd-auto-live-monitor'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$installedTrigger = Join-Path $installRoot 'trigger-auto-live-monitor-workflow.ps1'
Copy-Item -LiteralPath $sourceTrigger -Destination $installedTrigger -Force

$pwsh = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $pwsh)) {
  throw "WINDOWS_POWERSHELL_NOT_FOUND=$pwsh"
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userId = [string]$identity.Name
$expectedSid = [string]$identity.User.Value
$defaultDomain = $env:COMPUTERNAME
if ($userId -match '^([^\\]+)\\') {
  $defaultDomain = $Matches[1]
}

function Resolve-PrincipalSid {
  param(
    [Parameter(Mandatory = $true)][string]$Account,
    [Parameter(Mandatory = $true)][string]$DefaultDomain
  )

  try {
    if ($Account -match '\\') {
      $ntAccount = New-Object System.Security.Principal.NTAccount($Account)
    } else {
      $ntAccount = New-Object System.Security.Principal.NTAccount($DefaultDomain, $Account)
    }
    return [string]$ntAccount.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    throw "TASK_PRINCIPAL_SID_RESOLUTION_FAILED account=$Account domain=$DefaultDomain error=$($_.Exception.Message)"
  }
}

$actionArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Repository "{1}" -Workflow "{2}" -Ref "{3}" -MinGapMinutes 4' -f $installedTrigger, $Repository, $Workflow, $Ref
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $actionArgs
$startAt = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '5-minute fallback clock for the existing AUTO LIVE GET-only monitor workflow. Does not access production directly.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop

$actualPrincipalUser = [string]$registered.Principal.UserId
$actualSid = Resolve-PrincipalSid -Account $actualPrincipalUser -DefaultDomain $defaultDomain
if (-not [string]::Equals($expectedSid, $actualSid, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "TASK_PRINCIPAL_SID_MISMATCH expected_user=$userId expected_sid=$expectedSid actual_user=$actualPrincipalUser actual_sid=$actualSid"
}
if ($registered.Principal.RunLevel -ne 'Limited') {
  throw "TASK_RUNLEVEL_NOT_LIMITED actual=$($registered.Principal.RunLevel)"
}
if ($registered.Settings.MultipleInstances -ne 'IgnoreNew') {
  throw "TASK_MULTIPLE_INSTANCES_GUARD_MISSING actual=$($registered.Settings.MultipleInstances)"
}

Write-Host "WINDOWS_FALLBACK_TASK=$TaskName"
Write-Host "WINDOWS_FALLBACK_TASK_STATE=$($registered.State)"
Write-Host "WINDOWS_FALLBACK_TASK_USER=$userId"
Write-Host "WINDOWS_FALLBACK_TASK_PRINCIPAL=$actualPrincipalUser"
Write-Host "WINDOWS_FALLBACK_TASK_PRINCIPAL_SID=$actualSid"
Write-Host "WINDOWS_FALLBACK_TASK_RUNLEVEL=$($registered.Principal.RunLevel)"
Write-Host "WINDOWS_FALLBACK_INTERVAL_MINUTES=$IntervalMinutes"
Write-Host "WINDOWS_FALLBACK_NEXT_RUN=$($info.NextRunTime.ToString('o'))"
Write-Host "WINDOWS_FALLBACK_TRIGGER_PATH=$installedTrigger"
Write-Host 'WINDOWS_FALLBACK_PRODUCTION_ACCESS=NONE'
Write-Host 'WINDOWS_FALLBACK_MONITOR_DISPATCH_ONLY=TRUE'

if ($Prime) {
  & $installedTrigger -Repository $Repository -Workflow $Workflow -Ref $Ref -MinGapMinutes 4 -Force
  if ($LASTEXITCODE -ne 0) {
    throw "WINDOWS_FALLBACK_PRIME_FAILED exit=$LASTEXITCODE"
  }
  Write-Host 'WINDOWS_FALLBACK_PRIME=PASS'
}

Write-Host 'WINDOWS_FALLBACK_TASK_INSTALL=PASS'
