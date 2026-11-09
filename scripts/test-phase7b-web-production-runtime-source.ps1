$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeScript = Join-Path $ProjectRoot "scripts\run-phase7b-web-autostart.ps1"
$ViteConfig = Join-Path $ProjectRoot "apps\web\vite.config.ts"

if (-not (Test-Path -LiteralPath $RuntimeScript)) { throw "Runtime script not found: $RuntimeScript" }
if (-not (Test-Path -LiteralPath $ViteConfig)) { throw "Vite config not found: $ViteConfig" }

$RuntimeSource = Get-Content -LiteralPath $RuntimeScript -Raw
$ViteSource = Get-Content -LiteralPath $ViteConfig -Raw
[void][scriptblock]::Create($RuntimeSource)

function Assert-RuntimeLiteral([string]$Text, [string]$Label) {
  if ($RuntimeSource.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing production runtime marker: $Label"
  }
}
function Assert-ViteLiteral([string]$Text, [string]$Label) {
  if ($ViteSource.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing Vite production proxy marker: $Label"
  }
}
function Assert-RuntimeNotMatch([string]$Pattern, [string]$Label) {
  if ($RuntimeSource -match $Pattern) { throw "Forbidden runtime pattern detected: $Label" }
}

Assert-RuntimeLiteral 'apps\web\dist\index.html' 'built dist requirement'
Assert-RuntimeLiteral "--filter '@xauusd/web' build" 'recovery build when dist is missing'
Assert-RuntimeLiteral 'pnpm --filter @xauusd/web preview -- --host 127.0.0.1' 'production preview server'
Assert-RuntimeLiteral 'VITE_DEV_API_PROXY_TARGET' 'runtime API proxy target'
Assert-RuntimeLiteral 'PHASE7B_WEB_RUNTIME=PRODUCTION_PREVIEW' 'runtime mode marker'
Assert-RuntimeNotMatch 'pnpm\s+--filter\s+@xauusd/web\s+dev\b' 'must not run Vite dev server'
Assert-RuntimeNotMatch 'activate-phase7c-local\.ps1|run-phase7c-executors|LIVE_EXECUTION|MT5_ALLOW_REAL_ACCOUNT' 'must not mutate trading runtime safety'

Assert-ViteLiteral 'process.env.VITE_API_BASE_URL' 'API base fallback for proxy target'
Assert-ViteLiteral 'preview:' 'preview configuration'
Assert-ViteLiteral 'proxy: apiProxy' 'shared API proxy for preview runtime'

Write-Host "PHASE7B_WEB_PRODUCTION_RUNTIME_SOURCE_TEST=PASS"
