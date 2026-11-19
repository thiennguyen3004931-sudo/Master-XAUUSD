$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DeployScript = Join-Path $ProjectRoot "scripts\deploy-phase7c-mt5-dashboard-local.ps1"

if (-not (Test-Path -LiteralPath $DeployScript)) {
  throw "Dashboard deploy source not found: $DeployScript"
}

$Source = Get-Content -LiteralPath $DeployScript -Raw
[void][scriptblock]::Create($Source)

function Assert-Contains([string]$Pattern, [string]$Label) {
  if ($Source -notmatch $Pattern) {
    throw "Missing dashboard deploy safety marker: $Label"
  }
}

function Assert-Literal([string]$Text, [string]$Label) {
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing dashboard deploy literal: $Label"
  }
}

function Assert-NotContains([string]$Pattern, [string]$Label) {
  if ($Source -match $Pattern) {
    throw "Forbidden dashboard deploy pattern detected: $Label"
  }
}

Assert-Contains 'function\s+Test-ProjectCoreCommand' 'project process ownership check'
Assert-Contains 'function\s+Get-VerifiedCoreRoots' 'verified core root discovery'
Assert-Contains 'function\s+Test-DescendantOfRoot' 'protected executor tree check'
Assert-Contains 'function\s+Read-UiAccountMode' 'selected account mode reader'
Assert-Contains 'function\s+Wait-TelegramRecoveryAfterApiRestart' 'Telegram recovery wait after Control API restart'
Assert-Contains 'Unrecognized owner for localhost port' 'fail closed on unknown listener'
Assert-Contains 'Safety block: core root PID=' 'executor ancestry safety block'
Assert-Contains 'run-phase7c-executors\|trend-executor\|sideway-executor' 'executor command marker block'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_EXECUTOR_TREE_ISOLATION=PASS' 'tree isolation marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_PORT_RELEASE=PASS' 'port release marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_ACCOUNT_MODE=' 'account preservation marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_MODE_PRESERVED=' 'bot mode preservation marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_EXECUTORS_UNCHANGED=PASS' 'executor PID preservation marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_LIVE_ARM_FILE_PRESERVED=' 'LIVE arm state preservation marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_TELEGRAM_RECOVERY_WAIT=START' 'Telegram recovery wait start marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_TELEGRAM_RECOVERY_WAIT=PASS' 'Telegram recovery wait pass marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_TELEGRAM_RECOVERY_WAIT=TIMEOUT' 'Telegram recovery wait timeout marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_ACCOUNT_VERIFY=PASS' 'account-aware strict verification marker'
Assert-Contains 'PHASE7C_DASHBOARD_DEPLOY_STATUS=PASS' 'final deploy marker'
Assert-Literal '(?m)^accountMode=(DEMO|LIVE)$' 'DEMO/LIVE account parser'
Assert-Literal '$expectedAccountMode -notin @("DEMO", "LIVE")' 'only DEMO or LIVE deploy target accepted'
Assert-Literal '(?m)^readOnly=true$' 'read-only dashboard contract'
Assert-Literal '(?m)^mt5OrderPermission=NONE$' 'no MT5 order permission'
Assert-Literal 'install-phase7c-mt5-decision-panel-local.ps1' 'panel installer call'
Assert-Literal 'verify-phase7c-account-runtime-local.ps1' 'account-aware strict verifier call'
Assert-Literal '-ExpectedAccountMode $expectedAccountMode' 'strict verifier target mode'
Assert-Literal '-RequireTelegram' 'strict verifier Telegram flag remains mandatory'
Assert-Literal 'Wait-TelegramRecoveryAfterApiRestart -TimeoutSeconds 45' 'bounded Telegram recovery wait'
Assert-NotContains 'activate-phase7c-local\.ps1' 'full activation must not be used'
Assert-NotContains 'XAUUSD-Phase7C-Executors' 'executor scheduled task must not be touched'
Assert-NotContains 'switch-phase7c-account-mode' 'account switch must not be used'
Assert-NotContains 'arm-phase7c-live|disarm-phase7c-live' 'LIVE arm mutation must not be used'
Assert-NotContains 'Start-Process.*telegram|Stop-Process.*telegram|taskkill.*telegram' 'deploy must not restart or kill Telegram process'
Assert-NotContains '\[int\]\$Pid(?:\W|$)' 'reserved automatic PID variable parameter'
Assert-NotContains '\(\?m\)\^accountMode=DEMO\$' 'legacy DEMO-only deploy assertion'

Write-Host "PHASE7C_DASHBOARD_SAFE_DEPLOY_SOURCE_TEST=PASS"