[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedEmbeddedRunnerSha256,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedRunnerSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ownershipLibrary = Join-Path $PSScriptRoot "lib\phase7c-scheduled-task-ownership.ps1"
if (-not (Test-Path -LiteralPath $ownershipLibrary -PathType Leaf)) {
    throw "OWNERSHIP_LIBRARY_NOT_FOUND path=$ownershipLibrary"
}
. $ownershipLibrary
Import-Module ScheduledTasks -ErrorAction Stop

function Test-Phase7CCanonicalSystemPrincipal {
    param([Parameter(Mandatory = $true)] $Principal)

    if ($null -eq $Principal) { return $false }
    $user = ([string]$Principal.UserId).Trim()
    $systemUser = $user -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
    return $systemUser -and `
        [string]$Principal.LogonType -eq 'ServiceAccount' -and `
        [string]$Principal.RunLevel -eq 'Highest'
}

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$TaskName = 'XAUUSD-Phase7C-Executors'
$TaskPath = '\'
$resolvedRunnerPath = Get-Phase7CExecutorTaskRunnerPath -ProjectRoot $projectRoot
$expectedEmbeddedSha = Normalize-Phase7CRunnerSha256 -Sha256 $ExpectedEmbeddedRunnerSha256
$expectedSha = Normalize-Phase7CRunnerSha256 -Sha256 $ExpectedRunnerSha256

$actualRunnerSha256 = (Get-FileHash -LiteralPath $resolvedRunnerPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
$trustedRunnerSha256 = Get-Phase7CTrustedGitFileSha256 -ProjectRoot $projectRoot -Path $resolvedRunnerPath
if ($actualRunnerSha256 -ne $trustedRunnerSha256) {
    throw "RUNNER_TRUSTED_SHA_MISMATCH trusted=$trustedRunnerSha256 actual=$actualRunnerSha256"
}
if ($actualRunnerSha256 -ne $expectedSha) {
    throw "RUNNER_ACTUAL_SHA_MISMATCH expected=$expectedSha actual=$actualRunnerSha256"
}

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
$preOwnership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $task.Actions `
    -ExpectedRunnerPath $resolvedRunnerPath `
    -ExpectedRunnerSha256 $expectedSha
$preTaskDrift = @(Get-Phase7CExecutorTaskDrift -Task $task)

if (-not (Test-Phase7CCanonicalSystemPrincipal -Principal $task.Principal)) {
    throw "PRE_REPAIR_PRINCIPAL_NOT_CANONICAL_SYSTEM"
}
if ($preTaskDrift.Count -ne 0) {
    throw "PRE_REPAIR_TASK_DRIFT drift=$($preTaskDrift -join ',')"
}
if (-not $preOwnership.owned) {
    throw "TASK_NOT_PHASE7C_OWNED reason=$($preOwnership.reason)"
}

if ($preOwnership.canonical) {
    if ($preOwnership.repairRequired) {
        throw "OWNERSHIP_CONTRACT_INCONSISTENT canonical=True repairRequired=True"
    }
    Write-Output "SKIP=OWNED_CANONICAL"
    Write-Output "OWNERSHIP_OWNED=True"
    Write-Output "OWNERSHIP_CANONICAL=True"
    Write-Output "OWNERSHIP_REPAIRREQUIRED=False"
    Write-Output "OWNERSHIP_RUNNERSHA256=$($preOwnership.runnerSha256)"
    Write-Output "TASK_DRIFT=NONE"
    Write-Output "MUTATION=NONE"
    Write-Output "REPAIR_SCOPE=RUNNER_HASH_ONLY"
    exit 0
}

if (-not $preOwnership.repairRequired) {
    throw "REPAIR_NOT_REQUIRED_BUT_NONCANONICAL reason=$($preOwnership.reason)"
}
if ($preOwnership.reason -ne "OWNED_HASH_DRIFT_REPAIR_REQUIRED") {
    throw "REPAIR_SCOPE_REJECTED reason=$($preOwnership.reason)"
}

$preEmbeddedSha = Normalize-Phase7CRunnerSha256 -Sha256 ([string]$preOwnership.runnerSha256)
if ($preEmbeddedSha -ne $expectedEmbeddedSha) {
    throw "PRE_REPAIR_EMBEDDED_SHA_MISMATCH expected=$expectedEmbeddedSha actual=$preEmbeddedSha"
}
Write-Output "PRE_REPAIR_RUNNERSHA256=$preEmbeddedSha"
Write-Output "DRIFT_REASON=RUNNER_HASH_DRIFT"
Write-Output "ONLY_CONFIRMED_DRIFT=RUNNER_HASH"

$existingAction = @($task.Actions)[0]
$existingExecute = [string]$existingAction.Execute
$existingWorkingDirectory = [string]$existingAction.WorkingDirectory
$guardArguments = New-Phase7CExecutorTaskGuardArguments `
    -RunnerPath $resolvedRunnerPath `
    -RunnerSha256 $expectedSha

if ([string]::IsNullOrWhiteSpace($existingWorkingDirectory)) {
    $action = New-ScheduledTaskAction `
        -Execute $existingExecute `
        -Argument $guardArguments
} else {
    $action = New-ScheduledTaskAction `
        -Execute $existingExecute `
        -Argument $guardArguments `
        -WorkingDirectory $existingWorkingDirectory
}

Set-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath $TaskPath `
    -Action $action `
    -ErrorAction Stop | Out-Null

$postTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
$postOwnership = Test-Phase7CExecutorTaskActionOwnership `
    -Actions $postTask.Actions `
    -ExpectedRunnerPath $resolvedRunnerPath `
    -ExpectedRunnerSha256 $expectedSha
$postTaskDrift = @(Get-Phase7CExecutorTaskDrift -Task $postTask)

if (-not (Test-Phase7CCanonicalSystemPrincipal -Principal $postTask.Principal)) {
    throw "POST_REPAIR_PRINCIPAL_NOT_CANONICAL_SYSTEM"
}
if (-not $postOwnership.owned) {
    throw "POST_REPAIR_OWNERSHIP_FAILED owned=False reason=$($postOwnership.reason)"
}
if (-not $postOwnership.canonical) {
    throw "POST_REPAIR_CANONICAL_FAILED reason=$($postOwnership.reason)"
}
if ($postOwnership.repairRequired) {
    throw "POST_REPAIR_STILL_REQUIRED reason=$($postOwnership.reason)"
}
if ($postTaskDrift.Count -ne 0) {
    throw "POST_REPAIR_TASK_DRIFT drift=$($postTaskDrift -join ',')"
}
$postSha = Normalize-Phase7CRunnerSha256 -Sha256 ([string]$postOwnership.runnerSha256)
if ($postSha -ne $expectedSha) {
    throw "POST_REPAIR_RUNNER_SHA_MISMATCH expected=$expectedSha actual=$postSha"
}

Write-Output "OWNERSHIP_OWNED=True"
Write-Output "OWNERSHIP_CANONICAL=True"
Write-Output "OWNERSHIP_REPAIRREQUIRED=False"
Write-Output "OWNERSHIP_RUNNERSHA256=$postSha"
Write-Output "TASK_DRIFT=NONE"
Write-Output "MUTATION=TASK_DEFINITION_ONLY"
Write-Output "REPAIR_SCOPE=RUNNER_HASH_ONLY"
