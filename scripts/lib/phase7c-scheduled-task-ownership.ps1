function Get-Phase7CExecutorTaskRunnerPath {
  param([Parameter(Mandatory = $true)] [string]$ProjectRoot)

  $root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
  return [System.IO.Path]::GetFullPath((Join-Path $root 'scripts\run-phase7c-executor-task-runner-local.ps1'))
}

function Normalize-Phase7CRunnerSha256 {
  param([Parameter(Mandatory = $true)] [string]$Sha256)

  $value = ([string]$Sha256).Trim().ToUpperInvariant()
  if ($value -notmatch '^[0-9A-F]{64}$') {
    throw "Runner SHA256 must be exactly 64 hexadecimal characters. value=$Sha256"
  }
  return $value
}

function Invoke-Phase7CGitCommand {
  param(
    [Parameter(Mandatory = $true)] [string]$RepositoryRoot,
    [Parameter(Mandatory = $true)] [string[]]$Arguments
  )

  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $git) {
    throw 'Git executable is required to prove the accepted Phase7C runner source.'
  }

  $output = @(& $git.Source -C $RepositoryRoot @Arguments 2>&1)
  $exitCode = [int]$LASTEXITCODE
  return [pscustomobject]@{
    exitCode = $exitCode
    output = @($output | ForEach-Object { [string]$_ })
  }
}

function Get-Phase7CTrustedGitFileSha256 {
  param(
    [Parameter(Mandatory = $true)] [string]$ProjectRoot,
    [Parameter(Mandatory = $true)] [string]$Path
  )

  $root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
  $file = [System.IO.Path]::GetFullPath($Path)
  $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
  if (-not $file.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Trusted source path must be inside ProjectRoot. path=$file root=$root"
  }
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Trusted source file does not exist: $file"
  }

  $topResult = Invoke-Phase7CGitCommand -RepositoryRoot $root -Arguments @('rev-parse', '--show-toplevel')
  if ($topResult.exitCode -ne 0 -or $topResult.output.Count -lt 1) {
    throw "ProjectRoot is not a readable Git worktree. root=$root"
  }
  $gitTop = [System.IO.Path]::GetFullPath(([string]$topResult.output[-1]).Trim()).TrimEnd('\', '/')
  if (-not $gitTop.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ProjectRoot must be the Git worktree root. projectRoot=$root gitRoot=$gitTop"
  }

  $relative = $file.Substring($prefix.Length).Replace('\', '/')
  $trackedResult = Invoke-Phase7CGitCommand -RepositoryRoot $root -Arguments @('ls-files', '--error-unmatch', '--', $relative)
  if ($trackedResult.exitCode -ne 0) {
    throw "Runner source is not tracked by Git. relativePath=$relative"
  }

  $headBlobResult = Invoke-Phase7CGitCommand -RepositoryRoot $root -Arguments @('rev-parse', '--verify', ("HEAD:{0}" -f $relative))
  if ($headBlobResult.exitCode -ne 0 -or $headBlobResult.output.Count -lt 1) {
    throw "Runner source is not present in accepted Git HEAD. relativePath=$relative"
  }
  $headBlob = ([string]$headBlobResult.output[-1]).Trim()
  if ([string]::IsNullOrWhiteSpace($headBlob)) {
    throw "Accepted Git HEAD returned an empty runner blob id. relativePath=$relative"
  }

  $worktreeBlobResult = Invoke-Phase7CGitCommand -RepositoryRoot $root -Arguments @('hash-object', ("--path={0}" -f $relative), '--', $relative)
  if ($worktreeBlobResult.exitCode -ne 0 -or $worktreeBlobResult.output.Count -lt 1) {
    throw "Cannot hash runner worktree source through Git clean filters. relativePath=$relative"
  }
  $worktreeBlob = ([string]$worktreeBlobResult.output[-1]).Trim()
  if ([string]::IsNullOrWhiteSpace($worktreeBlob)) {
    throw "Runner worktree hashing returned an empty blob id. relativePath=$relative"
  }

  if (-not $headBlob.Equals($worktreeBlob, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Runner worktree source differs from accepted Git HEAD. relativePath=$relative"
  }

  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash
  return (Normalize-Phase7CRunnerSha256 -Sha256 $hash)
}

function New-Phase7CExecutorTaskGuardScript {
  param(
    [Parameter(Mandatory = $true)] [string]$RunnerPath,
    [Parameter(Mandatory = $true)] [string]$RunnerSha256
  )

  $runner = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($RunnerPath)).TrimEnd('\', '/')
  $hash = Normalize-Phase7CRunnerSha256 -Sha256 $RunnerSha256
  $pathBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($runner))
  $lines = @(
    "# PHASE7C_EXECUTOR_TASK_GUARD_V1 PATH_B64=$pathBase64 SHA256=$hash",
    '$ErrorActionPreference = ''Stop''',
    "`$runnerPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('$pathBase64'))",
    "`$expectedSha256 = '$hash'",
    'try {',
    '  if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { exit 86 }',
    '  $actualSha256 = (Get-FileHash -LiteralPath $runnerPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()',
    '} catch {',
    '  exit 86',
    '}',
    'if (-not [string]::Equals($actualSha256, $expectedSha256, [System.StringComparison]::Ordinal)) { exit 86 }',
    '& $runnerPath'
  )
  return ($lines -join "`n")
}

function New-Phase7CExecutorTaskGuardArguments {
  param(
    [Parameter(Mandatory = $true)] [string]$RunnerPath,
    [Parameter(Mandatory = $true)] [string]$RunnerSha256
  )

  $script = New-Phase7CExecutorTaskGuardScript -RunnerPath $RunnerPath -RunnerSha256 $RunnerSha256
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
  return "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

function Get-Phase7CExecutorTaskGuardMetadata {
  param([Parameter(Mandatory = $true)] [string]$EncodedCommand)

  try {
    $bytes = [Convert]::FromBase64String($EncodedCommand)
    $script = [System.Text.Encoding]::Unicode.GetString($bytes)
  } catch {
    return $null
  }

  $lineFeed = $script.IndexOf("`n", [System.StringComparison]::Ordinal)
  if ($lineFeed -le 0) { return $null }
  $firstLine = $script.Substring(0, $lineFeed).TrimEnd("`r")
  $match = [regex]::Match(
    $firstLine,
    '^# PHASE7C_EXECUTOR_TASK_GUARD_V1 PATH_B64=(?<path>[A-Za-z0-9+/=]+) SHA256=(?<hash>[0-9A-F]{64})$'
  )
  if (-not $match.Success) { return $null }

  try {
    $runnerPath = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Groups['path'].Value))
    $runnerSha256 = Normalize-Phase7CRunnerSha256 -Sha256 $match.Groups['hash'].Value
    $canonicalScript = New-Phase7CExecutorTaskGuardScript -RunnerPath $runnerPath -RunnerSha256 $runnerSha256
  } catch {
    return $null
  }

  if (-not $script.Equals($canonicalScript, [System.StringComparison]::Ordinal)) {
    return $null
  }

  return [pscustomobject]@{
    runnerPath = [System.IO.Path]::GetFullPath($runnerPath).TrimEnd('\', '/')
    runnerSha256 = $runnerSha256
  }
}

function ConvertFrom-Phase7CCommandLineTokens {
  param([AllowEmptyString()] [string]$Arguments)

  if ([string]::IsNullOrWhiteSpace($Arguments)) { return @() }

  $matches = [regex]::Matches($Arguments, '"[^"]*"|''[^'']*''|\S+')
  $tokens = @()
  foreach ($match in $matches) {
    $value = [string]$match.Value
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $tokens += $value
  }
  return @($tokens)
}

function Test-Phase7CPowerShellExecutable {
  param([AllowEmptyString()] [string]$Execute)

  if ([string]::IsNullOrWhiteSpace($Execute)) { return $false }
  $candidate = [Environment]::ExpandEnvironmentVariables($Execute.Trim().Trim('"'))
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    return $candidate.Equals('powershell.exe', [System.StringComparison]::OrdinalIgnoreCase)
  }

  try {
    $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
  } catch {
    return $false
  }

  $allowed = @()
  if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
    $allowed += [System.IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')).TrimEnd('\')
    $allowed += [System.IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe')).TrimEnd('\')
  }
  foreach ($path in $allowed) {
    if ($full.Equals($path, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function New-Phase7CExecutorTaskActionOwnershipResult {
  param(
    [bool]$Owned,
    [bool]$Canonical,
    [bool]$RepairRequired,
    [string]$Reason,
    [int]$ActionCount = 1,
    [string]$RunnerPath = '',
    [string]$RunnerSha256 = ''
  )

  return [pscustomobject]@{
    owned = $Owned
    canonical = $Canonical
    repairRequired = $RepairRequired
    reason = $Reason
    actionCount = $ActionCount
    runnerPath = $RunnerPath
    runnerSha256 = $RunnerSha256
  }
}

function Test-Phase7CExecutorTaskActionOwnership {
  param(
    [Parameter(Mandatory = $true)] $Actions,
    [Parameter(Mandatory = $true)] [string]$ExpectedRunnerPath,
    [AllowEmptyString()] [string]$ExpectedRunnerSha256 = ''
  )

  $items = @($Actions)
  if ($items.Count -ne 1) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'ACTION_COUNT' -ActionCount $items.Count
  }

  $action = $items[0]
  if (-not (Test-Phase7CPowerShellExecutable ([string]$action.Execute))) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'EXECUTABLE_MISMATCH'
  }

  $tokens = @(ConvertFrom-Phase7CCommandLineTokens ([string]$action.Arguments))
  if ($tokens.Count -ne 5) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'ARGUMENT_COUNT'
  }

  $canonicalPrefix =
    $tokens[0].Equals('-NoProfile', [System.StringComparison]::OrdinalIgnoreCase) -and
    $tokens[1].Equals('-ExecutionPolicy', [System.StringComparison]::OrdinalIgnoreCase) -and
    $tokens[2].Equals('Bypass', [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $canonicalPrefix) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'ARGUMENTS_MISMATCH'
  }

  try {
    $expectedRunner = [System.IO.Path]::GetFullPath($ExpectedRunnerPath).TrimEnd('\', '/')
  } catch {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'RUNNER_PATH_INVALID'
  }

  if ($tokens[3].Equals('-File', [System.StringComparison]::OrdinalIgnoreCase)) {
    try {
      $actualRunner = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($tokens[4])).TrimEnd('\', '/')
    } catch {
      return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'RUNNER_PATH_INVALID'
    }
    if (-not $actualRunner.Equals($expectedRunner, [System.StringComparison]::OrdinalIgnoreCase)) {
      return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'RUNNER_PATH_MISMATCH' -RunnerPath $actualRunner
    }
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $true -Canonical $false -RepairRequired $true -Reason 'OWNED_LEGACY_ACTION_REPAIR_REQUIRED' -RunnerPath $actualRunner
  }

  if (-not $tokens[3].Equals('-EncodedCommand', [System.StringComparison]::OrdinalIgnoreCase)) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'ARGUMENTS_MISMATCH'
  }

  $metadata = Get-Phase7CExecutorTaskGuardMetadata -EncodedCommand $tokens[4]
  if ($null -eq $metadata) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'GUARD_TEMPLATE_MISMATCH'
  }
  if (-not ([string]$metadata.runnerPath).Equals($expectedRunner, [System.StringComparison]::OrdinalIgnoreCase)) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $false -Canonical $false -RepairRequired $false -Reason 'RUNNER_PATH_MISMATCH' -RunnerPath ([string]$metadata.runnerPath) -RunnerSha256 ([string]$metadata.runnerSha256)
  }

  if ([string]::IsNullOrWhiteSpace($ExpectedRunnerSha256)) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $true -Canonical $false -RepairRequired $true -Reason 'OWNED_HASH_UNVERIFIED_REPAIR_REQUIRED' -RunnerPath ([string]$metadata.runnerPath) -RunnerSha256 ([string]$metadata.runnerSha256)
  }

  $expectedHash = Normalize-Phase7CRunnerSha256 -Sha256 $ExpectedRunnerSha256
  if (-not ([string]$metadata.runnerSha256).Equals($expectedHash, [System.StringComparison]::Ordinal)) {
    return New-Phase7CExecutorTaskActionOwnershipResult -Owned $true -Canonical $false -RepairRequired $true -Reason 'OWNED_HASH_DRIFT_REPAIR_REQUIRED' -RunnerPath ([string]$metadata.runnerPath) -RunnerSha256 ([string]$metadata.runnerSha256)
  }

  return New-Phase7CExecutorTaskActionOwnershipResult -Owned $true -Canonical $true -RepairRequired $false -Reason 'OWNED' -RunnerPath ([string]$metadata.runnerPath) -RunnerSha256 ([string]$metadata.runnerSha256)
}

function Get-Phase7CTriggerKind {
  param($Trigger)

  if ($null -eq $Trigger) { return '' }
  try {
    if ($null -ne $Trigger.CimClass -and -not [string]::IsNullOrWhiteSpace([string]$Trigger.CimClass.CimClassName)) {
      return [string]$Trigger.CimClass.CimClassName
    }
  } catch { }
  try {
    if (-not [string]::IsNullOrWhiteSpace([string]$Trigger.CimClassName)) { return [string]$Trigger.CimClassName }
  } catch { }
  return ''
}

function Get-Phase7CExecutorTaskDrift {
  param([Parameter(Mandatory = $true)] $Task)

  $drift = New-Object System.Collections.Generic.List[string]
  $triggers = @($Task.Triggers)
  if ($triggers.Count -ne 1 -or (Get-Phase7CTriggerKind $triggers[0]) -ne 'MSFT_TaskBootTrigger') {
    $drift.Add('TRIGGER')
  }

  $settings = $Task.Settings
  if ($null -eq $settings) {
    $drift.Add('SETTINGS')
  } else {
    if ([bool]$settings.AllowDemandStart -ne $true) { $drift.Add('ALLOW_DEMAND_START') }
    if ([bool]$settings.StartWhenAvailable -ne $true) { $drift.Add('START_WHEN_AVAILABLE') }
    if ([string]$settings.MultipleInstances -ne 'IgnoreNew') { $drift.Add('MULTIPLE_INSTANCES') }
    if ([int]$settings.RestartCount -ne 0) { $drift.Add('RESTART_COUNT') }
    if ([string]$settings.ExecutionTimeLimit -ne 'PT0S') { $drift.Add('EXECUTION_TIME_LIMIT') }

    $disallowStartIfOnBatteries = $true
    if ($null -ne $settings.PSObject.Properties['DisallowStartIfOnBatteries']) {
      $disallowStartIfOnBatteries = [bool]$settings.DisallowStartIfOnBatteries
    }
    if ($disallowStartIfOnBatteries) { $drift.Add('DISALLOW_START_IF_ON_BATTERIES') }

    $stopIfGoingOnBatteries = $true
    if ($null -ne $settings.PSObject.Properties['StopIfGoingOnBatteries']) {
      $stopIfGoingOnBatteries = [bool]$settings.StopIfGoingOnBatteries
    }
    if ($stopIfGoingOnBatteries) { $drift.Add('STOP_IF_GOING_ON_BATTERIES') }
  }

  if ($null -eq $Task.Principal -or [string]$Task.Principal.RunLevel -ne 'Highest') {
    $drift.Add('PRINCIPAL_RUN_LEVEL')
  }

  return @($drift)
}

function Test-Phase7CBatteryOnlyTaskDrift {
  param([string[]]$Drift = @())

  $items = @(
    $Drift |
      ForEach-Object { ([string]$_).Trim().ToUpperInvariant() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Sort-Object -Unique
  )
  if ($items.Count -eq 0) { return $false }

  $allowed = @(
    'DISALLOW_START_IF_ON_BATTERIES',
    'STOP_IF_GOING_ON_BATTERIES'
  )
  foreach ($item in $items) {
    if ($allowed -notcontains $item) { return $false }
  }
  return $true
}

function Get-Phase7CScheduledTaskErrorClassification {
  param([Parameter(Mandatory = $true)] [System.Exception]$Exception)

  if ($Exception -is [System.UnauthorizedAccessException]) { return 'ACCESS_DENIED' }
  $code = $Exception.HResult -band 0xFFFF
  if ($code -eq 5) { return 'ACCESS_DENIED' }
  if ($code -eq 2 -or $code -eq 1168) { return 'NOT_FOUND' }

  $message = [string]$Exception.Message
  if ($message -match '(?i)access\s+is\s+denied|access\s+denied|unauthorized') { return 'ACCESS_DENIED' }
  if ($message -match '(?i)not\s+found|cannot\s+find|no\s+matching\s+MSFT_ScheduledTask|no\s+MSFT_ScheduledTask\s+objects\s+found') { return 'NOT_FOUND' }
  return 'PROVIDER_ERROR'
}

function Get-Phase7CStartupRunnerLockState {
  param([Parameter(Mandatory = $true)] [string]$LockPath)

  if (-not (Test-Path -LiteralPath $LockPath)) { return 'MISSING' }
  $handle = $null
  try {
    $handle = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return 'RELEASED'
  } catch [System.UnauthorizedAccessException] {
    return 'ACCESS_DENIED'
  } catch [System.IO.IOException] {
    $code = $_.Exception.HResult -band 0xFFFF
    if ($code -eq 32 -or $code -eq 33) { return 'HELD' }
    return 'IO_ERROR'
  } catch {
    return 'ERROR'
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
  }
}
