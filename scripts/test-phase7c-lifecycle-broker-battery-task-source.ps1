$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$InstallerPath = Join-Path $PSScriptRoot "register-phase7c-executor-task-local.ps1"
$OwnershipPath = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"

foreach ($required in @($InstallerPath, $OwnershipPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Required battery task source not found: $required"
  }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) {
    throw "PowerShell syntax error in ${Path}: $($errors[0].Message)"
  }
}

Assert-PowerShellSyntax $InstallerPath
Assert-PowerShellSyntax $OwnershipPath

$installer = Get-Content -LiteralPath $InstallerPath -Raw
$ownershipSource = Get-Content -LiteralPath $OwnershipPath -Raw

if ($installer -notmatch 'function\s+New-Phase7CCanonicalSettings[\s\S]*-AllowStartIfOnBatteries') {
  throw 'RED: canonical Phase7C lifecycle broker task must explicitly allow start while the host is on battery power.'
}
if ($installer -notmatch 'function\s+New-Phase7CCanonicalSettings[\s\S]*-DontStopIfGoingOnBatteries') {
  throw 'Canonical Phase7C lifecycle broker task must not be stopped merely because the host switches to battery power.'
}
if ($installer -notmatch 'function\s+New-Phase7CCanonicalSettings[\s\S]*-StartWhenAvailable') {
  throw 'Battery-safe task settings must preserve StartWhenAvailable.'
}
if ($installer -notmatch 'function\s+New-Phase7CCanonicalSettings[\s\S]*-MultipleInstances\s+IgnoreNew') {
  throw 'Battery-safe task settings must preserve MultipleInstances IgnoreNew.'
}
if ($installer -notmatch 'function\s+New-Phase7CCanonicalSettings[\s\S]*-ExecutionTimeLimit\s+\(\[TimeSpan\]::Zero\)') {
  throw 'Battery-safe task settings must preserve the unlimited broker execution time contract.'
}

if ($ownershipSource -notmatch 'DISALLOW_START_IF_ON_BATTERIES') {
  throw 'Task drift detection must classify battery-start blocking as repairable canonical settings drift.'
}
if ($ownershipSource -notmatch 'STOP_IF_GOING_ON_BATTERIES') {
  throw 'Task drift detection must classify stop-on-battery as repairable canonical settings drift.'
}

. $OwnershipPath

function New-TestPhase7CTask {
  param(
    [bool]$DisallowStartIfOnBatteries,
    [bool]$StopIfGoingOnBatteries
  )

  return [pscustomobject]@{
    Triggers = @(
      [pscustomobject]@{
        CimClassName = 'MSFT_TaskBootTrigger'
      }
    )
    Settings = [pscustomobject]@{
      AllowDemandStart = $true
      StartWhenAvailable = $true
      MultipleInstances = 'IgnoreNew'
      RestartCount = 0
      ExecutionTimeLimit = 'PT0S'
      DisallowStartIfOnBatteries = $DisallowStartIfOnBatteries
      StopIfGoingOnBatteries = $StopIfGoingOnBatteries
    }
    Principal = [pscustomobject]@{
      RunLevel = 'Highest'
    }
  }
}

$canonical = @(Get-Phase7CExecutorTaskDrift -Task (New-TestPhase7CTask -DisallowStartIfOnBatteries $false -StopIfGoingOnBatteries $false))
if ($canonical.Count -ne 0) {
  throw "Battery-safe canonical settings must be drift-free. actual=$($canonical -join ',')"
}

$blockedStart = @(Get-Phase7CExecutorTaskDrift -Task (New-TestPhase7CTask -DisallowStartIfOnBatteries $true -StopIfGoingOnBatteries $false))
if ($blockedStart -notcontains 'DISALLOW_START_IF_ON_BATTERIES') {
  throw "Battery-start blocking must require task repair. actual=$($blockedStart -join ',')"
}

$stopOnBattery = @(Get-Phase7CExecutorTaskDrift -Task (New-TestPhase7CTask -DisallowStartIfOnBatteries $false -StopIfGoingOnBatteries $true))
if ($stopOnBattery -notcontains 'STOP_IF_GOING_ON_BATTERIES') {
  throw "Stop-on-battery must require task repair. actual=$($stopOnBattery -join ',')"
}

Write-Host 'PHASE7C_LIFECYCLE_BROKER_BATTERY_TASK_SOURCE=PASS'
