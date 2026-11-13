$ErrorActionPreference = "Stop"
$PSDefaultParameterValues['Get-Content:Encoding'] = 'UTF8'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

$files = @{
  register = Join-Path $ProjectRoot "scripts\register-phase7c-account-switch-task-local.ps1"
  runner = Join-Path $ProjectRoot "scripts\run-phase7c-account-switch-task-runner-local.ps1"
  service = Join-Path $ProjectRoot "apps\api\src\services\phase7c-account-switch.service.ts"
  route = Join-Path $ProjectRoot "apps\api\src\routes\phase7c-account-switch.route.ts"
  app = Join-Path $ProjectRoot "apps\api\src\app.ts"
  web = Join-Path $ProjectRoot "apps\web\src\ui\Phase7CAccountSwitchCard.tsx"
  page = Join-Path $ProjectRoot "apps\web\src\pages\Phase7CAccountRiskPage.tsx"
  router = Join-Path $ProjectRoot "apps\web\src\router.tsx"
}
foreach ($entry in $files.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $entry.Value)) { throw "Missing guarded account-switch source: $($entry.Key) $($entry.Value)" }
}

$register = Get-Content -LiteralPath $files.register -Raw
$runner = Get-Content -LiteralPath $files.runner -Raw
$service = Get-Content -LiteralPath $files.service -Raw
$route = Get-Content -LiteralPath $files.route -Raw
$app = Get-Content -LiteralPath $files.app -Raw
$web = Get-Content -LiteralPath $files.web -Raw
$page = Get-Content -LiteralPath $files.page -Raw
$router = Get-Content -LiteralPath $files.router -Raw

[void][scriptblock]::Create($register)
[void][scriptblock]::Create($runner)

function Assert-Contains([string]$Source, [string]$Pattern, [string]$Label) {
  if ($Source -notmatch $Pattern) { throw "Missing guarded account-switch marker: $Label" }
}
function Assert-Literal([string]$Source, [string]$Text, [string]$Label) {
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) { throw "Missing guarded account-switch literal: $Label" }
}
function Assert-NotContains([string]$Source, [string]$Pattern, [string]$Label) {
  if ($Source -match $Pattern) { throw "Forbidden guarded account-switch pattern: $Label" }
}

Assert-Literal $register 'XAUUSD-Phase7C-Account-Switch' 'fixed elevated task name'
Assert-Literal $register 'run-phase7c-account-switch-task-runner-local.ps1' 'fixed task runner'
Assert-Contains $register 'RunLevel\s+Highest' 'RunLevel Highest'
Assert-Contains $register 'requires Administrator privileges|PowerShell Administrator' 'administrator registration guard'
Assert-NotContains $register 'New-ScheduledTaskTrigger' 'switch task must have no automatic trigger'

Assert-Contains $runner 'Administrator' 'runner administrator guard'
Assert-Literal $runner 'source -ne "LOCAL_WEB"' 'strict local web request source'
Assert-Literal $runner 'SWITCH_TO_LIVE' 'typed LIVE confirmation'
Assert-Literal $runner 'SWITCH_TO_DEMO' 'typed DEMO confirmation'
Assert-Contains $runner 'ageMs.*60000|60000.*ageMs' 'request TTL'
Assert-Literal $runner 'phase7c-execution.lock' 'execution lock guard'
Assert-Literal $runner 'pendingPullback' 'Trend pending pullback guard'
Assert-Literal $runner 'pendingEntry' 'Sideway pending entry guard'
Assert-Literal $runner '/v1/positions?symbol=XAUUSD' 'flat broker position check'
Assert-Literal $runner '/v1/orders?symbol=XAUUSD' 'flat broker pending order check'
Assert-Literal $runner 'switch-phase7c-live-guarded-local.ps1' 'canonical guarded DEMO to LIVE switch'
Assert-Literal $runner 'disarm-phase7c-live-local.ps1' 'explicit LIVE disarm before DEMO'
Assert-Literal $runner 'switch-phase7c-account-mode-local.ps1' 'canonical LIVE to DEMO switch'
Assert-Literal $runner 'verify-phase7c-account-runtime-local.ps1' 'strict post-switch verifier'
Assert-Literal $runner '-RequireTelegram' 'Telegram required after switch'
Assert-Literal $runner 'Final bot mode must remain PAUSE' 'final PAUSE guard'
Assert-Literal $runner 'Expected DISARMED' 'LIVE must finish disarmed'
Assert-NotContains $runner '(?<!dis)arm-phase7c-live-local\.ps1' 'runner must never ARM LIVE'
Assert-NotContains $runner 'order_send|/v1/orders[^?]' 'runner must not submit broker order mutations'

Assert-Literal $service 'XAUUSD-Phase7C-Account-Switch' 'API uses only fixed task name'
Assert-Literal $service 'PREFLIGHT_TTL_MS = 45_000' 'short-lived preflight token'
Assert-Literal $service 'crypto.randomUUID()' 'unpredictable preflight/request IDs'
Assert-Literal $service 'source: "LOCAL_WEB"' 'fixed request source'
Assert-Literal $service 'webCanArmLive: false' 'Web cannot ARM LIVE'
Assert-Literal $service 'armAfterLiveSwitch: false' 'no automatic ARM'
Assert-Literal $service 'botPaused: pause' 'PAUSE preflight'
Assert-Literal $service 'zeroXauusdPositions: noOpenPositions' 'flat broker preflight'
Assert-Literal $service 'noExecutionLock: !strategy.executionLock' 'execution lock preflight'
Assert-Literal $service 'schtasks.exe' 'fixed scheduled task invocation'
Assert-NotContains $service '(?<!dis)arm-phase7c-live|order_send' 'API service must not ARM or order-send'

Assert-Literal $route 'Account switching is restricted to localhost.' 'localhost API guard'
Assert-Literal $route '/preflight' 'preflight endpoint'
Assert-Literal $route '/execute' 'execute endpoint'
Assert-Literal $route '/status' 'status endpoint'
Assert-Literal $app '/api/v1/phase7c-account-switch' 'route mounted'

Assert-Contains $web 'preflight\?\.approved[\s\S]*?preflight\.preflightToken[\s\S]*?confirmation\s*===\s*requiredConfirmation' 'approved preflight, token and typed confirmation guard'
Assert-Literal $web 'disabled={!canExecute || executeMutation.isPending}' 'execute disabled until confirmation guard passes'
Assert-Literal $web 'if (window.confirm(message)) executeMutation.mutate();' 'separate final confirmation before execute'
Assert-Literal $web 'pauseMutation.mutate()' 'explicit separate PAUSE action'
Assert-Literal $web 'mode: "PAUSE"' 'pause action uses canonical PAUSE mode'
Assert-Literal $web 'SWITCH_TO_LIVE' 'typed LIVE confirmation UI'
Assert-Literal $web 'SWITCH_TO_DEMO' 'typed DEMO confirmation UI'
Assert-NotContains $web 'executePhase7CLiveArm|enablePhase7CAuto|/api/v1/phase7c/live-arm' 'switch UI must not arm LIVE or enable AUTO'
Assert-NotContains $web 'arm-phase7c-live|/arm' 'Web switch card must not expose ARM action'
Assert-Literal $page 'Phase7CAccountSwitchCard' 'account switch integrated into account/risk page'
Assert-Literal $router 'Phase7CAccountRiskPage' 'account/risk route uses guarded switch page'

Write-Host "PHASE7C_WEB_ACCOUNT_SWITCH_SOURCE_TEST=PASS"