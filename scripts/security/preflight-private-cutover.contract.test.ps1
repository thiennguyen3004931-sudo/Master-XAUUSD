$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$PreflightPath = Join-Path $PSScriptRoot 'preflight-private-cutover.ps1'
$PlanPath = Join-Path $ProjectRoot 'docs\superpowers\plans\2026-09-15-private-master-production-cutover.md'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

foreach ($required in @($PreflightPath, $PlanPath)) {
  Assert-True (Test-Path -LiteralPath $required -PathType Leaf) "Required M8 artifact missing: $required"
}

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($PreflightPath, [ref]$tokens, [ref]$errors)
Assert-True ($errors.Count -eq 0) "M8 preflight PowerShell syntax must parse cleanly. errors=$($errors.Count)"

$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
foreach ($requiredParameter in @('ExpectedCommit', 'ExpectedTree', 'RuntimeProjectRoot', 'WorkDir', 'ControlApiUrl')) {
  Assert-True ($parameterNames -contains $requiredParameter) "M8 preflight must expose parameter: $requiredParameter"
}

$script = Get-Content -LiteralPath $PreflightPath -Raw
$plan = Get-Content -LiteralPath $PlanPath -Raw

Assert-True ($script -match '/api/v1/phase7c/runtime-source-attestation') 'M8 preflight must consume canonical runtime-source attestation through the localhost GET API.'
Assert-True ($script -match 'EXACT_MATCH') 'M8 preflight must require EXACT_MATCH runtime-source attestation.'
Assert-True ($script -match "'web'") 'M8 preflight runtime-source contract must include the web component.'
Assert-True ($script -match '\$RuntimeProjectRoot') 'M8 preflight must read production runtime evidence from an explicit RuntimeProjectRoot boundary.'
Assert-True ($script -match 'CANDIDATE_SOURCE_ROOT') 'M8 preflight must print the candidate source root separately from the production runtime root.'
Assert-True ($script -match 'RUNTIME_PROJECT_ROOT') 'M8 preflight must print the production runtime root separately from the candidate source root.'

$forbiddenGitMutations = @(
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\bcheckout\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\bswitch\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\bpull\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\bfetch\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\breset\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\brebase\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\bclean\b',
  '(?im)^\s*(?:&\s*)?git\b[^\r\n]*\bremote\s+set-url\b'
)
foreach ($pattern in $forbiddenGitMutations) {
  Assert-True (-not [regex]::IsMatch($script, $pattern)) "M8 preflight contains forbidden Git mutation matching: $pattern"
}

Assert-True ($plan -match 'candidate checkout') 'M8 rollout plan must explicitly use a separate candidate checkout before cutover.'
Assert-True ($plan -match 'RuntimeProjectRoot') 'M8 rollout plan must document the explicit production RuntimeProjectRoot boundary.'
Assert-True ($plan -match 'must not checkout, pull, fetch, reset, switch, or rewrite the production source worktree before CUTOVER_READY=TRUE') 'M8 rollout plan must explicitly prohibit production source mutation before read-only preflight passes.'

Write-Host 'M8_PRIVATE_CUTOVER_CONTRACT_TEST=PASS'
