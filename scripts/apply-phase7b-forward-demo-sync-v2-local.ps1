param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BaseHelper = Join-Path $PSScriptRoot "apply-phase7b-forward-demo-sync-local.ps1"
if (-not (Test-Path $BaseHelper)) { throw "Missing base helper: $BaseHelper" }

& $BaseHelper

# Correct the one multiline controller label emitted by the base helper. This
# wrapper is the supported entrypoint; do not run the base helper directly.
$controller = Join-Path $Root "scripts\run-phase7b-demo-controller.ts"
$text = [System.IO.File]::ReadAllText($controller)
$literal = 'console.log("PHASE7B_DEMO_FIXED_TP=OFF");`nconsole.log("PHASE7B_DEMO_MA_ENTRY_FILTER=OFF");`nconsole.log("PHASE7B_DEMO_EMA_ENTRY_FILTER=OFF");`nconsole.log("PHASE7B_DEMO_HTF_HARD_TP=OFF");`nconsole.log("PHASE7B_DEMO_SIGNAL_DATA=CLOSED_M15_AND_CLOSED_M5_ONLY");'
$fixed = @'
console.log("PHASE7B_DEMO_FIXED_TP=OFF");
console.log("PHASE7B_DEMO_MA_ENTRY_FILTER=OFF");
console.log("PHASE7B_DEMO_EMA_ENTRY_FILTER=OFF");
console.log("PHASE7B_DEMO_HTF_HARD_TP=OFF");
console.log("PHASE7B_DEMO_SIGNAL_DATA=CLOSED_M15_AND_CLOSED_M5_ONLY");
'@
if ($text.Contains($literal)) {
  $text = $text.Replace($literal, $fixed.TrimEnd())
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($controller, $text, $utf8)
}

if ($text.Contains('`nconsole.log("PHASE7B_DEMO_MA_ENTRY_FILTER=OFF")')) {
  throw "Controller still contains literal backtick-n text."
}

Write-Host "PHASE7B_FORWARD_SYNC_V2=PASS"
Write-Host "PHASE7B_FORWARD_SUPPORTED_APPLY_HELPER=apply-phase7b-forward-demo-sync-v2-local.ps1"
