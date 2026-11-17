param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression",
  [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Push-Location $Root
try {
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

  $paths = @(
    "apps/api/src/routes/phase7b-ops.route.ts",
    "apps/web/src/pages/Phase7BOpsPage.tsx",
    "apps/web/src/pages/Phase7BDemoPage.tsx",
    "apps/web/src/pages/Phase7BPatternCheckPage.tsx",
    "apps/web/src/pages/SystemPage.tsx",
    "apps/web/src/ui/DashboardLayout.tsx",
    "apps/web/src/router.tsx",
    "apps/web/vite.config.ts",
    "scripts/refresh-phase7b-demo-console-local.ps1"
  )

  foreach ($relative in $paths) {
    $spec = "${Remote}/${Branch}:$relative"
    $lines = @(& git show $spec)
    if ($LASTEXITCODE -ne 0) { throw "git show failed for $relative" }
    $text = ($lines -join "`n") + "`n"
    $target = Join-Path $Root ($relative -replace '/', '\')
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    [System.IO.File]::WriteAllText($target, $text, $Utf8NoBom)
    Write-Host "PHASE7B_CONSOLE_SYNC=$relative"
  }

  $layout = [System.IO.File]::ReadAllText((Join-Path $Root "apps\web\src\ui\DashboardLayout.tsx"))
  $router = [System.IO.File]::ReadAllText((Join-Path $Root "apps\web\src\router.tsx"))
  $monitor = [System.IO.File]::ReadAllText((Join-Path $Root "apps\web\src\pages\Phase7BDemoPage.tsx"))
  $opsPage = [System.IO.File]::ReadAllText((Join-Path $Root "apps\web\src\pages\Phase7BOpsPage.tsx"))
  $opsRoute = [System.IO.File]::ReadAllText((Join-Path $Root "apps\api\src\routes\phase7b-ops.route.ts"))

  foreach ($old in @("RESEARCH", "LEGACY", "Canonical Backtest", "Risk & Auto Lot")) {
    if ($layout.Contains($old)) { throw "Old navigation token remains: $old" }
  }
  foreach ($old in @("phase7c-", "phase7d-", "phase7e-", "legacy-overview", 'path: "signals"', 'path: "risk"', 'path: "ai"')) {
    if ($router.Contains($old)) { throw "Old route token remains: $old" }
  }
  foreach ($old in @("Pattern + MA", "MA20/50/200", 'label="MA trend"', 'label="MA20"', 'label="MA50"', 'label="MA200"', "FVG add-on")) {
    if ($monitor.Contains($old)) { throw "Old monitor rule remains: $old" }
  }

  foreach ($required in @("BẬT BOT DEMO", "DỪNG BOT DEMO", "BẬT TELEGRAM", "TẮT TELEGRAM")) {
    if (-not $opsPage.Contains($required)) { throw "Missing control button: $required" }
  }
  foreach ($required in @('/bot/start', '/bot/stop', '/telegram/start', '/telegram/stop', 'BOT_STOP_BLOCKED_MANAGED_POSITION')) {
    if (-not $opsRoute.Contains($required)) { throw "Missing local control endpoint/token: $required" }
  }

  Write-Host "PHASE7B_CONSOLE_UI_CLEANUP=PASS"
  Write-Host "PHASE7B_CONSOLE_MENU=FORWARD_MONITOR,LIVE_ENTRY_GATE,BOT_TELEGRAM,PERFORMANCE,SYSTEM_HEALTH"
  Write-Host "PHASE7B_CONSOLE_OLD_RESEARCH_UI=REMOVED_FROM_ROUTER_AND_NAV"
  Write-Host "PHASE7B_CONSOLE_OLD_MA_ENTRY_UI=REMOVED"
  Write-Host "PHASE7B_CONSOLE_BOT_BUTTONS=ON,OFF"
  Write-Host "PHASE7B_CONSOLE_TELEGRAM_BUTTONS=ON,OFF"
  Write-Host "PHASE7B_CONSOLE_REAL_ACCOUNT_ALLOWED=False"

  if (-not $SkipRestart) {
    & (Join-Path $Root "scripts\refresh-phase7b-demo-console-local.ps1")
  }
}
finally {
  Pop-Location
}
