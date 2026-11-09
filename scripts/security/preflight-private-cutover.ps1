param(
  [Parameter(Mandatory = $true)] [string]$ExpectedCommit,
  [string]$ExpectedTree = "",
  [Parameter(Mandatory = $true)] [string]$RuntimeProjectRoot,
  [string]$WorkDir = ".runtime",
  [string]$ControlApiUrl = "http://127.0.0.1:3711"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$CandidateSourceRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$AccountLibrary = Join-Path $CandidateSourceRoot "scripts\lib\phase7c-account-mode.ps1"
$M7AcceptanceScript = Join-Path $CandidateSourceRoot "scripts\security\accept-master-core-split.mjs"
$CanonicalDeployScript = Join-Path $CandidateSourceRoot "scripts\recover-phase7c-runtime-ready-stable-deploy-local.ps1"
$CanonicalM7Merge = "144c123dd7905a4c52522435747572448d798d84"
$ExpectedPrivateOrigin = "thiennguyen3004931-sudo/xauusd-ai-master-core"
$RequiredRuntimeComponents = @(
  'api',
  'web',
  'lifecycle-broker',
  'supervisor',
  'trend',
  'sideway',
  'telegram',
  'regime-notifier'
)

function Write-Verdict([string]$Name, [string]$Value) {
  Write-Host "$Name=$Value"
}

function Invoke-Git([string[]]$Arguments) {
  $output = & git -C $CandidateSourceRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join ' ')"
  }
  return ([string]($output -join "`n")).Trim()
}

function Read-Json([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "$Label is invalid JSON: $Path. $($_.Exception.Message)"
  }
}

function Invoke-ApiGet([string]$Path) {
  return Invoke-RestMethod -Uri "$($ControlApiUrl.TrimEnd('/'))$Path" -Method Get -TimeoutSec 8
}

function Resolve-PathFromRoot([string]$Root, [string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
}

function Assert-LoopbackControlApi([string]$Url) {
  $uri = $null
  try {
    $uri = [System.Uri]$Url
  } catch {
    throw "ControlApiUrl must be a valid absolute localhost HTTP URL. actual=$Url"
  }
  if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'http') {
    throw "ControlApiUrl must use absolute localhost HTTP. actual=$Url"
  }
  $hostName = ([string]$uri.DnsSafeHost).ToLowerInvariant()
  if ($hostName -notin @('127.0.0.1', 'localhost', '::1')) {
    throw "ControlApiUrl must remain localhost-only. actualHost=$hostName"
  }
}

function Read-BridgeArray([string]$Base, [hashtable]$Headers, [string]$Path) {
  $response = Invoke-WebRequest -Uri "$Base$Path" -Headers $Headers -Method Get -UseBasicParsing -TimeoutSec 8
  $raw = ([string]$response.Content).Trim()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq "[]") { return @() }
  return @($raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
}

Write-Verdict "M8_PRIVATE_CUTOVER_PREFLIGHT" "START"
Write-Verdict "READ_ONLY" "TRUE"
Write-Verdict "HTTP_METHODS" "GET_ONLY"
Write-Verdict "GIT_MUTATION" "NONE"
Write-Verdict "TASK_MUTATION" "NONE"
Write-Verdict "PROCESS_MUTATION" "NONE"
Write-Verdict "MODE_MUTATION" "NONE"
Write-Verdict "ARM_MUTATION" "NONE"
Write-Verdict "ORDER_MUTATION" "NONE"
Write-Verdict "POSITION_MUTATION" "NONE"
Write-Verdict "LIVE_TEST_ORDER" "NONE"
Write-Verdict "PRODUCTION_CUTOVER" "NOT_PERFORMED"

try {
  if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "ExpectedCommit must be an exact 40-character Git SHA."
  }
  $ExpectedCommit = $ExpectedCommit.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTree)) {
    if ($ExpectedTree -notmatch '^[0-9a-fA-F]{40}$') {
      throw "ExpectedTree must be empty or an exact 40-character Git tree SHA."
    }
    $ExpectedTree = $ExpectedTree.ToLowerInvariant()
  }

  if ([string]::IsNullOrWhiteSpace($RuntimeProjectRoot)) {
    throw "RuntimeProjectRoot is required and must point at the current production project root."
  }
  if (-not (Test-Path -LiteralPath $RuntimeProjectRoot -PathType Container)) {
    throw "RuntimeProjectRoot is missing: $RuntimeProjectRoot"
  }
  $RuntimeProjectRootResolved = (Resolve-Path -LiteralPath $RuntimeProjectRoot).Path
  if ([string]::Equals($CandidateSourceRoot, $RuntimeProjectRootResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Candidate source root must be separate from RuntimeProjectRoot. root=$CandidateSourceRoot"
  }

  Write-Verdict "CANDIDATE_SOURCE_ROOT" $CandidateSourceRoot
  Write-Verdict "RUNTIME_PROJECT_ROOT" $RuntimeProjectRootResolved

  $ExecutorConfigPath = Join-Path $RuntimeProjectRootResolved ".runtime\phase7c-executor-task-config.json"
  foreach ($required in @($AccountLibrary, $ExecutorConfigPath, $M7AcceptanceScript, $CanonicalDeployScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "M8 required canonical file is missing: $required"
    }
  }

  . $AccountLibrary

  $head = (Invoke-Git @('rev-parse', 'HEAD')).ToLowerInvariant()
  $tree = (Invoke-Git @('rev-parse', 'HEAD^{tree}')).ToLowerInvariant()
  $branch = Invoke-Git @('branch', '--show-current')
  $status = Invoke-Git @('status', '--porcelain')
  $origin = Invoke-Git @('remote', 'get-url', 'origin')

  if ($head -ne $ExpectedCommit) {
    throw "Private cutover source HEAD mismatch. expected=$ExpectedCommit actual=$head"
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedTree) -and $tree -ne $ExpectedTree) {
    throw "Private cutover source tree mismatch. expected=$ExpectedTree actual=$tree"
  }
  if ($branch -ne 'main') {
    throw "Private cutover source must be checked out on main. actual=$branch"
  }
  if (-not [string]::IsNullOrWhiteSpace($status)) {
    throw "Private cutover source worktree must be clean."
  }
  if ($origin -notmatch [regex]::Escape($ExpectedPrivateOrigin)) {
    throw "Private cutover origin is not the canonical private repository. origin=$origin"
  }

  & git -C $CandidateSourceRoot merge-base --is-ancestor $CanonicalM7Merge HEAD *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Expected private target does not contain the accepted M7 merge baseline $CanonicalM7Merge."
  }

  Write-Verdict "PRIVATE_SOURCE_ORIGIN" "PASS"
  Write-Verdict "PRIVATE_SOURCE_BRANCH" "main"
  Write-Verdict "PRIVATE_SOURCE_HEAD" $head
  Write-Verdict "PRIVATE_SOURCE_TREE" $tree
  Write-Verdict "PRIVATE_SOURCE_WORKTREE" "CLEAN"
  Write-Verdict "M7_ACCEPTED_BASELINE" "PASS"

  $executorConfig = Read-Json -Path $ExecutorConfigPath -Label "Executor task config"
  if ([int]$executorConfig.version -ne 2) {
    throw "Executor task config version 2 is required."
  }

  $configuredWorkDir = Resolve-PathFromRoot -Root $RuntimeProjectRootResolved -Path ([string]$executorConfig.workDir)
  $requestedWorkDir = Resolve-PathFromRoot -Root $RuntimeProjectRootResolved -Path $WorkDir
  if (-not [string]::Equals($configuredWorkDir, $requestedWorkDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "WorkDir does not match canonical executor config. configured=$configuredWorkDir requested=$requestedWorkDir"
  }
  if (-not (Test-Path -LiteralPath $requestedWorkDir -PathType Container)) {
    throw "Runtime WorkDir is missing: $requestedWorkDir"
  }

  $configuredControlApiUrl = ([string]$executorConfig.controlApiUrl).TrimEnd('/')
  if ([string]::IsNullOrWhiteSpace($configuredControlApiUrl)) {
    throw "Executor task config controlApiUrl is missing."
  }
  Assert-LoopbackControlApi -Url $ControlApiUrl
  if (-not [string]::Equals($configuredControlApiUrl, $ControlApiUrl.TrimEnd('/'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ControlApiUrl does not match canonical executor config. configured=$configuredControlApiUrl requested=$ControlApiUrl"
  }

  $runtimeAttestation = Invoke-ApiGet "/api/v1/phase7c/runtime-source-attestation"
  if ($null -eq $runtimeAttestation) {
    throw "Canonical runtime-source attestation API returned no evidence."
  }
  if ([string]$runtimeAttestation.source -ne 'PHASE7C_RUNTIME_SOURCE_ATTESTATION') {
    throw "Unexpected runtime-source attestation source. actual=$($runtimeAttestation.source)"
  }
  if (-not [bool]$runtimeAttestation.readOnly) {
    throw "Runtime-source attestation API must report readOnly=true."
  }
  if ([string]$runtimeAttestation.overall -ne 'EXACT_MATCH') {
    $runtimeVerdicts = @($runtimeAttestation.components | ForEach-Object { "$($_.component):$($_.verdict)" }) -join ','
    throw "Current runtime generation attestation is not EXACT_MATCH. overall=$($runtimeAttestation.overall) components=$runtimeVerdicts"
  }

  $runtimeDeployment = $runtimeAttestation.deployment
  if ($null -eq $runtimeDeployment) {
    throw "Runtime-source attestation is missing deployment identity."
  }
  $runtimeCommit = ([string]$runtimeDeployment.sourceCommit).ToLowerInvariant()
  $runtimeTree = ([string]$runtimeDeployment.sourceTree).ToLowerInvariant()
  $runtimeDeploymentId = ([string]$runtimeDeployment.deploymentId).ToLowerInvariant()
  if ($runtimeCommit -notmatch '^[0-9a-f]{40}$' -or $runtimeTree -notmatch '^[0-9a-f]{40}$' -or $runtimeDeploymentId -notmatch '^[0-9a-f]{32}$') {
    throw "Runtime-source attestation deployment identity is invalid."
  }

  foreach ($component in $RequiredRuntimeComponents) {
    $matches = @($runtimeAttestation.components | Where-Object { [string]$_.component -eq $component })
    if ($matches.Count -ne 1) {
      throw "Runtime-source attestation must contain exactly one '$component' component. actual=$($matches.Count)"
    }
    $componentEvidence = $matches[0]
    if ([string]$componentEvidence.verdict -ne 'EXACT_MATCH') {
      throw "Runtime-source component is not EXACT_MATCH. component=$component verdict=$($componentEvidence.verdict)"
    }
    if (-not [string]::Equals([string]$componentEvidence.sourceCommit, $runtimeCommit, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Runtime-source component commit mismatch. component=$component"
    }
    if (-not [string]::Equals([string]$componentEvidence.deploymentId, $runtimeDeploymentId, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Runtime-source component deploymentId mismatch. component=$component"
    }
  }

  if ($null -eq $runtimeAttestation.safety -or -not [bool]$runtimeAttestation.safety.readOnly) {
    throw "Runtime-source attestation safety contract must be read-only."
  }
  foreach ($property in @('modeMutation', 'armMutation', 'autoGate', 'lifecycleGate', 'orderMutation', 'positionMutation', 'strategyMutation', 'autoRetune')) {
    $safetyProperty = $runtimeAttestation.safety.PSObject.Properties[$property]
    if ($null -eq $safetyProperty) {
      throw "Runtime-source attestation safety field is missing: $property"
    }
    if ([bool]$safetyProperty.Value) {
      throw "Runtime-source attestation safety field must remain false: $property"
    }
  }

  Write-Verdict "CURRENT_RUNTIME_DEPLOYMENT_ID" $runtimeDeploymentId
  Write-Verdict "CURRENT_RUNTIME_SOURCE_COMMIT" $runtimeCommit
  Write-Verdict "CURRENT_RUNTIME_SOURCE_TREE" $runtimeTree
  Write-Verdict "CURRENT_RUNTIME_COMPONENT_ATTESTATION" "EXACT"
  Write-Verdict "CURRENT_RUNTIME_SOURCE_COHERENCE" "PASS"

  $bot = Invoke-ApiGet "/api/v1/phase7c/bot-mode"
  if ([string]$bot.state.mode -ne 'PAUSE') {
    throw "M8 cutover preflight requires bot mode PAUSE. actual=$($bot.state.mode)"
  }

  $arm = Invoke-ApiGet "/api/v1/phase7c-live-arm-control/capability"
  if ([bool]$arm.liveExecutionArmed) {
    throw "M8 cutover preflight requires liveExecutionArmed=false."
  }
  if ([string]$arm.accountMode -eq 'LIVE' -and [string]$arm.liveArmStatus -ne 'DISARMED') {
    throw "M8 cutover preflight requires LIVE arm DISARMED. actual=$($arm.liveArmStatus)"
  }

  $lifecycle = Invoke-ApiGet "/api/v1/phase7c/lifecycle"
  if (-not [bool]$lifecycle.running -or -not [bool]$lifecycle.ready) {
    throw "M8 cutover preflight requires lifecycle running=true and ready=true."
  }

  Write-Verdict "BOT_MODE" "PAUSE"
  Write-Verdict "LIVE_EXECUTION_ARMED" "FALSE"
  Write-Verdict "LIFECYCLE_RUNNING" "TRUE"
  Write-Verdict "LIFECYCLE_READY" "TRUE"

  $envFile = Resolve-PathFromRoot -Root $RuntimeProjectRootResolved -Path ([string]$executorConfig.envFile)
  $accountMode = ConvertTo-Phase7CAccountMode ([string]$executorConfig.accountMode)
  $envInfo = Assert-Phase7CAccountEnv -EnvFile $envFile -AccountMode $accountMode -RequireTrading
  $bridgeBase = "http://$($envInfo.bridgeHost):$($envInfo.bridgePort)"
  $bridgeHeaders = @{ "x-mt5-api-key" = $envInfo.apiKey }
  $bridgeHealth = Invoke-RestMethod -Uri "$bridgeBase/health" -Headers $bridgeHeaders -Method Get -TimeoutSec 8
  if (-not [bool]$bridgeHealth.connected -or [string]$bridgeHealth.status -ne 'ok') {
    throw "MT5 bridge is not healthy."
  }

  $positions = @(Read-BridgeArray -Base $bridgeBase -Headers $bridgeHeaders -Path "/v1/positions?symbol=XAUUSD")
  $orders = @(Read-BridgeArray -Base $bridgeBase -Headers $bridgeHeaders -Path "/v1/orders?symbol=XAUUSD")
  if ($positions.Count -ne 0 -or $orders.Count -ne 0) {
    throw "M8 cutover preflight requires flat XAUUSD state. positions=$($positions.Count) pendingOrders=$($orders.Count)"
  }

  Write-Verdict "MT5_BRIDGE_HEALTH" "PASS"
  Write-Verdict "XAUUSD_POSITIONS" "0"
  Write-Verdict "XAUUSD_PENDING_ORDERS" "0"

  $targetAlreadyRunning =
    [string]::Equals($runtimeCommit, $head, [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($runtimeTree, $tree, [System.StringComparison]::OrdinalIgnoreCase)

  Write-Verdict "TARGET_ALREADY_RUNNING" ($(if ($targetAlreadyRunning) { 'TRUE' } else { 'FALSE' }))
  Write-Verdict "TARGET_SOURCE_VERIFIED" "PASS"
  Write-Verdict "RUNTIME_SAFETY_STATE" "PASS"
  Write-Verdict "CUTOVER_READY" "TRUE"
  Write-Verdict "PRODUCTION_CUTOVER" "NOT_PERFORMED"
  Write-Verdict "M8_PRIVATE_CUTOVER_PREFLIGHT" "PASS"
  exit 0
} catch {
  Write-Host "M8_ERROR=$($_.Exception.Message)"
  Write-Verdict "CUTOVER_READY" "FALSE"
  Write-Verdict "PRODUCTION_CUTOVER" "NOT_PERFORMED"
  Write-Verdict "M8_PRIVATE_CUTOVER_PREFLIGHT" "FAIL"
  exit 1
}
