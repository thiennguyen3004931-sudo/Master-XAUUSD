# Manual-only, exactly one Web Scheduled Task START. Never send broker mutations.
param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [string]$ExpectedSource = '196a8420ff008548773f5d385cf5785a9f84e297',
  [string]$OperatorConfirmation = '',
  [int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($OperatorConfirmation -cne 'START_WEB_TASK_ONLY_PAUSE_DISARMED') { throw 'OPERATOR_WEB_TASK_START_CONFIRMATION_REQUIRED' }
if ($ExpectedSource -notmatch '^[0-9a-f]{40}$') { throw 'TARGET_COMMIT_INVALID' }
if ($TimeoutSeconds -lt 45 -or $TimeoutSeconds -gt 180) { throw 'TIMEOUT_OUT_OF_RANGE' }
$taskName = 'XAUUSD-Phase7B-Web'
$precheckPath = Join-Path $PSScriptRoot 'check-phase7c-web-recovery-eligibility-readonly.ps1'
$expectedLauncher = Join-Path $ProductionRoot 'scripts\run-phase7b-web-autostart.ps1'
$started = $false
function Assert-OnlyCanonicalAction {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ([string]$task.State -ne 'Ready') { throw "WEB_TASK_STATE_NOT_READY=$($task.State)" }
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { throw 'WEB_TASK_ACTION_COUNT_NOT_ONE' }
  $action = $actions[0]
  $exe = [string]$action.Execute
  $args = [string]$action.Arguments
  $exeNormalized = $exe.Trim('"')
  $trustedPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if ($exeNormalized -ieq 'powershell.exe') {
    $exeNormalized = [string](Get-Command powershell.exe -ErrorAction Stop).Source
  }
  if ($exeNormalized -ine $trustedPowerShell) { throw 'WEB_TASK_EXECUTABLE_NOT_TRUSTED_SYSTEM_POWERSHELL' }
  if ($args -match '(?i)(?:-encodedcommand|-command\s|invoke-expression|iex\s)') { throw 'WEB_TASK_ACTION_UNTRUSTED_COMMAND' }
  $fileSwitchPattern = '(?i)(?:^|\s)-File\s+["'']?' + [regex]::Escape($expectedLauncher) + '["'']?(?=\s|$)'
  if ($args -notmatch $fileSwitchPattern) { throw 'WEB_TASK_LAUNCHER_PATH_NOT_CANONICAL' }
  if ($args.IndexOf('-WorkDir', [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'WEB_TASK_WORKDIR_MISSING' }
  if (-not (Test-Path -LiteralPath $expectedLauncher -PathType Leaf)) { throw 'WEB_TASK_LAUNCHER_NOT_FOUND' }
  $expectedBlob = (& git -C $ProductionRoot rev-parse "$($ExpectedSource):scripts/run-phase7b-web-autostart.ps1").Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $expectedBlob -notmatch '^[a-f0-9]{40}$') { throw 'WEB_TASK_LAUNCHER_SOURCE_PROVENANCE_UNAVAILABLE' }
  $actualBlob = (& git hash-object -- $expectedLauncher).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $actualBlob -ne $expectedBlob) { throw 'WEB_TASK_LAUNCHER_BLOB_MISMATCH' }
  Write-Host 'PHASE7C_WEB_TASK_RECOVERY_CANONICAL_LAUNCHER=PASS'
}
function Assert-PortsUnbound {
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int]$_.LocalPort -in @(3711, 5717) })
  if ($listeners.Count -ne 0) { throw 'WEB_OR_API_PORT_ALREADY_BOUND' }
}
function Read-Api([string]$Path) {
  return Invoke-RestMethod -Method Get -Uri ('http://127.0.0.1:3711' + $Path) -TimeoutSec 5
}
function Assert-DirectBrokerFlatAndDisarmed {
  $cfg = Get-Content -LiteralPath (Join-Path $ProductionRoot '.runtime\phase7c-executor-task-config.json') -Raw | ConvertFrom-Json
  if ([string]$cfg.accountMode -ne 'LIVE') { throw 'POST_BROKER_CONFIG_NOT_LIVE' }
  $envFile = [string]$cfg.envFile
  if (-not [IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $ProductionRoot $envFile }
  . (Join-Path $ProductionRoot 'scripts\lib\phase7c-account-mode.ps1')
  $info = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode 'LIVE' -RequireTrading
  if ([string]$info.bridgeHost -notin @('127.0.0.1','localhost','::1')) { throw 'POST_BRIDGE_NOT_LOOPBACK' }
  $base = 'http://' + [string]$info.bridgeHost + ':' + [string]$info.bridgePort
  $headers = @{ 'x-mt5-api-key' = [string]$info.apiKey }
  $health = Invoke-RestMethod -Uri "$base/health" -Method Get -Headers $headers -TimeoutSec 8
  if (-not [bool]$health.connected -or [string]$health.status -ne 'ok') { throw 'POST_BRIDGE_UNHEALTHY' }
  if ([string]$health.accountMode -ne 'real' -or [string]$health.configuredAccountMode -ne 'LIVE') { throw 'POST_BRIDGE_NOT_LIVE_REAL' }
  if ([string]$health.liveArmStatus -ne 'DISARMED' -or [bool]$health.liveExecutionArmed) { throw 'POST_BRIDGE_NOT_DISARMED' }
  foreach ($path in @('/v1/positions?symbol=XAUUSD', '/v1/orders?symbol=XAUUSD')) {
    $resp = Invoke-WebRequest -Uri "$base$path" -Method Get -Headers $headers -UseBasicParsing -TimeoutSec 8
    $raw = ([string]$resp.Content).Trim()
    if ($raw -eq '[]') { continue }
    if (-not $raw) { throw 'POST_BROKER_LIST_EMPTY_UNVERIFIED' }
    $items = $raw | ConvertFrom-Json -ErrorAction Stop
    if ($items -isnot [array] -or @($items).Count -ne 0) { throw 'POST_BROKER_EXPOSURE_OR_INVALID_LIST' }
  }
  Write-Host 'PHASE7C_WEB_TASK_RECOVERY_POST_BRIDGE_LIVE_DISARMED_FLAT=PASS'
}
function Assert-PostRuntime {
  $mode = Read-Api '/api/v1/phase7c/bot-mode'
  $life = Read-Api '/api/v1/phase7c/lifecycle'
  $arm = Read-Api '/api/v1/phase7c-live-arm-control/capability'
  $att = Read-Api '/api/v1/phase7c/runtime-source-attestation'
  if ([string]$mode.state.mode -ne 'PAUSE' -or [string]$life.mode.mode -ne 'PAUSE') { throw 'POST_MODE_NOT_PAUSE' }
  if (-not [bool]$life.running -or -not [bool]$life.ready) { throw 'POST_LIFECYCLE_NOT_READY' }
  if ([string]$life.accountMode.accountMode -ne 'LIVE' -or -not [bool]$life.accountMode.valid) { throw 'POST_ACCOUNT_MODE_NOT_LIVE' }
  if ([string]$arm.accountMode -ne 'LIVE' -or [string]$arm.liveArmStatus -ne 'DISARMED' -or [bool]$arm.liveExecutionArmed) { throw 'POST_ARM_NOT_DISARMED' }
  if ([string]$att.overall -ne 'EXACT_MATCH' -or [string]$att.deployment.sourceCommit -ne $ExpectedSource) { throw 'POST_SOURCE_ATTESTATION_MISMATCH' }
  if (@($att.components).Count -ne 8 -or @($att.components | Where-Object { [string]$_.verdict -ne 'EXACT_MATCH' }).Count -ne 0) { throw 'POST_SOURCE_ATTESTATION_COMPONENTS_NOT_8_OF_8' }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ([string]$task.State -ne 'Running') { throw "WEB_TASK_NOT_RUNNING=$($task.State)" }
  return $true
}
try {
  if (-not (Test-Path -LiteralPath $precheckPath -PathType Leaf)) { throw 'CANONICAL_READONLY_PRECHECK_MISSING' }
  $canonicalReceipt = Join-Path $env:TEMP ('phase7c-recovery-precheck-' + [guid]::NewGuid().ToString('N') + '.json')
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $precheckPath -ProductionRoot $ProductionRoot -ExpectedSource $ExpectedSource -ReceiptPath $canonicalReceipt
    if ($LASTEXITCODE -ne 0) { throw 'PRECHECK_EXECUTION_FAILED' }
    $data = Get-Content -LiteralPath $canonicalReceipt -Raw | ConvertFrom-Json
    if ($data.preRecoveryChecksPass -ne $true -or $data.webRestartAuthorized -ne $false) {
      throw "PRECHECK_BLOCKED=$(@($data.blockerCodes) -join ',')"
    }
    Write-Host 'PHASE7C_WEB_TASK_RECOVERY_FRESH_PRECHECK=PASS'
  } finally {
    if (Test-Path -LiteralPath $canonicalReceipt -PathType Leaf) { Remove-Item -LiteralPath $canonicalReceipt -Force -ErrorAction SilentlyContinue }
  }
  Assert-OnlyCanonicalAction
  Assert-PortsUnbound
  # This is the single authorized production mutation in this script.
  Write-Host 'PHASE7C_WEB_TASK_RECOVERY_SINGLE_MUTATION=START_SCHEDULED_TASK'
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $started = $true
  Write-Host 'PHASE7C_WEB_TASK_RECOVERY_TASK_START_REQUESTED=TRUE'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableSince = 0L
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    try {
      [void](Assert-PostRuntime)
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($stableSince -le 0L) { $stableSince = $now }
      if (($now - $stableSince) -ge 5000) {
        Assert-DirectBrokerFlatAndDisarmed
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_API_LIFECYCLE_READY_STABLE_MS=5000'
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_POST_API_ATTESTATION=EXACT_MATCH'
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_POST_BOT_MODE=PAUSE'
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_POST_ARM=DISARMED'
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_ORDER_MUTATION=NONE'
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_BROKER_MUTATION=NONE'
        Write-Host 'PHASE7C_WEB_TASK_RECOVERY_STATUS=PASS'
        return
      }
    } catch { $stableSince = 0L }
  }
  throw 'POST_WEB_TASK_START_RUNTIME_READY_TIMEOUT'
} catch {
  Write-Host "PHASE7C_WEB_TASK_RECOVERY_TASK_START_ATTEMPTED=$started"
  Write-Host 'PHASE7C_WEB_TASK_RECOVERY_STATUS=FAIL'
  Write-Host 'PHASE7C_WEB_TASK_RECOVERY_NO_AUTOMATIC_ROLLBACK_OR_ARM=TRUE'
  throw
}
