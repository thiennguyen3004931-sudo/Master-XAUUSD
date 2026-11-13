param(
  [int]$RestartDelaySeconds = 15
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1"
$Stopper = Join-Path $PSScriptRoot "stop-phase7c-executors-local.ps1"
$GuardLibrary = Join-Path $PSScriptRoot "lib\phase7c-startup-runner-guard.ps1"
$AccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$BrokerLibrary = Join-Path $PSScriptRoot "lib\phase7c-lifecycle-broker.ps1"
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
$ConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"

foreach ($required in @($Supervisor, $Stopper, $GuardLibrary, $AccountLibrary, $BrokerLibrary, $RuntimeSourceAttestationLibrary, $ConfigPath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Phase7C lifecycle broker required file not found: $required" }
}
if ($RestartDelaySeconds -lt 5 -or $RestartDelaySeconds -gt 300) { throw "RestartDelaySeconds must be between 5 and 300." }
. $GuardLibrary
. $AccountLibrary
. $BrokerLibrary
. $RuntimeSourceAttestationLibrary

# Canonical lifecycle result tokens are kept explicit for audit/source contracts.
$CanonicalReasonCodes = @(
  "OK_STARTED",
  "OK_STOPPED",
  "OK_RESTARTED",
  "NOOP_ALREADY_RUNNING",
  "NOOP_ALREADY_STOPPED",
  "REJECT_BROKER_BUSY",
  "REJECT_BOT_NOT_PAUSED",
  "REJECT_OPEN_XAUUSD_POSITION",
  "REJECT_ACCOUNT_INVALID",
  "REJECT_BRIDGE_UNAVAILABLE",
  "REJECT_LIVE_AUTH_INVALID",
  "REJECT_REQUEST_INVALID",
  "REJECT_REQUEST_STALE",
  "REJECT_REQUEST_DUPLICATE",
  "FAIL_STOP_TIMEOUT",
  "FAIL_START_TIMEOUT",
  "FAIL_SUPERVISOR_EXITED",
  "FAIL_INTERNAL"
)

function Read-Phase7CCanonicalLaunchConfig {
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $configVersion = [int]$config.version
  if ($configVersion -notin @(1, 2)) { throw "Unsupported executor task config version: $configVersion" }
  if (-not [bool]$config.armed) { throw "Executor task config must remain armed=true." }

  if ($configVersion -eq 1) {
    if (-not [bool]$config.demoOnly) { throw "Legacy v1 executor task config must remain demoOnly=true." }
    $accountMode = "DEMO"
    $liveExecutionEnabled = $false
  } else {
    $accountMode = ConvertTo-Phase7CAccountMode ([string]$config.accountMode)
    $liveExecutionEnabled = if ($null -ne $config.PSObject.Properties["liveExecutionEnabled"]) { [bool]$config.liveExecutionEnabled } else { $false }
    $demoOnly = if ($null -ne $config.PSObject.Properties["demoOnly"]) { [bool]$config.demoOnly } else { $accountMode -eq "DEMO" }
    if ($accountMode -eq "DEMO" -and -not $demoOnly) { throw "DEMO v2 task config must keep demoOnly=true." }
    if ($accountMode -eq "DEMO" -and $liveExecutionEnabled) { throw "DEMO v2 task config cannot enable liveExecutionEnabled." }
    if ($accountMode -eq "LIVE" -and $demoOnly) { throw "LIVE v2 task config must set demoOnly=false." }
    if ($accountMode -eq "LIVE" -and -not $liveExecutionEnabled) { throw "LIVE v2 task config requires liveExecutionEnabled=true." }
  }

  $workDir = [string]$config.workDir
  $controlApiUrl = ([string]$config.controlApiUrl).TrimEnd('/')
  $envFile = [string]$config.envFile
  $telegramEnvFile = [string]$config.telegramEnvFile
  $nodePath = [string]$config.nodePath
  $pnpmPath = [string]$config.pnpmPath
  $trendFixedVolume = if ($null -ne $config.PSObject.Properties["trendFixedVolume"]) { [double]$config.trendFixedVolume } else { 0.03 }
  $sidewayRiskPercent = [double]$config.sidewayRiskPercent
  $sidewayMaxLot = [double]$config.sidewayMaxLot

  if (-not (Test-Path -LiteralPath $workDir)) { throw "Executor task WorkDir not found: $workDir" }
  $workDir = (Resolve-Path -LiteralPath $workDir).Path

  # Web account selection is canonical durable state, while the SYSTEM task config
  # remains the privileged launch definition. Reconcile only v2 account context here
  # so a stale task config cannot override a guarded Web/local account selection.
  if ($configVersion -eq 2) {
    $accountStatePath = Join-Path $workDir "phase7c-account-mode.json"
    if (Test-Path -LiteralPath $accountStatePath) {
      try {
        $accountState = Get-Content -LiteralPath $accountStatePath -Raw | ConvertFrom-Json
        if ([int]$accountState.version -ne 1) { throw "account-mode state version must be 1." }
        $canonicalAccountMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
        $canonicalLiveExecutionEnabled = [bool]$accountState.liveExecutionEnabled
        if ($canonicalAccountMode -eq "DEMO" -and $canonicalLiveExecutionEnabled) {
          throw "Canonical DEMO account state cannot enable liveExecutionEnabled."
        }
        if ($canonicalAccountMode -eq "LIVE" -and -not $canonicalLiveExecutionEnabled) {
          throw "Canonical LIVE account state requires liveExecutionEnabled=true."
        }
        $canonicalEnvFile = ([string]$accountState.envFile).Trim()
        if ([string]::IsNullOrWhiteSpace($canonicalEnvFile)) {
          throw "Canonical account state envFile is required."
        }
        $accountMode = $canonicalAccountMode
        $liveExecutionEnabled = $canonicalLiveExecutionEnabled
        $envFile = $canonicalEnvFile
      } catch {
        throw "Canonical account-mode state is invalid at $accountStatePath. $($_.Exception.Message)"
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($controlApiUrl) -or $controlApiUrl -notmatch '^http://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$') {
    throw "Executor task ControlApiUrl must be localhost HTTP."
  }
  if (-not (Test-Path -LiteralPath $telegramEnvFile)) { throw "Executor task TelegramEnvFile not found: $telegramEnvFile" }
  if ([string]::IsNullOrWhiteSpace($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Executor task nodePath is missing/invalid: $nodePath" }
  if ([string]::IsNullOrWhiteSpace($pnpmPath) -or -not (Test-Path -LiteralPath $pnpmPath -PathType Leaf)) { throw "Executor task pnpmPath is missing/invalid: $pnpmPath" }
  $envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode $accountMode -RequireTrading
  $envFile = $envInfo.envFile

  # Re-read canonical lot settings on every START / RESTART / recovery launch.
  $lotSettingsPath = Join-Path $workDir "phase7c-lot-settings.json"
  if (Test-Path -LiteralPath $lotSettingsPath) {
    try {
      $lotSettings = Get-Content -LiteralPath $lotSettingsPath -Raw | ConvertFrom-Json
      [void](Assert-Phase7CRiskProfile $lotSettings "Executor task lot settings")
      $trendFixedVolume = [double]$lotSettings.trendFixedLot
      $sidewayRiskPercent = [double]$lotSettings.sidewayRiskPercent
      $sidewayMaxLot = [double]$lotSettings.sidewayMaxLot
    } catch {
      throw "Executor task lot settings are invalid at $lotSettingsPath. $($_.Exception.Message)"
    }
  }
  $effectiveLot = Assert-Phase7CRiskProfile ([pscustomobject]@{
    version = 1
    trendFixedLot = $trendFixedVolume
    sidewayRiskPercent = $sidewayRiskPercent
    sidewayMaxLot = $sidewayMaxLot
  }) "Executor task effective lot settings"

  return [pscustomobject]@{
    version = $configVersion
    accountMode = $accountMode
    liveExecutionEnabled = $liveExecutionEnabled
    workDir = $workDir
    controlApiUrl = $controlApiUrl
    envFile = $envFile
    telegramEnvFile = (Resolve-Path -LiteralPath $telegramEnvFile).Path
    nodePath = (Resolve-Path -LiteralPath $nodePath).Path
    pnpmPath = (Resolve-Path -LiteralPath $pnpmPath).Path
    trendFixedVolume = [double]$effectiveLot.trendFixedLot
    sidewayRiskPercent = [double]$effectiveLot.sidewayRiskPercent
    sidewayMaxLot = [double]$effectiveLot.sidewayMaxLot
  }
}

$bootConfig = Read-Phase7CCanonicalLaunchConfig
$workDir = [string]$bootConfig.workDir
$controlApiUrl = [string]$bootConfig.controlApiUrl
$runtimeDir = Join-Path $workDir "phase7c-executors"
$attemptsRoot = Join-Path $runtimeDir "attempts"
$brokerRoot = Join-Path $workDir "phase7c-lifecycle-broker"
$inboxDir = Join-Path $brokerRoot "inbox"
$stateDir = Join-Path $brokerRoot "state"
$resultsDir = Join-Path $brokerRoot "results"
$logsDir = Join-Path $brokerRoot "logs"
foreach ($directory in @($runtimeDir, $attemptsRoot, $brokerRoot, $inboxDir, $stateDir, $resultsDir, $logsDir)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
$requestPath = Join-Path $inboxDir "request.json"
$statusPath = Join-Path $stateDir "status.json"
$heartbeatPath = Join-Path $stateDir "heartbeat.json"
$desiredExecutorStatePath = Join-Path $stateDir "desired-executor-state.json"
$brokerLogPath = Join-Path $logsDir "broker.log"
$runnerLockPath = Join-Path $runtimeDir "startup-runner.lock"

$runnerLock = $null
try {
  $runnerLock = Open-Phase7CStartupRunnerLock -Path $runnerLockPath
  Write-Host "PHASE7C_EXECUTOR_TASK_RUNNER_LOCK=ACQUIRED|PID=$PID"
} catch {
  Write-Host "PHASE7C_EXECUTOR_TASK_RUNNER_LOCK=BLOCKED|PID=$PID"
  throw
}

$brokerAttestationConfigIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
  -RuntimeRoot $workDir `
  -AccountMode ([string]$bootConfig.accountMode) `
  -LiveExecutionEnabled ([bool]$bootConfig.liveExecutionEnabled) `
  -ControlApiUrl $controlApiUrl
try {
  [void](Write-Phase7CRuntimeSourceComponentAttestation `
    -RuntimeRoot $workDir `
    -Component lifecycle-broker `
    -ProcessId $PID `
    -LauncherPath $PSCommandPath `
    -ConfigIdentity $brokerAttestationConfigIdentity)
  Write-Host "PHASE7C_RUNTIME_SOURCE_ATTESTATION_LIFECYCLE_BROKER=PASS|PID=$PID"
} catch {
  Write-Warning "Lifecycle broker runtime source attestation degraded: $($_.Exception.Message)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_ATTESTATION_LIFECYCLE_BROKER=DEGRADED|PID=$PID"
}

$script:brokerState = "BOOTING"
$script:desiredExecutorState = "STOPPED"
$script:supervisorPid = $null
$script:inFlightRequestId = $null
$script:inFlightAction = $null
$script:lastHandledRequestId = $null
$script:lastHandledAction = $null
$script:lastResult = $null
$script:lastReasonCode = $null
$script:stateReasonCode = $null
$script:lastError = $null
$script:appliedLotProfile = $null
$script:accountMode = [string]$bootConfig.accountMode
$script:nextRecoveryAt = 0L

function Append-BrokerLog([string]$Message) {
  $stamp = [DateTimeOffset]::Now.ToString("o")
  Add-Content -LiteralPath $brokerLogPath -Value "[$stamp] $Message" -Encoding utf8
}

function Read-DurableDesiredExecutorState {
  if (-not (Test-Path -LiteralPath $desiredExecutorStatePath)) { return "STOPPED" }
  try {
    $state = Get-Content -LiteralPath $desiredExecutorStatePath -Raw | ConvertFrom-Json
    if ([int]$state.version -ne 1) { throw "desired executor state version must be 1." }
    $desired = ([string]$state.desiredExecutorState).Trim().ToUpperInvariant()
    if ($desired -notin @("RUNNING", "STOPPED")) { throw "desired executor state must be RUNNING or STOPPED." }
    return $desired
  } catch {
    Append-BrokerLog "Durable desired executor state invalid; fail closed to STOPPED. $($_.Exception.Message)"
    return "STOPPED"
  }
}

function Write-DurableDesiredExecutorState([string]$State) {
  $normalized = ([string]$State).Trim().ToUpperInvariant()
  if ($normalized -notin @("RUNNING", "STOPPED")) {
    throw "Durable desired executor state must be RUNNING or STOPPED."
  }
  try {
    Write-Phase7CJsonAtomic -Path $desiredExecutorStatePath -Value ([pscustomobject]@{
      version = 1
      desiredExecutorState = $normalized
      updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }) -Depth 4
  } catch {
    # Never leave a stale RUNNING intent after a failed persistence attempt.
    Remove-Item -LiteralPath $desiredExecutorStatePath -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Write-BrokerHeartbeat {
  Write-Phase7CJsonAtomic -Path $heartbeatPath -Value ([pscustomobject]@{
    version = 1
    brokerPid = $PID
    state = $script:brokerState
    desiredExecutorState = $script:desiredExecutorState
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }) -Depth 4
}

function Write-BrokerStatus {
  Write-Phase7CJsonAtomic -Path $statusPath -Value ([pscustomobject]@{
    version = 1
    state = $script:brokerState
    stateReasonCode = $script:stateReasonCode
    brokerPid = $PID
    supervisorPid = $script:supervisorPid
    desiredExecutorState = $script:desiredExecutorState
    accountMode = $script:accountMode
    inFlightRequestId = $script:inFlightRequestId
    inFlightAction = $script:inFlightAction
    lastHandledRequestId = $script:lastHandledRequestId
    lastHandledAction = $script:lastHandledAction
    lastResult = $script:lastResult
    lastReasonCode = $script:lastReasonCode
    lastError = $script:lastError
    appliedLotProfile = $script:appliedLotProfile
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }) -Depth 6
}
function Set-BrokerState([string]$State, [string]$ReasonCode = $null, [string]$ErrorMessage = $null) {
  $script:brokerState = $State
  $script:stateReasonCode = $ReasonCode
  $script:lastError = $ErrorMessage
  Write-BrokerStatus
  Write-BrokerHeartbeat
}

function Ensure-Phase7CBotPause([string]$Source) {
  try {
    $body = @{ mode = "PAUSE"; source = $Source } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Uri "$controlApiUrl/api/v1/phase7c/bot-mode" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 4
    if (([string]$response.state.mode).Trim().ToUpperInvariant() -ne "PAUSE") {
      throw "Canonical bot-mode API did not confirm PAUSE."
    }
    return $true
  } catch {
    Append-BrokerLog "PAUSE enforcement unavailable: $($_.Exception.Message)"
    return $false
  }
}

function Test-Phase7CDurableLiveAuthorization($Config, $Mt5Status) {
  if ([string]$Config.accountMode -ne "LIVE") { return $true }
  if (-not [bool]$Config.liveExecutionEnabled) { return $false }
  try {
    $identity = Get-Phase7CLiveProfileIdentity ([string]$Config.envFile)
    $authorizationPath = Get-Phase7CLiveAuthorizationPath ([string]$Config.workDir)
    if (-not (Test-Path -LiteralPath $authorizationPath)) { return $false }
    $authorization = Get-Content -LiteralPath $authorizationPath -Raw | ConvertFrom-Json
    if ([int]$authorization.version -ne 1 -or [bool]$authorization.authorized -ne $true -or ([string]$authorization.accountMode).Trim().ToUpperInvariant() -ne "LIVE") { return $false }
    if ([long]$authorization.accountLogin -ne [long]$identity.login) { return $false }
    if (-not [string]::Equals(([string]$authorization.server).Trim(), ([string]$identity.server).Trim(), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (([string]$authorization.profileFingerprint).Trim().ToLowerInvariant() -ne ([string]$identity.profileFingerprint).Trim().ToLowerInvariant()) { return $false }
    if ([long]$Mt5Status.accountLogin -ne [long]$identity.login) { return $false }
    if (-not [string]::Equals(([string]$Mt5Status.health.server).Trim(), ([string]$identity.server).Trim(), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $true
  } catch {
    Append-BrokerLog "LIVE durable authorization validation failed: $($_.Exception.Message)"
    return $false
  }
}

function Get-BrokerSafetyContext($Config) {
  try {
    $lifecycle = Invoke-RestMethod -Uri "$($Config.controlApiUrl)/api/v1/phase7c/lifecycle" -Method Get -TimeoutSec 5
    $mt5 = Invoke-RestMethod -Uri "$($Config.controlApiUrl)/api/v1/mt5/status?symbol=XAUUSD" -Method Get -TimeoutSec 5
    $mode = ([string]$lifecycle.mode.mode).Trim().ToUpperInvariant()
    $accountMode = ([string]$lifecycle.accountMode.accountMode).Trim().ToUpperInvariant()
    $positionsKnown = $null -ne $lifecycle.bridge.openXauusdPositions
    $openPositions = if ($positionsKnown) { [int]$lifecycle.bridge.openXauusdPositions } else { -1 }
    return [pscustomobject]@{
      accountMode = $accountMode
      accountValid = [bool]$lifecycle.accountMode.valid
      accountModeMatchesConfigured = [bool]$lifecycle.bridge.accountModeMatchesConfigured -and $accountMode -eq ([string]$Config.accountMode).Trim().ToUpperInvariant()
      botMode = $mode
      bridgeReachable = [bool]$lifecycle.bridge.reachable -and [bool]$mt5.reachable
      tradingEnabled = [bool]$lifecycle.bridge.tradingEnabled
      terminalTradeAllowed = [bool]$lifecycle.bridge.terminalTradeAllowed
      expertTradeAllowed = [bool]$lifecycle.bridge.expertTradeAllowed
      positionsKnown = $positionsKnown
      openXauusdPositions = $openPositions
      telegramConfigured = [bool]$lifecycle.telegramConfigured
      taskConfigValid = $true
      liveExecutionEnabled = [bool]$Config.liveExecutionEnabled
      liveAuthorizationValid = Test-Phase7CDurableLiveAuthorization -Config $Config -Mt5Status $mt5
      sessionArmValid = [bool]$lifecycle.bridge.liveExecutionArmed
    }
  } catch {
    Append-BrokerLog "Safety probe failed: $($_.Exception.Message)"
    return [pscustomobject]@{
      accountMode = [string]$Config.accountMode
      accountValid = $false
      accountModeMatchesConfigured = $false
      botMode = "UNKNOWN"
      bridgeReachable = $false
      tradingEnabled = $false
      terminalTradeAllowed = $false
      expertTradeAllowed = $false
      positionsKnown = $false
      openXauusdPositions = -1
      telegramConfigured = $false
      taskConfigValid = $true
      liveExecutionEnabled = [bool]$Config.liveExecutionEnabled
      liveAuthorizationValid = $false
      sessionArmValid = $false
    }
  }
}

function Test-SupervisorAlive {
  if ($null -eq $script:supervisorPid) { return $false }
  return $null -ne (Get-Process -Id ([int]$script:supervisorPid) -ErrorAction SilentlyContinue)
}

function Get-Phase7CExistingSupervisorPid {
  $supervisorPidPath = Join-Path $runtimeDir "supervisor.pid"
  if (-not (Test-Path -LiteralPath $supervisorPidPath -PathType Leaf)) { return $null }
  try {
    $candidatePid = [int](Get-Content -LiteralPath $supervisorPidPath -Raw).Trim()
    if ($candidatePid -le 0) { return $null }
    $liveProcess = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
    if ($null -eq $liveProcess) { return $null }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $candidatePid" -ErrorAction Stop
    if ($null -eq $processInfo) { return $null }
    $processName = ([string]$processInfo.Name).Trim().ToLowerInvariant()
    if ($processName -notin @("powershell.exe", "pwsh.exe")) { return $null }
    $canonicalSupervisorLeaf = "run-phase7c-executors-local.ps1"
    if (-not [string]::Equals([System.IO.Path]::GetFileName($Supervisor), $canonicalSupervisorLeaf, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    $commandLine = [string]$processInfo.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return $null }
    $canonicalSupervisorPath = [System.IO.Path]::GetFullPath($Supervisor).Replace('/', '\')
    $normalizedCommandLine = $commandLine.Replace('/', '\')
    if ($normalizedCommandLine.IndexOf($canonicalSupervisorPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    return $candidatePid
  } catch {
    Append-BrokerLog "Existing supervisor adoption probe failed; refusing unproven PID. $($_.Exception.Message)"
    return $null
  }
}

function Stop-Phase7CExecutorRuntime($Config) {
  # Missing PID files are not proof that the executor runtime is gone.
  # The canonical stopper is idempotent and also reconciles bounded orphan
  # wrapper processes by exact canonical script path.
  if (-not (Test-SupervisorAlive)) {
    $script:supervisorPid = $null
  }

  $stopArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $Stopper),
    "-WorkDir", ('"{0}"' -f $Config.workDir)
  )
  $stopProcess = Start-Process -FilePath "powershell.exe" -ArgumentList $stopArgs -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden
  if (-not $stopProcess.WaitForExit(25000)) {
    try { $stopProcess.Kill() } catch {}
    return [pscustomobject]@{ success = $false; reasonCode = "FAIL_STOP_TIMEOUT"; message = "Executor stop exceeded 25 seconds." }
  }
  if ($stopProcess.ExitCode -ne 0) {
    return [pscustomobject]@{ success = $false; reasonCode = "FAIL_INTERNAL"; message = "Executor stopper failed with exit code $($stopProcess.ExitCode)." }
  }
  $script:supervisorPid = $null
  $script:appliedLotProfile = $null
  return [pscustomobject]@{ success = $true; reasonCode = "OK_STOPPED"; message = "Executor runtime stopped." }
}

function Set-Phase7CProcessEnvironment($Config) {
  $nodeDir = Split-Path -Parent ([string]$Config.nodePath)
  $pnpmDir = Split-Path -Parent ([string]$Config.pnpmPath)
  $currentPathParts = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $prepend = @($pnpmDir, $nodeDir) | Select-Object -Unique
  $remaining = @($currentPathParts | Where-Object { $prepend -notcontains $_ })
  $env:PATH = (@($prepend) + @($remaining)) -join ';'
  $env:PHASE7C_NODE_PATH = [string]$Config.nodePath
  $env:PHASE7C_PNPM_PATH = [string]$Config.pnpmPath
}

function New-Phase7CAttemptLogDirectory {
  New-Item -ItemType Directory -Force -Path $attemptsRoot | Out-Null
  $attemptId = "{0}-{1}" -f ([DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")), ([Guid]::NewGuid().ToString("N"))
  $attemptDir = Join-Path $attemptsRoot $attemptId
  [void](New-Item -ItemType Directory -Path $attemptDir -ErrorAction Stop)
  return (Resolve-Path -LiteralPath $attemptDir).Path
}

function Start-Phase7CExecutorRuntime($Config) {
  Set-Phase7CProcessEnvironment $Config
  $attemptLogDir = New-Phase7CAttemptLogDirectory
  $supervisorOut = Join-Path $attemptLogDir "startup-supervisor.out.log"
  $supervisorErr = Join-Path $attemptLogDir "startup-supervisor.err.log"
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $Supervisor),
    "-WorkDir", ('"{0}"' -f $Config.workDir),
    "-AttemptLogDir", ('"{0}"' -f $attemptLogDir),
    "-ControlApiUrl", ('"{0}"' -f $Config.controlApiUrl),
    "-EnvFile", ('"{0}"' -f $Config.envFile),
    "-TelegramEnvFile", ('"{0}"' -f $Config.telegramEnvFile),
    "-AccountMode", ([string]$Config.accountMode),
    "-TrendFixedVolume", ([double]$Config.trendFixedVolume).ToString([System.Globalization.CultureInfo]::InvariantCulture),
    "-SidewayRiskPercent", ([double]$Config.sidewayRiskPercent).ToString([System.Globalization.CultureInfo]::InvariantCulture),
    "-SidewayMaxLot", ([double]$Config.sidewayMaxLot).ToString([System.Globalization.CultureInfo]::InvariantCulture),
    "-Armed"
  )
  if ([string]$Config.accountMode -eq "LIVE" -and [bool]$Config.liveExecutionEnabled) { $arguments += "-LiveExecutionEnabled" }

  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $supervisorOut `
    -RedirectStandardError $supervisorErr `
    -PassThru
  Start-Sleep -Milliseconds 750
  $process.Refresh()
  if ($process.HasExited) {
    return [pscustomobject]@{ success = $false; reasonCode = "FAIL_SUPERVISOR_EXITED"; message = "Supervisor exited during launch acknowledgement."; pid = $process.Id }
  }

  $script:supervisorPid = [int]$process.Id
  $script:accountMode = [string]$Config.accountMode
  $script:appliedLotProfile = [pscustomobject]@{
    trendFixedLot = [double]$Config.trendFixedVolume
    sidewayRiskPercent = [double]$Config.sidewayRiskPercent
    sidewayMaxLot = [double]$Config.sidewayMaxLot
  }
  return [pscustomobject]@{ success = $true; reasonCode = "OK_STARTED"; message = "Executor supervisor launched."; pid = $process.Id }
}

function Write-BrokerResult(
  [string]$RequestId,
  [string]$Action,
  [string]$Status,
  [string]$ReasonCode,
  [string]$Message,
  [long]$StartedAt
) {
  $resultPath = Join-Path $resultsDir "$RequestId.json"
  if (Test-Path -LiteralPath $resultPath) { return $resultPath }
  Write-Phase7CJsonAtomic -Path $resultPath -Value ([pscustomobject]@{
    version = 1
    requestId = $RequestId
    action = $Action
    status = $Status
    reasonCode = $ReasonCode
    message = $Message
    startedAt = $StartedAt
    completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    supervisorPid = $script:supervisorPid
    accountMode = $script:accountMode
    appliedLotProfile = $script:appliedLotProfile
  }) -Depth 6
  return $resultPath
}

function Trim-BrokerResults {
  try {
    $files = @(Get-ChildItem -LiteralPath $resultsDir -File -Filter "*.json" | Sort-Object LastWriteTimeUtc -Descending)
    if ($files.Count -le 128) { return }
    foreach ($old in @($files | Select-Object -Skip 128)) {
      Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Append-BrokerLog "Result retention cleanup failed: $($_.Exception.Message)"
  }
}

function Complete-Request([string]$RequestId, [string]$Action, [string]$ResultStatus, [string]$ReasonCode, [string]$Message, [long]$StartedAt) {
  [void](Write-BrokerResult -RequestId $RequestId -Action $Action -Status $ResultStatus -ReasonCode $ReasonCode -Message $Message -StartedAt $StartedAt)
  $script:lastHandledRequestId = $RequestId
  $script:lastHandledAction = $Action
  $script:lastResult = $ResultStatus
  $script:lastReasonCode = $ReasonCode
  $script:inFlightRequestId = $null
  $script:inFlightAction = $null
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  Trim-BrokerResults
  Write-BrokerStatus
  Write-BrokerHeartbeat
}

function Process-BrokerRequest {
  if (-not (Test-Path -LiteralPath $requestPath)) { return }
  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $request = $null
  try {
    $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
  } catch {
    Append-BrokerLog "REJECT_REQUEST_INVALID: malformed JSON. $($_.Exception.Message)"
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    $script:lastReasonCode = "REJECT_REQUEST_INVALID"
    Set-BrokerState "BLOCKED" "REJECT_REQUEST_INVALID" "Malformed lifecycle request JSON."
    return
  }

  $validation = Test-Phase7CLifecycleBrokerRequest -Request $request
  $requestId = [string]$request.requestId
  $action = ([string]$request.action).Trim().ToUpperInvariant()
  if (-not $validation.valid) {
    if (-not [Guid]::TryParse($requestId, [ref]([Guid]$guid = [Guid]::Empty))) {
      Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
      Set-BrokerState "BLOCKED" ([string]$validation.reasonCode) ([string]$validation.message)
      return
    }
    Complete-Request $requestId $(if ($action -in @("START", "STOP", "RESTART")) { $action } else { "START" }) "REJECTED" ([string]$validation.reasonCode) ([string]$validation.message) $startedAt
    return
  }

  $resultPath = Join-Path $resultsDir "$requestId.json"
  $disposition = Get-Phase7CLifecycleBrokerRequestDisposition -RequestId $requestId -ActiveRequestId $script:inFlightRequestId -ExistingResult (Test-Path -LiteralPath $resultPath)
  if ($disposition -eq "REJECT_REQUEST_DUPLICATE") {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    $script:lastHandledRequestId = $requestId
    $script:lastHandledAction = $action
    $script:lastResult = "NOOP"
    $script:lastReasonCode = "REJECT_REQUEST_DUPLICATE"
    Write-BrokerStatus
    return
  }
  if ($disposition -eq "REJECT_BROKER_BUSY") {
    Complete-Request $requestId $action "REJECTED" "REJECT_BROKER_BUSY" "Lifecycle broker already has an in-flight request." $startedAt
    return
  }

  $script:inFlightRequestId = $requestId
  $script:inFlightAction = $action
  Write-BrokerStatus

  $config = $null
  try {
    $config = Read-Phase7CCanonicalLaunchConfig
    $script:accountMode = [string]$config.accountMode
  } catch {
    Complete-Request $requestId $action "REJECTED" "REJECT_ACCOUNT_INVALID" "Canonical launch configuration is invalid. $($_.Exception.Message)" $startedAt
    Set-BrokerState "BLOCKED" "REJECT_ACCOUNT_INVALID" $_.Exception.Message
    return
  }

  $context = Get-BrokerSafetyContext $config
  $gate = Test-Phase7CLifecycleBrokerSafetyGate -Action $action -Context $context
  if (-not $gate.allowed) {
    Complete-Request $requestId $action "REJECTED" ([string]$gate.reasonCode) ([string]$gate.message) $startedAt
    Set-BrokerState "BLOCKED" ([string]$gate.reasonCode) ([string]$gate.message)
    return
  }

  try {
    if ($action -eq "STOP") {
      Set-BrokerState "STOPPING"
      $stopResult = Stop-Phase7CExecutorRuntime $config
      if (-not $stopResult.success) {
        Complete-Request $requestId $action "FAILED" ([string]$stopResult.reasonCode) ([string]$stopResult.message) $startedAt
        Set-BrokerState "BLOCKED" ([string]$stopResult.reasonCode) ([string]$stopResult.message)
        return
      }
      Write-DurableDesiredExecutorState "STOPPED"
      $script:desiredExecutorState = "STOPPED"
      $status = if ($stopResult.reasonCode -eq "NOOP_ALREADY_STOPPED") { "NOOP" } else { "SUCCEEDED" }
      Complete-Request $requestId $action $status ([string]$stopResult.reasonCode) ([string]$stopResult.message) $startedAt
      Set-BrokerState "IDLE" ([string]$stopResult.reasonCode)
      return
    }

    if ($action -eq "START" -and (Test-SupervisorAlive)) {
      Write-DurableDesiredExecutorState "RUNNING"
      $script:desiredExecutorState = "RUNNING"
      Complete-Request $requestId $action "NOOP" "NOOP_ALREADY_RUNNING" "Executor supervisor is already running." $startedAt
      Set-BrokerState "RUNNING" "NOOP_ALREADY_RUNNING"
      return
    }

    if ($action -eq "START") {
      # A fresh lifecycle-broker generation has no in-memory supervisor PID, but
      # canonical wrapper processes from the previous generation can still be alive
      # after PID-file cleanup. Reconcile exact-path orphans before any new launch.
      $preStartReconcile = Stop-Phase7CExecutorRuntime $config
      if (-not $preStartReconcile.success) {
        $script:desiredExecutorState = "STOPPED"
        Complete-Request $requestId $action "FAILED" ([string]$preStartReconcile.reasonCode) ([string]$preStartReconcile.message) $startedAt
        Set-BrokerState "BLOCKED" ([string]$preStartReconcile.reasonCode) ([string]$preStartReconcile.message)
        return
      }

      # Re-read launch config and re-run the START safety gate after reconciliation
      # so account/MT5/trading state changes during cleanup fail closed.
      $config = Read-Phase7CCanonicalLaunchConfig
      $script:accountMode = [string]$config.accountMode
      $postReconcileContext = Get-BrokerSafetyContext $config
      $postReconcileGate = Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $postReconcileContext
      if (-not $postReconcileGate.allowed) {
        $script:desiredExecutorState = "STOPPED"
        Complete-Request $requestId $action "REJECTED" ([string]$postReconcileGate.reasonCode) ([string]$postReconcileGate.message) $startedAt
        Set-BrokerState "BLOCKED" ([string]$postReconcileGate.reasonCode) ([string]$postReconcileGate.message)
        return
      }
    }

    if ($action -eq "RESTART") {
      Set-BrokerState "RESTARTING"
      $stopResult = Stop-Phase7CExecutorRuntime $config
      if (-not $stopResult.success) {
        Complete-Request $requestId $action "FAILED" ([string]$stopResult.reasonCode) ([string]$stopResult.message) $startedAt
        Set-BrokerState "BLOCKED" ([string]$stopResult.reasonCode) ([string]$stopResult.message)
        return
      }
      # Critical: re-read task/account/lot configuration after stop and before launch.
      $config = Read-Phase7CCanonicalLaunchConfig
      $script:accountMode = [string]$config.accountMode
      $postStopContext = Get-BrokerSafetyContext $config
      $postStopGate = Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $postStopContext
      if (-not $postStopGate.allowed) {
        $script:desiredExecutorState = "STOPPED"
        Complete-Request $requestId $action "REJECTED" ([string]$postStopGate.reasonCode) ([string]$postStopGate.message) $startedAt
        Set-BrokerState "BLOCKED" ([string]$postStopGate.reasonCode) ([string]$postStopGate.message)
        return
      }
    } else {
      Set-BrokerState "STARTING"
    }

    $startResult = Start-Phase7CExecutorRuntime $config
    if (-not $startResult.success) {
      $script:desiredExecutorState = "STOPPED"
      Complete-Request $requestId $action "FAILED" ([string]$startResult.reasonCode) ([string]$startResult.message) $startedAt
      Set-BrokerState "BLOCKED" ([string]$startResult.reasonCode) ([string]$startResult.message)
      return
    }

    Write-DurableDesiredExecutorState "RUNNING"
    $script:desiredExecutorState = "RUNNING"
    $reasonCode = if ($action -eq "RESTART") { "OK_RESTARTED" } else { "OK_STARTED" }
    Complete-Request $requestId $action "SUCCEEDED" $reasonCode ([string]$startResult.message) $startedAt
    Set-BrokerState "RUNNING" $reasonCode
  } catch {
    $script:desiredExecutorState = "STOPPED"
    Complete-Request $requestId $action "FAILED" "FAIL_INTERNAL" $_.Exception.Message $startedAt
    Set-BrokerState "BLOCKED" "FAIL_INTERNAL" $_.Exception.Message
  }
}

function Recover-SupervisorIfNeeded {
  if ($script:desiredExecutorState -ne "RUNNING") { return }
  if (Test-SupervisorAlive) { return }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($script:nextRecoveryAt -ne 0L -and $now -lt $script:nextRecoveryAt) { return }

  if (-not (Ensure-Phase7CBotPause "system-lifecycle-broker-recovery")) {
    $script:nextRecoveryAt = $now + ([long]$RestartDelaySeconds * 1000L)
    Set-BrokerState "BLOCKED" "REJECT_BOT_NOT_PAUSED" "Cannot confirm PAUSE during supervisor recovery."
    return
  }

  $existingSupervisorPid = Get-Phase7CExistingSupervisorPid
  if ($null -ne $existingSupervisorPid) {
    $script:supervisorPid = [int]$existingSupervisorPid
    $script:nextRecoveryAt = 0L
    Append-BrokerLog "Adopted surviving canonical executor supervisor PID=$existingSupervisorPid after lifecycle broker cold-start."
    Set-BrokerState "RUNNING" "NOOP_ALREADY_RUNNING"
    return
  }

  if ($script:nextRecoveryAt -eq 0L) {
    $script:nextRecoveryAt = $now + ([long]$RestartDelaySeconds * 1000L)
    Set-BrokerState "ERROR_RETRYING" "FAIL_SUPERVISOR_EXITED" "Supervisor exited unexpectedly; recovery is PAUSE-only."
    return
  }

  try {
    $config = Read-Phase7CCanonicalLaunchConfig
    $context = Get-BrokerSafetyContext $config
    $gate = Test-Phase7CLifecycleBrokerSafetyGate -Action "START" -Context $context
    if (-not $gate.allowed) {
      $script:nextRecoveryAt = $now + ([long]$RestartDelaySeconds * 1000L)
      Set-BrokerState "BLOCKED" ([string]$gate.reasonCode) ([string]$gate.message)
      return
    }
    $startResult = Start-Phase7CExecutorRuntime $config
    if (-not $startResult.success) {
      $script:nextRecoveryAt = $now + ([long]$RestartDelaySeconds * 1000L)
      Set-BrokerState "ERROR_RETRYING" ([string]$startResult.reasonCode) ([string]$startResult.message)
      return
    }
    $script:nextRecoveryAt = 0L
    Set-BrokerState "RUNNING" "OK_STARTED"
  } catch {
    $script:nextRecoveryAt = $now + ([long]$RestartDelaySeconds * 1000L)
    Set-BrokerState "ERROR_RETRYING" "FAIL_INTERNAL" $_.Exception.Message
  }
}

Write-Host "PHASE7C_EXECUTOR_TASK_RUNNER=LIFECYCLE_BROKER"
Write-Host "PHASE7C_LIFECYCLE_BROKER_ROOT=$brokerRoot"
Write-Host "PHASE7C_LIFECYCLE_BROKER_PID=$PID"
[void](Ensure-Phase7CBotPause "system-lifecycle-broker-boot")
$script:desiredExecutorState = Read-DurableDesiredExecutorState
Write-Host "PHASE7C_LIFECYCLE_BROKER_BOOT=IDLE|DESIRED=$($script:desiredExecutorState)|MODE=PAUSE"
Append-BrokerLog "Lifecycle broker starting. PID=$PID desiredExecutorState=$($script:desiredExecutorState)"
$script:brokerState = "IDLE"
Write-BrokerStatus
Write-BrokerHeartbeat

try {
  while ($true) {
    Write-BrokerHeartbeat
    Process-BrokerRequest
    Recover-SupervisorIfNeeded
    Start-Sleep -Milliseconds 500
  }
} finally {
  if ($null -ne $runnerLock) { $runnerLock.Dispose() }
}