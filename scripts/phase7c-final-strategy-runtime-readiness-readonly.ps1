param(
  [Parameter(Mandatory = $true)] [string]$ProjectRoot,
  [Parameter(Mandatory = $true)] [string]$ExpectedMainCommit,
  [string]$CanonicalPreflightPath = ""
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedMainCommit = $ExpectedMainCommit.Trim().ToLowerInvariant()
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if ($ExpectedMainCommit -notmatch '^[0-9a-f]{40}$') {
  throw 'ExpectedMainCommit must be an exact 40-character Git SHA.'
}
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
  throw 'ProjectRoot is unavailable.'
}
if ([string]::IsNullOrWhiteSpace($CanonicalPreflightPath)) {
  $CanonicalPreflightPath = Join-Path $PSScriptRoot 'preflight-phase7c-production-readonly-local.ps1'
}
$CanonicalPreflightPath = [System.IO.Path]::GetFullPath($CanonicalPreflightPath)
if (-not (Test-Path -LiteralPath $CanonicalPreflightPath -PathType Leaf)) {
  throw 'Canonical production read-only preflight is unavailable.'
}

Write-Host 'FINAL_STRATEGY_RUNTIME_READINESS_READ_ONLY=TRUE'
Write-Host 'FINAL_STRATEGY_DEPLOYMENT_MUTATION=NONE'
Write-Host 'FINAL_STRATEGY_BOT_MODE_MUTATION=NONE'
Write-Host 'FINAL_STRATEGY_ARM_MUTATION=NONE'
Write-Host 'FINAL_STRATEGY_ORDER_MUTATION=NONE'
Write-Host 'FINAL_STRATEGY_POSITION_MUTATION=NONE'
Write-Host 'FINAL_STRATEGY_ACCOUNT_SWITCH=NONE'

$stdout = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-final-strategy-" + [guid]::NewGuid().ToString('N') + '.out')
$stderr = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-final-strategy-" + [guid]::NewGuid().ToString('N') + '.err')
try {
  $args = @(
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File', $CanonicalPreflightPath,
    '-ProjectRoot', $ProjectRoot,
    '-ExpectedMainCommit', $ExpectedMainCommit,
    '-TimeoutSeconds', '12'
  )
  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $text = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw } else { '' }
  $errText = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }

  function Read-Key([string]$Name) {
    $match = [regex]::Match($text, "(?m)^" + [regex]::Escape($Name) + "=(.*)$")
    if (-not $match.Success) { return '' }
    return $match.Groups[1].Value.Trim()
  }

  foreach ($required in @(
    'READ_ONLY=TRUE',
    'HTTP_METHODS=GET_ONLY',
    'GIT_MUTATION=NONE',
    'MODE_MUTATION=NONE',
    'ARM_MUTATION=NONE',
    'ORDER_MUTATION=NONE',
    'POSITION_MUTATION=NONE',
    'LIVE_TEST_ORDER=NONE'
  )) {
    if (-not $text.Contains($required)) {
      throw "Canonical preflight missing read-only safety marker: $required"
    }
  }

  if ($proc.ExitCode -notin @(0,2)) {
    throw "Canonical preflight unexpected exit=$($proc.ExitCode); stderrPresent=$(-not [string]::IsNullOrWhiteSpace($errText))"
  }

  $expected = Read-Key 'EXPECTED_MAIN'
  $localHead = Read-Key 'LOCAL_HEAD'
  $deploymentSource = Read-Key 'DEPLOYMENT_SOURCE_COMMIT'
  $botMode = Read-Key 'BOT_MODE'
  $arm = Read-Key 'ARM'
  $positions = Read-Key 'XAUUSD_POSITIONS'
  $pending = Read-Key 'XAUUSD_PENDING_ORDERS'
  $runtimeOverall = Read-Key 'RUNTIME_SOURCE_OVERALL'
  $classification = Read-Key 'PREFLIGHT_CLASSIFICATION'
  $blockedBy = Read-Key 'BLOCKED_BY'
  $taskOwnership = Read-Key 'TASK_OWNERSHIP'
  $taskDrift = Read-Key 'TASK_DRIFT'
  $taskState = Read-Key 'TASK_STATE'
  $taskReadStatus = Read-Key 'TASK_READ_STATUS'
  $taskOwnershipEvaluation = Read-Key 'TASK_OWNERSHIP_EVALUATION'
  $taskRunnerHashStatus = Read-Key 'TASK_RUNNER_HASH_STATUS'
  $taskRunnerPathStatus = Read-Key 'TASK_RUNNER_PATH_STATUS'
  $taskRunnerShaStatus = Read-Key 'TASK_RUNNER_SHA_STATUS'
  $taskRunnerMissingCommand = Read-Key 'TASK_RUNNER_MISSING_COMMAND'
  $taskActionOwnershipStatus = Read-Key 'TASK_ACTION_OWNERSHIP_STATUS'
  $taskDriftEvaluationStatus = Read-Key 'TASK_DRIFT_EVALUATION_STATUS'
  $taskPrincipalEvaluationStatus = Read-Key 'TASK_PRINCIPAL_EVALUATION_STATUS'
  $taskOwnershipErrorStage = Read-Key 'TASK_OWNERSHIP_ERROR_STAGE'
  $taskOwnershipErrorType = Read-Key 'TASK_OWNERSHIP_ERROR_TYPE'

  if ([string]::IsNullOrWhiteSpace($classification)) {
    throw 'Canonical preflight classification is unavailable.'
  }

  $targetExact = (
    $expected -eq $ExpectedMainCommit -and
    $localHead -eq $ExpectedMainCommit -and
    $deploymentSource -eq $ExpectedMainCommit -and
    $runtimeOverall -eq 'EXACT_MATCH'
  )
  $flat = $positions -eq '0' -and $pending -eq '0'
  $taskReady = $taskOwnership -eq 'CANONICAL_SYSTEM' -and $taskDrift -eq 'NONE'
  $readyWithoutArmMutation = (
    $targetExact -and
    $flat -and
    $taskReady -and
    $botMode -eq 'PAUSE' -and
    $arm -eq 'DISARMED' -and
    $classification -eq 'NO_RECOVERY_REQUIRED'
  )

  Write-Host "FINAL_STRATEGY_EXPECTED_MAIN=$expected"
  Write-Host "FINAL_STRATEGY_PRODUCTION_HEAD=$localHead"
  Write-Host "FINAL_STRATEGY_DEPLOYMENT_SOURCE=$deploymentSource"
  Write-Host "FINAL_STRATEGY_RUNTIME_SOURCE_OVERALL=$runtimeOverall"
  Write-Host "FINAL_STRATEGY_BOT_MODE=$botMode"
  Write-Host "FINAL_STRATEGY_ARM=$arm"
  Write-Host "FINAL_STRATEGY_XAUUSD_POSITIONS=$positions"
  Write-Host "FINAL_STRATEGY_XAUUSD_PENDING_ORDERS=$pending"
  Write-Host "FINAL_STRATEGY_PREFLIGHT_CLASSIFICATION=$classification"
  Write-Host "FINAL_STRATEGY_BLOCKED_BY=$blockedBy"
  Write-Host "FINAL_STRATEGY_TASK_OWNERSHIP=$taskOwnership"
  Write-Host "FINAL_STRATEGY_TASK_DRIFT=$taskDrift"
  Write-Host "FINAL_STRATEGY_TASK_STATE=$taskState"
  Write-Host "FINAL_STRATEGY_TASK_READ_STATUS=$taskReadStatus"
  Write-Host "FINAL_STRATEGY_TASK_OWNERSHIP_EVALUATION=$taskOwnershipEvaluation"
  Write-Host "FINAL_STRATEGY_TASK_RUNNER_HASH_STATUS=$taskRunnerHashStatus"
  Write-Host "FINAL_STRATEGY_TASK_RUNNER_PATH_STATUS=$taskRunnerPathStatus"
  Write-Host "FINAL_STRATEGY_TASK_RUNNER_SHA_STATUS=$taskRunnerShaStatus"
  Write-Host "FINAL_STRATEGY_TASK_RUNNER_MISSING_COMMAND=$taskRunnerMissingCommand"
  Write-Host "FINAL_STRATEGY_TASK_ACTION_OWNERSHIP_STATUS=$taskActionOwnershipStatus"
  Write-Host "FINAL_STRATEGY_TASK_DRIFT_EVALUATION_STATUS=$taskDriftEvaluationStatus"
  Write-Host "FINAL_STRATEGY_TASK_PRINCIPAL_EVALUATION_STATUS=$taskPrincipalEvaluationStatus"
  Write-Host "FINAL_STRATEGY_TASK_OWNERSHIP_ERROR_STAGE=$taskOwnershipErrorStage"
  Write-Host "FINAL_STRATEGY_TASK_OWNERSHIP_ERROR_TYPE=$taskOwnershipErrorType"
  Write-Host "FINAL_STRATEGY_TASK_READY=$($taskReady.ToString().ToUpperInvariant())"
  Write-Host "FINAL_STRATEGY_TARGET_EXACT=$($targetExact.ToString().ToUpperInvariant())"
  Write-Host "FINAL_STRATEGY_DEPLOYMENT_READY_WITHOUT_ARM_MUTATION=$($readyWithoutArmMutation.ToString().ToUpperInvariant())"

  # Independent, sanitized task probe. This is deliberately read-only and separates
  # provider/action/hash/drift/principal failures that the canonical preflight groups
  # into TASK_READ_FAILED.
  $taskProbeProvider = 'UNAVAILABLE'
  $taskProbeOwnership = 'UNAVAILABLE'
  $taskProbeOwned = $false
  $taskProbeCanonical = $false
  $taskProbeRepairRequired = $false
  $taskProbePrincipalCanonical = $false
  $taskProbeDrift = 'UNAVAILABLE'
  $taskProbeRunnerHash = 'UNAVAILABLE'
  try {
    Import-Module ScheduledTasks -ErrorAction Stop
    $taskProbe = Get-ScheduledTask -TaskName 'XAUUSD-Phase7C-Executors' -ErrorAction Stop
    $taskProbeProvider = 'READABLE'

    $ownershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
    if (-not (Test-Path -LiteralPath $ownershipLibrary -PathType Leaf)) {
      throw 'Task ownership library is unavailable.'
    }
    . $ownershipLibrary

    $runnerPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot 'scripts\run-phase7c-executor-task-runner-local.ps1'))
    try {
      $runnerHash = (Get-FileHash -LiteralPath $runnerPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
      $taskProbeRunnerHash = 'READABLE'
      $ownershipProbe = Test-Phase7CExecutorTaskActionOwnership -Actions $taskProbe.Actions -ExpectedRunnerPath $runnerPath -ExpectedRunnerSha256 $runnerHash
      $taskProbeOwned = [bool]$ownershipProbe.owned
      $taskProbeCanonical = [bool]$ownershipProbe.canonical
      $taskProbeRepairRequired = [bool]$ownershipProbe.repairRequired
      $taskProbeOwnership = [string]$ownershipProbe.reason
    } catch {
      $taskProbeRunnerHash = 'ERROR'
      $taskProbeOwnership = 'OWNERSHIP_EVALUATION_ERROR'
    }

    try {
      $driftProbe = @(Get-Phase7CExecutorTaskDrift -Task $taskProbe)
      $taskProbeDrift = if ($driftProbe.Count -eq 0) { 'NONE' } else { @($driftProbe) -join '|' }
    } catch {
      $taskProbeDrift = 'DRIFT_EVALUATION_ERROR'
    }

    try {
      $principal = $taskProbe.Principal
      $user = if ($null -eq $principal) { '' } else { ([string]$principal.UserId).Trim() }
      $systemUser = $user -in @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18')
      $taskProbePrincipalCanonical = (
        $null -ne $principal -and
        $systemUser -and
        ([string]$principal.LogonType) -eq 'ServiceAccount' -and
        ([string]$principal.RunLevel) -eq 'Highest'
      )
    } catch {
      $taskProbePrincipalCanonical = $false
    }
  } catch {
    try {
      $taskProbeProvider = Get-Phase7CScheduledTaskErrorClassification -Exception $_.Exception
    } catch {
      $taskProbeProvider = 'PROVIDER_ERROR'
    }
  }

  Write-Host "FINAL_STRATEGY_TASK_PROBE_PROVIDER=$taskProbeProvider"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_RUNNER_HASH=$taskProbeRunnerHash"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_OWNED=$($taskProbeOwned.ToString().ToUpperInvariant())"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_CANONICAL=$($taskProbeCanonical.ToString().ToUpperInvariant())"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_REPAIR_REQUIRED=$($taskProbeRepairRequired.ToString().ToUpperInvariant())"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_OWNERSHIP_REASON=$taskProbeOwnership"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_DRIFT=$taskProbeDrift"
  Write-Host "FINAL_STRATEGY_TASK_PROBE_PRINCIPAL_CANONICAL=$($taskProbePrincipalCanonical.ToString().ToUpperInvariant())"

  Write-Host 'FINAL_STRATEGY_RAW_ACCOUNT_IDENTITY_PRINTED=FALSE'
} finally {
  Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
}
