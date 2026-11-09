$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourceRunner = Join-Path $PSScriptRoot 'run-phase7c-executor-task-runner-local.ps1'
$sourceStopper = Join-Path $PSScriptRoot 'stop-phase7c-executors-local.ps1'
$sourceGuard = Join-Path $PSScriptRoot 'lib\phase7c-startup-runner-guard.ps1'
$sourceAccount = Join-Path $PSScriptRoot 'lib\phase7c-account-mode.ps1'
$sourceBroker = Join-Path $PSScriptRoot 'lib\phase7c-lifecycle-broker.ps1'
$sourceAttestation = Join-Path $PSScriptRoot 'lib\phase7c-runtime-source-attestation.ps1'
$ownershipLibrary = Join-Path $PSScriptRoot 'lib\phase7c-scheduled-task-ownership.ps1'
foreach ($required in @($sourceRunner, $sourceStopper, $sourceGuard, $sourceAccount, $sourceBroker, $sourceAttestation, $ownershipLibrary)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required production source missing: $required" }
}
. $ownershipLibrary

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Full broker SYSTEM Scheduled Task test requires Administrator.'
}
Import-Module ScheduledTasks -ErrorAction Stop

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Wait-File([string]$Path, [int]$TimeoutSeconds = 15) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not (Test-Path -LiteralPath $Path)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for file: $Path" }
    Start-Sleep -Milliseconds 50
  }
}

function Write-RequestAtomic([string]$Path, [string]$Action, [string]$Reason) {
  $requestId = [Guid]::NewGuid().ToString()
  $value = [pscustomobject]@{
    version = 1
    requestId = $requestId
    action = $Action
    requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    source = 'LOCAL_LIFECYCLE_API'
    reason = $Reason
  }
  $temp = "$Path.$requestId.tmp"
  [System.IO.File]::WriteAllText($temp, (($value | ConvertTo-Json -Compress) + "`n"), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
  return $requestId
}

function Wait-Result([string]$ResultsDir, [string]$RequestId, [int]$TimeoutSeconds = 20) {
  $path = Join-Path $ResultsDir "$RequestId.json"
  Wait-File $path $TimeoutSeconds
  return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
}

function Wait-BrokerStatusConvergence(
  [string]$Path,
  [string]$RequestId,
  [string]$ExpectedState,
  [string]$ExpectedResult,
  [int]$TimeoutSeconds = 10
) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastState = '<missing>'
  $lastRequestId = '<missing>'
  $lastResult = '<missing>'
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      try {
        $status = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $lastState = [string]$status.state
        $lastRequestId = [string]$status.lastHandledRequestId
        $lastResult = [string]$status.lastResult
        if ($lastRequestId -eq $RequestId -and $lastState -eq $ExpectedState -and $lastResult -eq $ExpectedResult) {
          return $status
        }
      } catch {
        $lastState = '<unreadable>'
      }
    }
    Start-Sleep -Milliseconds 25
  }
  throw "Timed out waiting for broker status convergence. request=$RequestId expectedState=$ExpectedState expectedResult=$ExpectedResult lastRequest=$lastRequestId lastState=$lastState lastResult=$lastResult"
}

$token = [Guid]::NewGuid().ToString('N')
$tempProject = Join-Path $env:ProgramData "phase7c-full-broker-lock-$token"
$tempScripts = Join-Path $tempProject 'scripts'
$tempLib = Join-Path $tempScripts 'lib'
$workDir = Join-Path $tempProject '.runtime'
$runtimeDir = Join-Path $workDir 'phase7c-executors'
$brokerRoot = Join-Path $workDir 'phase7c-lifecycle-broker'
$inboxDir = Join-Path $brokerRoot 'inbox'
$stateDir = Join-Path $brokerRoot 'state'
$resultsDir = Join-Path $brokerRoot 'results'
$lockPath = Join-Path $runtimeDir 'startup-runner.lock'
$heartbeatPath = Join-Path $stateDir 'heartbeat.json'
$statusPath = Join-Path $stateDir 'status.json'
$requestPath = Join-Path $inboxDir 'request.json'
$configPath = Join-Path $workDir 'phase7c-executor-task-config.json'
$envPath = Join-Path $tempProject 'demo.env'
$telegramEnvPath = Join-Path $tempProject 'telegram.env'
$serverScript = Join-Path $tempProject 'fake-api.ps1'
$serverReady = Join-Path $tempProject 'fake-api.ready'
$serverOut = Join-Path $tempProject 'fake-api.out.log'
$serverErr = Join-Path $tempProject 'fake-api.err.log'
$runnerOut = Join-Path $tempProject 'runner.out.log'
$runnerErr = Join-Path $tempProject 'runner.err.log'
$taskName = "Phase7C-CI-FullBroker-$token"
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$apiPort = Get-FreeTcpPort
$apiBase = "http://127.0.0.1:$apiPort"
$serverProcess = $null
$registered = $false
$supervisorPid = 0

try {
  New-Item -ItemType Directory -Force -Path $tempLib, $workDir | Out-Null
  Copy-Item -LiteralPath $sourceRunner -Destination (Join-Path $tempScripts 'run-phase7c-executor-task-runner-local.ps1') -Force
  Copy-Item -LiteralPath $sourceStopper -Destination (Join-Path $tempScripts 'stop-phase7c-executors-local.ps1') -Force
  Copy-Item -LiteralPath $sourceGuard -Destination (Join-Path $tempLib 'phase7c-startup-runner-guard.ps1') -Force
  Copy-Item -LiteralPath $sourceAccount -Destination (Join-Path $tempLib 'phase7c-account-mode.ps1') -Force
  Copy-Item -LiteralPath $sourceBroker -Destination (Join-Path $tempLib 'phase7c-lifecycle-broker.ps1') -Force
  Copy-Item -LiteralPath $sourceAttestation -Destination (Join-Path $tempLib 'phase7c-runtime-source-attestation.ps1') -Force

  $stubSupervisor = @'
param(
  [Parameter(Mandatory = $true)] [string]$WorkDir,
  [Parameter(Mandatory = $true)] [string]$ControlApiUrl,
  [Parameter(Mandatory = $true)] [string]$EnvFile,
  [Parameter(Mandatory = $true)] [string]$TelegramEnvFile,
  [string]$AttemptLogDir = '',
  [Parameter(Mandatory = $true)] [string]$AccountMode,
  [double]$TrendFixedVolume,
  [double]$SidewayRiskPercent,
  [double]$SidewayMaxLot,
  [switch]$Armed,
  [switch]$LiveExecutionEnabled
)
$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $WorkDir 'phase7c-executors'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $runtimeDir 'supervisor.pid'), "$PID`r`n")
while ($true) { Start-Sleep -Milliseconds 250 }
'@
  [System.IO.File]::WriteAllText((Join-Path $tempScripts 'run-phase7c-executors-local.ps1'), $stubSupervisor, [System.Text.UTF8Encoding]::new($false))

  $envText = @"
MT5_API_KEY=phase7c-ci-lock-$token
MT5_BRIDGE_HOST=127.0.0.1
MT5_BRIDGE_PORT=8765
MT5_ALLOW_REAL_ACCOUNT=false
MT5_TRADING_ENABLED=true
MT5_ALLOWED_LOGINS=123456
"@
  [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($telegramEnvPath, "# ci fixture`n", [System.Text.UTF8Encoding]::new($false))

  $config = [pscustomobject]@{
    version = 1
    demoOnly = $true
    armed = $true
    workDir = $workDir
    controlApiUrl = $apiBase
    envFile = $envPath
    telegramEnvFile = $telegramEnvPath
    nodePath = $powerShellExe
    pnpmPath = $powerShellExe
    trendFixedVolume = 0.03
    sidewayRiskPercent = 0.25
    sidewayMaxLot = 0.03
  }
  [System.IO.File]::WriteAllText($configPath, (($config | ConvertTo-Json -Depth 5) + "`n"), [System.Text.UTF8Encoding]::new($false))

  $fakeApiSource = @'
param([int]$Port, [string]$ReadyPath)
$ErrorActionPreference = 'Stop'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
[System.IO.File]::WriteAllText($ReadyPath, [string]$PID)
try {
  while ($true) {
    $context = $listener.GetContext()
    try {
      $path = [string]$context.Request.Url.AbsolutePath
      $body = if ($path -eq '/api/v1/phase7c/bot-mode') {
        '{"state":{"mode":"PAUSE"}}'
      } elseif ($path -eq '/api/v1/phase7c/lifecycle') {
        '{"mode":{"mode":"PAUSE"},"accountMode":{"accountMode":"DEMO","valid":true},"bridge":{"accountModeMatchesConfigured":true,"reachable":true,"tradingEnabled":true,"terminalTradeAllowed":true,"expertTradeAllowed":true,"openXauusdPositions":0,"liveExecutionArmed":false},"telegramConfigured":true}'
      } elseif ($path -eq '/api/v1/mt5/status') {
        '{"reachable":true,"accountLogin":123456,"health":{"server":"CI"}}'
      } else {
        $context.Response.StatusCode = 404
        '{"error":"not found"}'
      }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
      $context.Response.ContentType = 'application/json'
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } finally {
      $context.Response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
'@
  [System.IO.File]::WriteAllText($serverScript, $fakeApiSource, [System.Text.UTF8Encoding]::new($false))
  $serverProcess = Start-Process -FilePath $powerShellExe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $serverScript),'-Port',$apiPort,'-ReadyPath',('"{0}"' -f $serverReady)) -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden
  Wait-File $serverReady 10

  $runnerPath = Join-Path $tempScripts 'run-phase7c-executor-task-runner-local.ps1'
  $action = New-ScheduledTaskAction -Execute $powerShellExe -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runnerPath)
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -ErrorAction Stop | Out-Null
  $registered = $true
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

  Wait-File $heartbeatPath 15
  Wait-File $lockPath 15
  $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw | ConvertFrom-Json
  $brokerPid = [int]$heartbeat.brokerPid
  if ($brokerPid -le 0 -or $null -eq (Get-Process -Id $brokerPid -ErrorAction SilentlyContinue)) {
    throw "Full broker SYSTEM runner PID is not alive. PID=$brokerPid"
  }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ([string]$task.State -ne 'Running') { throw "Full broker Scheduled Task is not Running. state=$($task.State)" }
  $initialLockState = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
  if ($initialLockState -ne 'HELD') { throw "Full broker did not hold startup lock after boot. state=$initialLockState" }

  $startId = Write-RequestAtomic -Path $requestPath -Action 'START' -Reason 'USER_START'
  $startResult = Wait-Result -ResultsDir $resultsDir -RequestId $startId -TimeoutSeconds 20
  if ([string]$startResult.status -ne 'SUCCEEDED' -or [string]$startResult.reasonCode -ne 'OK_STARTED') {
    throw "Fixture START did not succeed. status=$($startResult.status) reason=$($startResult.reasonCode) message=$($startResult.message)"
  }
  $supervisorPid = [int]$startResult.supervisorPid
  if ($supervisorPid -le 0 -or $null -eq (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
    throw "Stub supervisor is not alive after START. PID=$supervisorPid"
  }
  if ((Get-Phase7CStartupRunnerLockState -LockPath $lockPath) -ne 'HELD') {
    throw 'Full broker lost startup lock immediately after successful START.'
  }

  # Match the observed production failure safely: the broker still owns a live
  # supervisor in memory, while the stopper exits 1 because its PID file is
  # invalid. This forces STOP -> FAIL_INTERNAL without killing the stub child.
  [System.IO.File]::WriteAllText((Join-Path $runtimeDir 'supervisor.pid'), "not-a-pid`r`n", [System.Text.UTF8Encoding]::new($false))
  $stopId = Write-RequestAtomic -Path $requestPath -Action 'STOP' -Reason 'USER_STOP'
  $stopResult = Wait-Result -ResultsDir $resultsDir -RequestId $stopId -TimeoutSeconds 30
  if ([string]$stopResult.status -ne 'FAILED' -or [string]$stopResult.reasonCode -ne 'FAIL_INTERNAL') {
    throw "Fixture STOP did not reproduce FAIL_INTERNAL. status=$($stopResult.status) reason=$($stopResult.reasonCode) message=$($stopResult.message)"
  }
  if ([string]$stopResult.message -notmatch 'Executor stopper failed with exit code 1') {
    throw "Fixture STOP failure differs from production incident. message=$($stopResult.message)"
  }

  # Result creation precedes the final Set-BrokerState('BLOCKED') write. Wait for
  # the status record of this exact request to converge instead of racing it.
  $status = Wait-BrokerStatusConvergence -Path $statusPath -RequestId $stopId -ExpectedState 'BLOCKED' -ExpectedResult 'FAILED' -TimeoutSeconds 10
  if ([string]$status.state -ne 'BLOCKED' -or [string]$status.desiredExecutorState -ne 'RUNNING') {
    throw "Post-failure broker state does not match incident. state=$($status.state) desired=$($status.desiredExecutorState)"
  }
  if ([int]$status.brokerPid -ne $brokerPid -or [int]$status.supervisorPid -ne $supervisorPid) {
    throw "Broker/supervisor identity changed across failed STOP. broker=$($status.brokerPid)/$brokerPid supervisor=$($status.supervisorPid)/$supervisorPid"
  }

  $samples = 0
  for ($i = 0; $i -lt 200; $i++) {
    if ($null -eq (Get-Process -Id $brokerPid -ErrorAction SilentlyContinue)) {
      throw "Broker exited after failed STOP. sample=$i PID=$brokerPid"
    }
    if ($null -eq (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
      throw "Stub supervisor exited after failed STOP. sample=$i PID=$supervisorPid"
    }
    $lockState = Get-Phase7CStartupRunnerLockState -LockPath $lockPath
    if ($lockState -ne 'HELD') {
      throw "Exact broker STOP-failure path lost startup-runner lock. sample=$i brokerPid=$brokerPid supervisorPid=$supervisorPid state=$lockState"
    }
    $samples++
    Start-Sleep -Milliseconds 25
  }

  Write-Host 'PHASE7C_STARTUP_RUNNER_LOCK_BROKER_STOP_FAILURE_TEST=PASS'
  Write-Host "BROKER_PID=$brokerPid"
  Write-Host "SUPERVISOR_PID=$supervisorPid"
  Write-Host 'BROKER_STATE=BLOCKED'
  Write-Host 'DESIRED_EXECUTOR_STATE=RUNNING'
  Write-Host 'LAST_STOP_RESULT=FAILED|FAIL_INTERNAL|EXECUTOR_STOPPER_EXIT_1'
  Write-Host "POST_FAILURE_HELD_SAMPLES=$samples"
  Write-Host 'POST_FAILURE_LOCK_STATE=HELD'
} finally {
  if ($registered) {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
  if ($supervisorPid -gt 0) {
    try { Stop-Process -Id $supervisorPid -Force -ErrorAction SilentlyContinue } catch { }
  }
  if ($null -ne $serverProcess) {
    try {
      $serverProcess.Refresh()
      if (-not $serverProcess.HasExited) { $serverProcess.Kill() }
    } catch { }
  }
  Remove-Item -LiteralPath $tempProject -Recurse -Force -ErrorAction SilentlyContinue
}