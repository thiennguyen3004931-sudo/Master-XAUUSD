$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeSource = Join-Path $ProjectRoot "apps\web\src\ui\VietnameseLocalizationRuntime.tsx"
$AppSource = Join-Path $ProjectRoot "apps\web\src\App.tsx"
$MainSource = Join-Path $ProjectRoot "apps\web\src\main.tsx"

if (-not (Test-Path -LiteralPath $RuntimeSource)) { throw "Vietnamese localization runtime source missing." }
if (-not (Test-Path -LiteralPath $AppSource)) { throw "App source missing." }
if (-not (Test-Path -LiteralPath $MainSource)) { throw "Main source missing." }

$Runtime = Get-Content -LiteralPath $RuntimeSource -Raw
$App = Get-Content -LiteralPath $AppSource -Raw
$Main = Get-Content -LiteralPath $MainSource -Raw

function Assert-Literal([string]$Source, [string]$Text, [string]$Label) {
  if ($Source.IndexOf($Text, [System.StringComparison]::Ordinal) -lt 0) {
    throw "Missing localization performance marker: $Label"
  }
}

Assert-Literal $Runtime 'data-no-vi-localize' 'legacy full-body observer suppression'
Assert-Literal $Runtime 'requestIdleCallback' 'idle-time localization scheduling'
Assert-Literal $Runtime 'new Set<Node>()' 'mutation deduplication queue'
Assert-Literal $Runtime 'performance.now() - started > 6' 'short main-thread processing budget'
Assert-Literal $Runtime 'observer.observe(root' 'root-scoped observer'
Assert-Literal $Runtime 'lastTextValue = new WeakMap<Node, string>()' 'self-mutation text cache'
Assert-Literal $Runtime 'normalizePriceLabels' 'repeated price label cleanup'
Assert-Literal $Runtime 'PRICE_BID_TOKEN' 'Bid localization protection'
Assert-Literal $Runtime 'PRICE_ASK_TOKEN' 'Ask localization protection'
Assert-Literal $Main 'document.body.setAttribute("data-no-vi-localize", "runtime-managed")' 'legacy observer suppressed before React render'
Assert-Literal $App 'VietnameseLocalizationRuntime' 'runtime wrapper enabled'

if ($Runtime -match 'observer\.observe\(document\.body') {
  throw "Client localization runtime must not observe the whole document body."
}
if ($Runtime -match 'document\.body\.removeAttribute\("data-no-vi-localize"\)') {
  throw "Client localization runtime must not re-enable the legacy full-body observer on cleanup."
}

Write-Host "PHASE7C_WEB_CLIENT_LOCALIZATION_RUNTIME_TEST=PASS"
