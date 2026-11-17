param(
  [string]$WorkDir = ".runtime",
  [string]$WebTask = "XAUUSD-Phase7B-Web",
  [int]$ApiPort = 3711,
  [int]$WebPort = 5717,
  [int]$StartupTimeoutSeconds = 90,
  [switch]$AllowOwnedTaskProvenanceMigration,
  [string]$ExpectedRunnerSha256 = "",
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExpectedCommit
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DashboardDeploy = Join-Path $PSScriptRoot "deploy-phase7c-mt5-dashboard-local.ps1"
$LifecycleBrokerRunner = Join-Path $PSScriptRoot "run-phase7c-executor-task-runner-local.ps1"
$LifecycleBrokerGuardLibrary = Join-Path $PSScriptRoot "lib\phase7c-startup-runner-guard.ps1"
$LifecycleBrokerAccountLibrary = Join-Path $PSScriptRoot "lib\phase7c-account-mode.ps1"
$LifecycleBrokerLibrary = Join-Path $PSScriptRoot "lib\phase7c-lifecycle-broker.ps1"
$RuntimeSourceAttestationLibrary = Join-Path $PSScriptRoot "lib\phase7c-runtime-source-attestation.ps1"
$ExecutorConfigPath = Join-Path $ProjectRoot ".runtime\phase7c-executor-task-config.json"

if ($AllowOwnedTaskProvenanceMigration) {
  if ($ExpectedRunnerSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Owned task provenance migration Web deploy requires an exact 64-character ExpectedRunnerSha256."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($ExpectedRunnerSha256)) {
  throw "ExpectedRunnerSha256 is only valid with AllowOwnedTaskProvenanceMigration."
}

foreach ($required in @(
  $DashboardDeploy,
  $LifecycleBrokerRunner,
  $LifecycleBrokerGuardLibrary,
  $LifecycleBrokerAccountLibrary,
  $LifecycleBrokerLibrary,
  $RuntimeSourceAttestationLibrary,
  $ExecutorConfigPath
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Web UI deploy required file missing: $required"
  }
}
. $LifecycleBrokerAccountLibrary
. $RuntimeSourceAttestationLibrary

function Read-JsonFile(
  [string]$Path,
  [string]$Label,
  [int]$MaxReadAttempts = 5,
  [int]$RetryDelayMilliseconds = 100
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file is missing: $Path"
  }

  $raw = $null
  for ($attempt = 1; $attempt -le $MaxReadAttempts; $attempt++) {
    try {
      $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
      break
    } catch [System.IO.IOException] {
      if ($attempt -ge $MaxReadAttempts) {
        throw "$Label file could not be read after $MaxReadAttempts attempts: $Path. $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds $RetryDelayMilliseconds
    }
  }

  try {
    return $raw | ConvertFrom-Json
  } catch {
    throw "$Label file is invalid: $Path. $($_.Exception.Message)"
  }
}

function Resolve-ProjectPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Assert-LifecycleBrokerSourceFresh([string]$WorkDir) {
  $resolvedWorkDir = if ([System.IO.Path]::IsPathRooted($WorkDir)) {
    [System.IO.Path]::GetFullPath($WorkDir)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $WorkDir))
  }

  $heartbeatPath = Join-Path $resolvedWorkDir "phase7c-lifecycle-broker\state\heartbeat.json"
  $brokerLogPath = Join-Path $resolvedWorkDir "phase7c-lifecycle-broker\logs\broker.log"
  $heartbeat = Read-JsonFile -Path $heartbeatPath -Label "Lifecycle broker heartbeat"
  $brokerPid = [int]$heartbeat.brokerPid
  if ($brokerPid -le 0) {
    throw "Lifecycle broker heartbeat is missing brokerPid."
  }
  if (-not (Test-Path -LiteralPath $brokerLogPath -PathType Leaf)) {
    throw "Lifecycle broker log is missing: $brokerLogPath"
  }

  $bootMarker = "Lifecycle broker starting. PID=$brokerPid "
  $bootMatch = Select-String -LiteralPath $brokerLogPath -SimpleMatch $bootMarker | Select-Object -Last 1
  if ($null -eq $bootMatch) {
    throw "Lifecycle broker boot marker is missing for brokerPid=$brokerPid."
  }
  $bootLine = [string]$bootMatch.Line
  if ($bootLine -notmatch '^\[(?<stamp>[^\]]+)\]\s+Lifecycle broker starting\. PID=') {
    throw "Lifecycle broker boot marker has an invalid timestamp format. brokerPid=$brokerPid"
  }

  try {
    $brokerStartedUtc = [DateTimeOffset]::Parse(
      [string]$Matches['stamp'],
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::RoundtripKind
    ).UtcDateTime
  } catch {
    throw "Lifecycle broker boot timestamp is invalid. brokerPid=$brokerPid"
  }

  $startupLoadedSources = @(
    $LifecycleBrokerRunner,
    $LifecycleBrokerGuardLibrary,
    $LifecycleBrokerAccountLibrary,
    $LifecycleBrokerLibrary,
    $RuntimeSourceAttestationLibrary
  )
  $latestSourceWriteUtc = @(
    $startupLoadedSources | ForEach-Object {
      (Get-Item -LiteralPath $_ -ErrorAction Stop).LastWriteTimeUtc
    }
  ) | Sort-Object -Descending | Select-Object -First 1

  if ($brokerStartedUtc -lt $latestSourceWriteUtc) {
    if ($AllowOwnedTaskProvenanceMigration) {
      Write-Host "PHASE7C_WEB_UI_DEPLOY_BROKER_SOURCE_STALE_MIGRATION=ALLOWED_OWNED_TASK_REPAIR|BROKER_PID=$brokerPid|STARTED_UTC=$($brokerStartedUtc.ToString('o'))|SOURCE_UPDATED_UTC=$($latestSourceWriteUtc.ToString('o'))"
    } else {
      throw "Web UI deploy blocked: lifecycle broker process is stale relative to source loaded at broker startup. brokerPid=$brokerPid startedUtc=$($brokerStartedUtc.ToString('o')) sourceUpdatedUtc=$($latestSourceWriteUtc.ToString('o')). Use the controlled executor runtime reload path before Web/API deploy."
    }
  } else {
    Write-Host "PHASE7C_WEB_UI_DEPLOY_BROKER_SOURCE_FRESH=PASS"
  }

  Write-Host "PHASE7C_WEB_UI_DEPLOY_BROKER_PID=$brokerPid"
}

Push-Location $ProjectRoot
try {
  $git = Get-Command git -ErrorAction Stop
  $pnpm = Get-Command pnpm -ErrorAction Stop

  $branch = (& $git.Source branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
    throw "Web UI deploy requires branch main. Current=$branch"
  }

  $dirty = @(& $git.Source status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect git working tree." }
  if ($dirty.Count -gt 0) {
    throw "Web UI deploy requires a clean working tree. No runtime process was restarted."
  }

  $currentCommit = (& $git.Source rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Could not resolve current git HEAD. No runtime process was restarted."
  }
  if ($currentCommit -ne $ExpectedCommit) {
    throw "Web UI deploy requires commit '$ExpectedCommit' but found '$currentCommit'. No runtime process was restarted."
  }
  $sourceTree = (& $git.Source rev-parse "$ExpectedCommit`^{tree}").Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0 -or $sourceTree -notmatch '^[0-9a-f]{40}$') {
    throw "Could not resolve exact source tree for runtime attestation. No runtime process was restarted."
  }

  Write-Host "PHASE7C_WEB_UI_DEPLOY=START"
  Write-Host "PHASE7C_WEB_UI_DEPLOY_BRANCH=$branch"
  Write-Host "PHASE7C_WEB_UI_DEPLOY_EXPECTED_COMMIT=$ExpectedCommit"
  Write-Host "PHASE7C_WEB_UI_DEPLOY_GIT_CLEAN=PASS"

  $executorConfig = Read-JsonFile -Path $ExecutorConfigPath -Label "Executor task config"
  if ([int]$executorConfig.version -ne 2) {
    throw "Web UI deploy requires executor task config version 2 before runtime attestation."
  }
  $taskConfiguredAccountMode = ConvertTo-Phase7CAccountMode ([string]$executorConfig.accountMode)
  $taskConfiguredLiveExecutionEnabled = [bool]$executorConfig.liveExecutionEnabled
  if ($taskConfiguredAccountMode -eq "LIVE" -and -not $taskConfiguredLiveExecutionEnabled) {
    throw "Web UI deploy refuses an inconsistent LIVE executor config before runtime attestation."
  }
  if ($taskConfiguredAccountMode -eq "DEMO" -and $taskConfiguredLiveExecutionEnabled) {
    throw "Web UI deploy refuses liveExecutionEnabled=true for DEMO before runtime attestation."
  }

  $resolvedWorkDir = Resolve-ProjectPath $WorkDir
  $configuredWorkDir = Resolve-ProjectPath ([string]$executorConfig.workDir)
  if ([string]::IsNullOrWhiteSpace($resolvedWorkDir) -or $resolvedWorkDir -ne $configuredWorkDir) {
    throw "Web UI deploy WorkDir must match the canonical executor runtime root before runtime attestation. requested=$resolvedWorkDir configured=$configuredWorkDir"
  }
  $configuredControlApiUrl = ([string]$executorConfig.controlApiUrl).TrimEnd('/')
  $expectedControlApiUrl = "http://127.0.0.1:$ApiPort"
  if ([string]::IsNullOrWhiteSpace($configuredControlApiUrl) -or $configuredControlApiUrl -ne $expectedControlApiUrl) {
    throw "Web UI deploy API endpoint must match the canonical executor controlApiUrl before runtime attestation. expected=$expectedControlApiUrl configured=$configuredControlApiUrl"
  }

  $accountStatePath = Join-Path $resolvedWorkDir "phase7c-account-mode.json"
  $accountState = Read-JsonFile -Path $accountStatePath -Label "Canonical account-mode state"
  if ([int]$accountState.version -ne 1) {
    throw "Web UI deploy requires canonical account-mode state version 1 before runtime attestation."
  }
  $canonicalAttestedAccountMode = ConvertTo-Phase7CAccountMode ([string]$accountState.accountMode)
  $canonicalAttestedLiveExecutionEnabled = [bool]$accountState.liveExecutionEnabled
  if ($canonicalAttestedAccountMode -eq "LIVE" -and -not $canonicalAttestedLiveExecutionEnabled) {
    throw "Web UI deploy refuses canonical LIVE account state with liveExecutionEnabled=false before runtime attestation."
  }
  if ($canonicalAttestedAccountMode -eq "DEMO" -and $canonicalAttestedLiveExecutionEnabled) {
    throw "Web UI deploy refuses canonical DEMO account state with liveExecutionEnabled=true before runtime attestation."
  }

  $attestationConfigIdentity = Get-Phase7CRuntimeSourceConfigIdentity `
    -RuntimeRoot $resolvedWorkDir `
    -AccountMode $canonicalAttestedAccountMode `
    -LiveExecutionEnabled $canonicalAttestedLiveExecutionEnabled `
    -ControlApiUrl $configuredControlApiUrl
  $deployment = Initialize-Phase7CRuntimeSourceDeployment `
    -RuntimeRoot $resolvedWorkDir `
    -SourceCommit $ExpectedCommit `
    -SourceTree $sourceTree `
    -Branch main `
    -ConfigIdentity $attestationConfigIdentity
  Write-Host "PHASE7C_RUNTIME_SOURCE_DEPLOYMENT_ID=$($deployment.deploymentId)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_COMMIT=$($deployment.sourceCommit)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_TREE=$($deployment.sourceTree)"
  Write-Host "PHASE7C_RUNTIME_SOURCE_MANIFEST=READY"

  [void](Assert-LifecycleBrokerSourceFresh -WorkDir $WorkDir)

  & $pnpm.Source --filter '@xauusd/mt5-broker' build
  if ($LASTEXITCODE -ne 0) {
    throw "Phase7C MT5 broker build failed with exit code $LASTEXITCODE. Runtime was not restarted."
  }

  # Prime the exact root Turbo build command used again by the API runtime.
  # This keeps the runtime's mandatory build-before-start contract while ensuring
  # the subsequent task start consumes a warm Turbo cache instead of spending the
  # dashboard readiness window on a duplicate cold dependency-graph build.
  & $pnpm.Source build '--filter=@xauusd/api...'
  if ($LASTEXITCODE -ne 0) {
    throw "Phase7C API dependency graph build failed with exit code $LASTEXITCODE. Runtime was not restarted."
  }
  Write-Host "PHASE7C_WEB_UI_DEPLOY_API_DEPENDENCY_BUILD=PASS"

  & $pnpm.Source --filter '@xauusd/web' build
  if ($LASTEXITCODE -ne 0) {
    throw "Phase7C web build failed with exit code $LASTEXITCODE. Runtime was not restarted."
  }
  Write-Host "PHASE7C_WEB_UI_DEPLOY_BUILD=PASS"

  $dashboardDeployArgs = @()
  if ($AllowOwnedTaskProvenanceMigration) {
    $dashboardDeployArgs += @(
      '-AllowOwnedTaskProvenanceMigration',
      '-ExpectedRunnerSha256', $ExpectedRunnerSha256
    )
  }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DashboardDeploy `
    -WorkDir $WorkDir `
    -WebTask $WebTask `
    -ApiPort $ApiPort `
    -WebPort $WebPort `
    -StartupTimeoutSeconds $StartupTimeoutSeconds `
    -SkipPanelInstall `
    @dashboardDeployArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Safe Phase7C web runtime restart failed with exit code $LASTEXITCODE."
  }

  Write-Host "PHASE7C_WEB_UI_DEPLOY_RUNTIME_RESTART=PASS"
  Write-Host "PHASE7C_WEB_UI_DEPLOY_STATUS=PASS"
}
finally {
  Pop-Location
}