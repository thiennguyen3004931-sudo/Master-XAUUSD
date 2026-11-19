# Strictly read-only Windows Scheduled Task action provenance snapshot for Web-only LIVE recovery.
param(
  [string]$ProductionRoot = 'F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master',
  [string]$ExpectedSource = '196a8420ff008548773f5d385cf5785a9f84e297',
  [string]$ReceiptPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$report = [ordered]@{
  version = 1
  observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  webTaskObserved = $false
  webTaskReady = $false
  actionCountOne = $false
  trustedSystemPowerShell = $false
  canonicalLauncherFileArg = $false
  canonicalWorkingDirArg = $false
  launcherBlobExact = $false
  executorTaskObserved = $false
  executorTaskRunning = $false
  webTaskActionTrusted = $false
  operationalRestartAuthorized = $false
  observedBlockers = @()
}
$blockers = New-Object 'System.Collections.Generic.List[string]'
try {
  if (-not (Test-Path -LiteralPath $ProductionRoot -PathType Container)) { throw 'PRODUCTION_ROOT_MISSING' }
  if ($ExpectedSource -notmatch '^[a-f0-9]{40}$') { throw 'EXPECTED_COMMIT_INVALID' }
  $task = Get-ScheduledTask -TaskName 'XAUUSD-Phase7B-Web' -ErrorAction Stop
  $report.webTaskObserved = $true
  $report.webTaskReady = ([string]$task.State -eq 'Ready')
  if (-not $report.webTaskReady) { $blockers.Add('WEB_TASK_NOT_READY') }
  $actions = @($task.Actions)
  $report.actionCountOne = $actions.Count -eq 1
  if (-not $report.actionCountOne) { $blockers.Add('WEB_TASK_ACTION_COUNT_INVALID') }
  else {
    $exe = ([string]$actions[0].Execute).Trim('"')
    $trusted = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($exe -ieq 'powershell.exe') {
      $exe = [string](Get-Command powershell.exe -ErrorAction Stop).Source
    }
    $report.trustedSystemPowerShell = ($exe -ieq $trusted)
    if (-not $report.trustedSystemPowerShell) { $blockers.Add('WEB_TASK_POWERSHELL_NOT_TRUSTED') }
    $args = [string]$actions[0].Arguments
    $launcher = Join-Path $ProductionRoot 'scripts\run-phase7b-web-autostart.ps1'
    $pattern = '(?i)(?:^|\s)-File\s+["'']?' + [regex]::Escape($launcher) + '["'']?(?=\s|$)'
    $report.canonicalLauncherFileArg = ($args -match $pattern) -and ($args -notmatch '(?i)(?:-EncodedCommand|-Command\s|invoke-expression|iex\s)')
    $report.canonicalWorkingDirArg = $args.IndexOf('-WorkDir', [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $report.canonicalLauncherFileArg) { $blockers.Add('WEB_TASK_FILE_ARG_UNTRUSTED') }
    if (-not $report.canonicalWorkingDirArg) { $blockers.Add('WEB_TASK_WORKDIR_ARG_MISSING') }
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
      $blockers.Add('WEB_TASK_CANONICAL_LAUNCHER_MISSING')
    } else {
      $expectedBlob = (& git -C $ProductionRoot rev-parse "$($ExpectedSource):scripts/run-phase7b-web-autostart.ps1").Trim().ToLowerInvariant()
      $actualBlob = (& git hash-object -- $launcher).Trim().ToLowerInvariant()
      $report.launcherBlobExact = ($LASTEXITCODE -eq 0 -and $expectedBlob -match '^[a-f0-9]{40}$' -and $actualBlob -eq $expectedBlob)
      if (-not $report.launcherBlobExact) { $blockers.Add('WEB_TASK_LAUNCHER_BLOB_INVALID') }
    }
  }
} catch {
  $blockers.Add('WEB_TASK_PROVENANCE_UNAVAILABLE')
}
try {
  $execTask = Get-ScheduledTask -TaskName 'XAUUSD-Phase7C-Executors' -ErrorAction Stop
  $report.executorTaskObserved = $true
  $report.executorTaskRunning = [string]$execTask.State -eq 'Running'
  if (-not $report.executorTaskRunning) { $blockers.Add('EXECUTOR_TASK_NOT_RUNNING') }
} catch { $blockers.Add('EXECUTOR_TASK_UNAVAILABLE') }
$report.webTaskActionTrusted = (
  $report.webTaskReady -and $report.actionCountOne -and $report.trustedSystemPowerShell -and
  $report.canonicalLauncherFileArg -and $report.canonicalWorkingDirArg -and $report.launcherBlobExact -and
  $report.executorTaskRunning -and $blockers.Count -eq 0
)
$report.observedBlockers = @($blockers.ToArray())
foreach ($key in @('webTaskObserved','webTaskReady','actionCountOne','trustedSystemPowerShell','canonicalLauncherFileArg','canonicalWorkingDirArg','launcherBlobExact','executorTaskRunning','webTaskActionTrusted')) {
  Write-Host "PHASE7C_WEB_TASK_EVIDENCE_$($key.ToUpperInvariant())=$($report[$key])"
}
Write-Host "PHASE7C_WEB_TASK_EVIDENCE_BLOCKERS=$(@($blockers.ToArray()) -join ',')"
Write-Host 'PHASE7C_WEB_TASK_EVIDENCE_RESTART_AUTHORIZED=FALSE'
Write-Host 'PHASE7C_WEB_TASK_EVIDENCE_PRODUCTION_MUTATION=NONE'
Write-Host 'PHASE7C_WEB_TASK_EVIDENCE_BROKER_REQUESTS=NONE'
if (-not [string]::IsNullOrWhiteSpace($ReceiptPath)) {
  $json = $report | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($ReceiptPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}
Write-Host 'PHASE7C_WEB_TASK_EVIDENCE_READONLY=COMPLETE'
