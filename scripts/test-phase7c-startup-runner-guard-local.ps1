$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$GuardLibrary = Join-Path $PSScriptRoot "lib\phase7c-startup-runner-guard.ps1"
$Runner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
$Supervisor = Join-Path $PSScriptRoot "run-phase7c-executors-local.ps1"

if (-not (Test-Path -LiteralPath $GuardLibrary)) { throw "Missing startup runner guard: $GuardLibrary" }
if (-not (Test-Path -LiteralPath $Runner)) { throw "Missing startup runner: $Runner" }
if (-not (Test-Path -LiteralPath $Supervisor)) { throw "Missing executor supervisor: $Supervisor" }
. $GuardLibrary

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw "ASSERT_TRUE failed: $Message" }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "ASSERT_EQUAL failed: $Message. Expected=$Expected Actual=$Actual"
  }
}

function Assert-PowerShellSyntax([string]$Path) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $Path,
    [ref]$tokens,
    [ref]$errors
  )
  if (@($errors).Count -gt 0) {
    $messages = @($errors | ForEach-Object { $_.Message }) -join " | "
    throw "PowerShell syntax errors in ${Path}: $messages"
  }
}

# The guard is dot-sourced by the long-lived task runner. It must not change
# StrictMode in the caller scope because legacy v1 task config can omit optional
# fields such as trendFixedVolume and relies on the runner's null fallback.
$strictModeLeaked = $false
try {
  $legacyConfig = [pscustomobject]@{ version = 1 }
  $legacyTrendFixedVolume = $legacyConfig.trendFixedVolume
  Assert-Equal $legacyTrendFixedVolume $null "legacy optional config field should resolve to null"
} catch {
  $strictModeLeaked = $true
}
Assert-True (-not $strictModeLeaked) "guard library must not enable StrictMode in the caller scope"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-runner-guard-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$firstLock = $null
$thirdLock = $null
try {
  $lockPath = Join-Path $tempRoot "startup-runner.lock"
  $firstLock = Open-Phase7CStartupRunnerLock -Path $lockPath
  Assert-True ($null -ne $firstLock) "first startup runner must acquire the exclusive lock"

  $duplicateBlocked = $false
  try {
    $unexpectedLock = Open-Phase7CStartupRunnerLock -Path $lockPath
    if ($null -ne $unexpectedLock) { $unexpectedLock.Dispose() }
  } catch {
    $duplicateBlocked = $_.Exception.Message -like "*already owns the exclusive lock*"
  }
  Assert-True $duplicateBlocked "a second startup runner must fail closed while the lock is held"

  $firstLock.Dispose()
  $firstLock = $null

  $thirdLock = Open-Phase7CStartupRunnerLock -Path $lockPath
  Assert-True ($null -ne $thirdLock) "lock must be reusable after the owning runner exits"
  $thirdLock.Dispose()
  $thirdLock = $null

  $jsonPath = Join-Path $tempRoot "startup-runner-status.json"
  Write-Phase7CJsonAtomic -Path $jsonPath -Value ([pscustomobject]@{ version = 1; status = "FIRST"; runnerPid = 111 }) -Depth 4
  $firstJson = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
  Assert-Equal ([string]$firstJson.status) "FIRST" "first atomic status write must remain parseable"

  Write-Phase7CJsonAtomic -Path $jsonPath -Value ([pscustomobject]@{ version = 1; status = "SECOND"; runnerPid = 222 }) -Depth 4
  $secondJson = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
  Assert-Equal ([string]$secondJson.status) "SECOND" "replacement atomic status write must remain parseable"
  Assert-Equal ([int]$secondJson.runnerPid) 222 "replacement atomic status must contain the new payload"

  $leftoverTemps = @(Get-ChildItem -LiteralPath $tempRoot -Filter "*.tmp" -File -ErrorAction SilentlyContinue)
  Assert-Equal $leftoverTemps.Count 0 "atomic status writes must not leave temp files behind"

  Assert-PowerShellSyntax $GuardLibrary
  Assert-PowerShellSyntax $Runner
  Assert-PowerShellSyntax $Supervisor

  $runnerText = Get-Content -LiteralPath $Runner -Raw
  Assert-True ($runnerText -match 'phase7c-startup-runner-guard\.ps1') "runner must load the singleton guard library"
  Assert-True ($runnerText -match 'Open-Phase7CStartupRunnerLock') "runner must acquire an exclusive lock before launching supervisor"
  Assert-True ($runnerText -match 'Write-Phase7CJsonAtomic') "runner status writes must use atomic replacement"
  Assert-True ($runnerText -match 'PHASE7C_EXECUTOR_TASK_RUNNER_LOCK=BLOCKED') "duplicate runner attempts must be observable"
  Assert-True ($runnerText -match '\$runnerLock\.Dispose\(\)') "runner must release its lock on graceful exit"

  # Startup is a safety boundary: once dependencies are ready, the canonical
  # control API must be forced to PAUSE before either trading controller starts.
  # AUTO must remain an explicit operator/Web action after startup.
  $supervisorText = Get-Content -LiteralPath $Supervisor -Raw
  Assert-True ($supervisorText -match 'function\s+Set-Phase7CStartupPause') "supervisor must define an explicit startup PAUSE transition"
  Assert-True ($supervisorText -match '(?s)Set-Phase7CStartupPause.*Invoke-RestMethod.*?/api/v1/phase7c/bot-mode') "startup PAUSE must go through the canonical bot-mode API"
  Assert-True ($supervisorText -match '(?s)Set-Phase7CStartupPause.*?mode\s*=\s*["'']PAUSE["'']') "startup transition must request PAUSE"
  Assert-True ($supervisorText -match '(?s)Set-Phase7CStartupPause.*?source\s*=\s*["'']startup-scheduled-task["'']') "startup PAUSE must identify its provenance source"
  Assert-True ($supervisorText -match '(?s)Set-Phase7CStartupPause.*?state\.mode.*?PAUSE') "startup must verify the API persisted PAUSE"

  $dependencyCall = [regex]::Match($supervisorText, '(?m)^\s{2}Wait-Phase7CDependencies\s*$')
  $pauseCall = [regex]::Match($supervisorText, '(?m)^\s{2}Set-Phase7CStartupPause\s*$')
  $trendLaunch = [regex]::Match($supervisorText, '(?m)^\s{2}\$trend\s*=\s*Start-Process\b')
  $sidewayLaunch = [regex]::Match($supervisorText, '(?m)^\s{2}\$sideway\s*=\s*Start-Process\b')
  Assert-True $dependencyCall.Success "supervisor must wait for dependencies before the startup PAUSE transition"
  Assert-True $pauseCall.Success "supervisor must invoke the startup PAUSE transition"
  Assert-True $trendLaunch.Success "test contract must locate the Trend launch boundary"
  Assert-True $sidewayLaunch.Success "test contract must locate the Sideway launch boundary"
  Assert-True ($dependencyCall.Index -lt $pauseCall.Index) "startup PAUSE must happen after dependency readiness"
  Assert-True ($pauseCall.Index -lt $trendLaunch.Index) "startup PAUSE must happen before Trend launch"
  Assert-True ($pauseCall.Index -lt $sidewayLaunch.Index) "startup PAUSE must happen before Sideway launch"

  Write-Host "PHASE7C_STARTUP_RUNNER_GUARD_TEST=PASS"
} finally {
  if ($null -ne $firstLock) { $firstLock.Dispose() }
  if ($null -ne $thirdLock) { $thirdLock.Dispose() }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
