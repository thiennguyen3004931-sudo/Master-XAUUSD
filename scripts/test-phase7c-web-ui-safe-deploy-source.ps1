$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DeployScript = Join-Path $ProjectRoot "scripts\deploy-phase7c-web-ui-local.ps1"
$DashboardDeployScript = Join-Path $ProjectRoot "scripts\deploy-phase7c-mt5-dashboard-local.ps1"
$WorkflowPath = Join-Path $ProjectRoot ".github\workflows\phase7c-web-ui-safe-deploy-ci.yml"

foreach ($path in @($DeployScript, $DashboardDeployScript, $WorkflowPath)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Web UI safe deploy source not found: $path"
  }
}

$Source = Get-Content -LiteralPath $DeployScript -Raw
$DashboardSource = Get-Content -LiteralPath $DashboardDeployScript -Raw
$WorkflowSource = Get-Content -LiteralPath $WorkflowPath -Raw
[void][scriptblock]::Create($Source)
[void][scriptblock]::Create($DashboardSource)

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($Source -notmatch $Pattern) { throw "Missing web UI deploy safety marker: $Label" }
}
function Assert-Literal([string]$Text, [string]$Label) {
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) { throw "Missing web UI deploy literal: $Label" }
}
function Assert-LiteralOrder([string]$Earlier, [string]$Later, [string]$Label) {
  $EarlierIndex = $Source.IndexOf($Earlier, [System.StringComparison]::Ordinal)
  $LaterIndex = $Source.IndexOf($Later, [System.StringComparison]::Ordinal)
  if ($EarlierIndex -lt 0 -or $LaterIndex -lt 0 -or $EarlierIndex -ge $LaterIndex) {
    throw "Invalid web UI deploy literal order: $Label"
  }
}
function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($Source -match $Pattern) { throw "Forbidden web UI deploy pattern detected: $Label" }
}
function Assert-DashboardLiteral([string]$Text, [string]$Label) {
  if ($DashboardSource.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) { throw "Missing account-aware dashboard deploy literal: $Label" }
}
function Assert-DashboardNotContains([string]$Pattern, [string]$Label) {
  if ($DashboardSource -match $Pattern) { throw "Forbidden dashboard deploy pattern detected: $Label" }
}
function Assert-WorkflowContains([string]$Pattern, [string]$Label) {
  if ($WorkflowSource -notmatch $Pattern) { throw "Missing safe deploy workflow marker: $Label" }
}
function Assert-WorkflowNotContains([string]$Pattern, [string]$Label) {
  if ($WorkflowSource -match $Pattern) { throw "Forbidden safe deploy workflow pattern detected: $Label" }
}

Assert-Literal '[Parameter(Mandatory = $true)]' 'ExpectedCommit mandatory parameter guard'
Assert-Literal '[ValidateNotNullOrEmpty()]' 'ExpectedCommit non-empty guard'
Assert-Literal '[string]$ExpectedCommit' 'exact deployment SHA parameter'
Assert-Literal '$branch -ne "main"' 'main branch guard'
Assert-Literal 'Web UI deploy requires branch main.' 'main branch failure reason'
Assert-Literal '$currentCommit = (& $git.Source rev-parse HEAD).Trim()' 'current HEAD capture'
Assert-Literal '$currentCommit -ne $ExpectedCommit' 'exact HEAD equality guard'
Assert-Literal 'PHASE7C_WEB_UI_DEPLOY_EXPECTED_COMMIT=$ExpectedCommit' 'exact SHA audit marker'
Assert-Literal 'git working tree' 'clean working tree guard'

# Lifecycle broker is a long-running SYSTEM PowerShell process. It dot-sources these
# helpers once at startup, so a Web/API deployment must fail before any build when
# the checked-out startup-loaded source is newer than the running broker process.
Assert-Literal 'run-phase7c-executor-task-runner-local.ps1' 'lifecycle broker runner freshness input'
Assert-Literal 'lib\phase7c-startup-runner-guard.ps1' 'startup runner guard freshness input'
Assert-Literal 'lib\phase7c-account-mode.ps1' 'account-mode/risk validator freshness input'
Assert-Literal 'lib\phase7c-lifecycle-broker.ps1' 'lifecycle broker protocol freshness input'
Assert-Literal 'phase7c-lifecycle-broker\state\heartbeat.json' 'broker heartbeat freshness evidence'
Assert-Literal 'phase7c-lifecycle-broker\logs\broker.log' 'broker boot log freshness evidence'
Assert-Literal 'Lifecycle broker starting. PID=$brokerPid' 'broker boot PID marker'
Assert-Literal '[DateTimeOffset]::Parse' 'broker boot timestamp parsing'
Assert-Literal 'LastWriteTimeUtc' 'loaded lifecycle source timestamp comparison'
Assert-Literal 'PHASE7C_WEB_UI_DEPLOY_BROKER_SOURCE_FRESH=PASS' 'broker freshness pass marker'
Assert-Literal '[void](Assert-LifecycleBrokerSourceFresh -WorkDir $WorkDir)' 'broker freshness preflight invocation'
Assert-Literal '[int]$MaxReadAttempts = 5' 'bounded JSON read retry attempts'
Assert-Literal '[int]$RetryDelayMilliseconds = 100' 'bounded JSON read retry delay'
Assert-Literal 'catch [System.IO.IOException]' 'transient lifecycle heartbeat sharing violation retry'
Assert-Literal 'Start-Sleep -Milliseconds $RetryDelayMilliseconds' 'bounded sharing violation backoff'
Assert-Literal 'if ($attempt -ge $MaxReadAttempts)' 'bounded JSON read retry exhaustion guard'
Assert-Literal '$raw | ConvertFrom-Json' 'JSON parse occurs after successful file read'
Assert-LiteralOrder 'catch [System.IO.IOException]' '$raw | ConvertFrom-Json' 'sharing retry must complete before JSON validity check'
Assert-LiteralOrder '[void](Assert-LifecycleBrokerSourceFresh -WorkDir $WorkDir)' "--filter '@xauusd/mt5-broker' build" 'broker freshness must pass before any build/runtime restart'

Assert-Literal "--filter '@xauusd/mt5-broker' build" 'mt5 broker build before web build'
Assert-Contains '(?ms)&\s+\$pnpm\.Source\s+--filter\s+''@xauusd/mt5-broker''\s+build\s*if\s*\(\$LASTEXITCODE\s+-ne\s+0\)\s*\{' 'mt5 broker build fail-fast guard'

$ApiTurboPrimeLiteral = "& `$pnpm.Source build '--filter=@xauusd/api...'"
$LegacyApiPrebuildLiteral = "& `$pnpm.Source --filter '@xauusd/api...' build"
Assert-Literal $ApiTurboPrimeLiteral 'API dependency graph Turbo prebuild before dashboard restart'
Assert-Contains '(?ms)&\s+\$pnpm\.Source\s+build\s+''--filter=@xauusd/api\.\.\.''\s*if\s*\(\$LASTEXITCODE\s+-ne\s+0\)\s*\{' 'API dependency graph Turbo prebuild fail-fast guard'
if ($Source.IndexOf($LegacyApiPrebuildLiteral, [System.StringComparison]::Ordinal) -ge 0) {
  throw 'Forbidden web UI deploy literal: workspace-direct API prebuild bypasses runtime Turbo cache'
}
Assert-Literal 'PHASE7C_WEB_UI_DEPLOY_API_DEPENDENCY_BUILD=PASS' 'API dependency graph prebuild pass marker'
Assert-LiteralOrder "--filter '@xauusd/mt5-broker' build" "--filter '@xauusd/web' build" 'mt5 broker build precedes web build'
Assert-LiteralOrder "--filter '@xauusd/mt5-broker' build" $ApiTurboPrimeLiteral 'mt5 broker build precedes API dependency graph Turbo prebuild'
Assert-LiteralOrder $ApiTurboPrimeLiteral "--filter '@xauusd/web' build" 'API dependency graph Turbo prebuild precedes web build'
Assert-Literal "--filter '@xauusd/web' build" 'web build before restart'
Assert-Literal 'deploy-phase7c-mt5-dashboard-local.ps1' 'reuse verified dashboard restart helper'
Assert-Literal '-SkipPanelInstall' 'web-only restart path'
Assert-Literal 'PHASE7C_WEB_UI_DEPLOY_BUILD=PASS' 'build pass marker'
Assert-Literal 'PHASE7C_WEB_UI_DEPLOY_RUNTIME_RESTART=PASS' 'runtime restart marker'
Assert-Literal 'PHASE7C_WEB_UI_DEPLOY_STATUS=PASS' 'final pass marker'
Assert-NotContains 'fix/phase7c-legacy-background-cleanup' 'legacy integration branch guard'
Assert-NotContains '\$RequiredCommit\b' 'legacy optional pinned commit contract'
Assert-NotContains 'activate-phase7c-local\.ps1' 'must not run full activation'
Assert-NotContains 'run-phase7c-executors' 'must not start or stop executors directly'
Assert-NotContains 'switch-phase7c-account-mode' 'must not switch account mode'
Assert-NotContains 'git\s+(reset|clean|checkout)' 'must not mutate git working tree destructively'
Assert-NotContains 'git\s+pull' 'deploy helper must not self-update while running'
Assert-NotContains 'LIVE_EXECUTION|MT5_ALLOW_REAL_ACCOUNT' 'must not enable LIVE execution'

Assert-WorkflowContains '(?ms)push:\s*branches:\s*- main\s*paths:' 'safe deploy CI push targets main'
Assert-WorkflowContains '(?ms)pull_request:\s*branches:\s*- main\s*paths:' 'safe deploy CI PR targets main'
Assert-WorkflowNotContains 'fix/phase7c-legacy-background-cleanup' 'legacy safe deploy CI base branch'
Assert-WorkflowNotContains 'feat/phase7c-web-ui-safe-deploy' 'legacy safe deploy CI push branch'

Assert-DashboardLiteral 'Read-UiAccountMode' 'derive selected DEMO/LIVE from read-only UI contract'
Assert-DashboardLiteral '$expectedAccountMode -notin @("DEMO", "LIVE")' 'only DEMO/LIVE accepted'
Assert-DashboardLiteral 'mt5OrderPermission=NONE' 'panel remains read-only'
Assert-DashboardLiteral 'PHASE7C_DASHBOARD_DEPLOY_ACCOUNT_MODE=$expectedAccountMode' 'selected account marker'
Assert-DashboardLiteral 'PHASE7C_DASHBOARD_DEPLOY_MODE_PRESERVED=$preservedMode' 'bot mode preservation'
Assert-DashboardLiteral 'PHASE7C_DASHBOARD_DEPLOY_EXECUTORS_UNCHANGED=PASS' 'executor PID preservation'
Assert-DashboardLiteral 'PHASE7C_DASHBOARD_DEPLOY_LIVE_ARM_FILE_PRESERVED=$armFileAfter' 'LIVE arm file preservation'
Assert-DashboardLiteral 'verify-phase7c-account-runtime-local.ps1' 'account-aware strict verifier'
Assert-DashboardLiteral '-ExpectedAccountMode $expectedAccountMode' 'strict verifier expected mode'
Assert-DashboardLiteral 'autoReason1=' 'new AUTO semantic reason contract'
Assert-DashboardLiteral 'trendWaitReason1=' 'new Trend wait reason contract'
Assert-DashboardLiteral 'sidewayWaitReason1=' 'new Sideway wait reason contract'
Assert-DashboardNotContains 'preflight requires DEMO account' 'legacy DEMO-only deploy guard'
Assert-DashboardNotContains '(?m)\^accountMode=DEMO\$' 'hard-coded DEMO readiness check'
Assert-DashboardNotContains 'switch-phase7c-account-mode' 'dashboard deploy must not switch accounts'
Assert-DashboardNotContains 'arm-phase7c-live|disarm-phase7c-live' 'dashboard deploy must not alter LIVE arm'

if ($env:OS -eq 'Windows_NT') {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$parseErrors)
  if (@($parseErrors).Count -gt 0) {
    throw "Web UI deploy source could not be parsed for Read-JsonFile behavior test."
  }
  $readJsonFunction = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq 'Read-JsonFile'
  }, $true)
  if ($null -eq $readJsonFunction) {
    throw "Read-JsonFile function was not found for behavior test."
  }
  Invoke-Expression $readJsonFunction.Extent.Text

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-json-read-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $jsonPath = Join-Path $tempRoot 'heartbeat.json'
  $readyPath = Join-Path $tempRoot 'lock-ready.txt'
  try {
    Set-Content -LiteralPath $jsonPath -Value '{"brokerPid":12345}' -Encoding UTF8
    $lockJob = Start-Job -ArgumentList $jsonPath, $readyPath -ScriptBlock {
      param($Path, $ReadyPath)
      $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
      try {
        Set-Content -LiteralPath $ReadyPath -Value 'READY' -Encoding ASCII
        Start-Sleep -Milliseconds 250
      } finally {
        $stream.Dispose()
      }
    }

    $deadline = (Get-Date).AddSeconds(5)
    while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 25
    }
    if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
      throw "Could not establish the transient heartbeat sharing-violation fixture."
    }

    $result = Read-JsonFile -Path $jsonPath -Label 'Lifecycle broker heartbeat'
    if ([int]$result.brokerPid -ne 12345) {
      throw "Read-JsonFile did not recover from the transient heartbeat sharing violation."
    }
    Wait-Job -Job $lockJob -Timeout 5 | Out-Null
    Remove-Job -Job $lockJob -Force -ErrorAction SilentlyContinue
    Write-Host "PHASE7C_WEB_UI_HEARTBEAT_CONTENTION_RETRY_TEST=PASS"

    Set-Content -LiteralPath $jsonPath -Value '{invalid-json' -Encoding UTF8
    $invalidFailedClosed = $false
    try {
      [void](Read-JsonFile -Path $jsonPath -Label 'Lifecycle broker heartbeat')
    } catch {
      $invalidFailedClosed = $_.Exception.Message -match 'file is invalid'
    }
    if (-not $invalidFailedClosed) {
      throw "Read-JsonFile must fail closed for malformed JSON after a successful file read."
    }
    Write-Host "PHASE7C_WEB_UI_INVALID_JSON_FAIL_CLOSED_TEST=PASS"
  } finally {
    Get-Job | Where-Object { $_.State -ne 'Completed' } | Stop-Job -ErrorAction SilentlyContinue
    Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "PHASE7C_WEB_UI_SAFE_DEPLOY_SOURCE_TEST=PASS"
