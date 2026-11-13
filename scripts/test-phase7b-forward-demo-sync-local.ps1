param(
  [string]$WorkDir = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($WorkDir)) {
  $WorkDir = Join-Path $Root ".runtime"
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path

$checks = @(
  @{
    Path = "scripts\run-phase7b-demo-controller.ts"
    Tokens = @(
      "PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE",
      "PHASE7B_DEMO_M5_FLIP_AGE=REFERENCE_ONLY_NOT_ENTRY_GATE",
      "phase7BSupertrend(",
      'entryRule: "THREE_PATTERNS_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE"',
      "PHASE7B_DEMO_FVG_ENTRY_GATE=OFF",
      "PHASE7B_DEMO_PLUS6=SL_TO_ENTRY",
      "PHASE7B_DEMO_PLUS10=PARTIAL_ONE_THIRD"
    )
  },
  @{
    Path = "scripts\run-phase7b-demo-local.ps1"
    Tokens = @(
      'ZIQ_PRE_CLOSE_ENTRY_ENABLED = "true"',
      "PHASE7B_DEMO_PRE_CLOSE_ENTRY=ENABLED",
      '[switch]$ArmDemoTrading',
      'if (-not $ArmDemoTrading -and $Once) {',
      "PHASE7B_DEMO_ORDER_SEND=DISABLED_NOT_ARMED",
      'if ($health.accountMode -ne "demo") {'
    )
  },
  @{
    Path = "apps\api\src\routes\phase7b-demo.route.ts"
    Tokens = @(
      'rule: "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE"',
      "phase7BSupertrend",
      "m15Supertrend:",
      "m5Supertrend:",
      "requiredForEntry: false"
    )
  },
  @{
    Path = "apps\web\src\pages\Phase7BDemoPage.tsx"
    Tokens = @(
      "XAUUSD AI MASTER",
      "MT5 DASHBOARD",
      "Trend Executor",
      "Sideway Executor",
      "PANEL ORDER PERMISSION: NONE"
    )
  },
  @{
    Path = "scripts\run-phase7b-telegram-notifier.mjs"
    Tokens = @(
      "PHASE7B_TELEGRAM_ORDER_PERMISSION=NONE_READ_ONLY_JOURNAL_AND_MONITOR",
      "event.fvgConfirmedAtEntry",
      "journalFeeds"
    )
  }
)

foreach ($check in $checks) {
  $path = Join-Path $Root $check.Path

  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing file: $path"
  }

  $text = [System.IO.File]::ReadAllText($path)

  foreach ($token in $check.Tokens) {
    if (-not $text.Contains($token)) {
      throw "Missing canonical sync token '$token' in $($check.Path)"
    }
  }
}

$controllerText = [System.IO.File]::ReadAllText(
  (Join-Path $Root "scripts\run-phase7b-demo-controller.ts")
)

$apiText = [System.IO.File]::ReadAllText(
  (Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts")
)

$runnerText = [System.IO.File]::ReadAllText(
  (Join-Path $Root "scripts\run-phase7b-demo-local.ps1")
)

if ($controllerText.Contains(
  "PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"
)) {
  throw "Obsolete M5_FLIP_2 controller gate remains."
}

if ($controllerText.Contains(
  'entryRule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"'
)) {
  throw "Obsolete M5_FLIP_2 controller journal rule remains."
}

if ($apiText.Contains(
  'rule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"'
)) {
  throw "Obsolete M5_FLIP_2 API rule remains."
}

if ($runnerText.Contains(
  'ZIQ_PRE_CLOSE_ENTRY_ENABLED = "false"'
)) {
  throw "Obsolete disabled pre-close runtime configuration remains."
}

Push-Location $Root

try {
  & pnpm --filter @xauusd/risk-engine build

  if ($LASTEXITCODE -ne 0) {
    throw "risk-engine build failed: $LASTEXITCODE"
  }

  & pnpm --filter @xauusd/mt5-broker build

  if ($LASTEXITCODE -ne 0) {
    throw "mt5-broker build failed: $LASTEXITCODE"
  }
  & pnpm --filter @xauusd/api build

  if ($LASTEXITCODE -ne 0) {
    throw "api build failed: $LASTEXITCODE"
  }

  & pnpm --filter @xauusd/web build

  if ($LASTEXITCODE -ne 0) {
    throw "web build failed: $LASTEXITCODE"
  }

  $runnerPath = Join-Path $PSScriptRoot "run-phase7b-demo-local.ps1"
  $powershellExe = (Get-Process -Id $PID).Path

  $preflightStdoutPath =
    Join-Path $WorkDir "phase7b-demo-preflight.stdout.log"

  $preflightStderrPath =
    Join-Path $WorkDir "phase7b-demo-preflight.stderr.log"

  Remove-Item `
    -LiteralPath $preflightStdoutPath `
    -Force `
    -ErrorAction SilentlyContinue

  Remove-Item `
    -LiteralPath $preflightStderrPath `
    -Force `
    -ErrorAction SilentlyContinue

  Write-Host "PHASE7B_FORWARD_PREFLIGHT_PROCESS_MODE=START_PROCESS_REDIRECT"

  $preflightArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$runnerPath`"",
    "-WorkDir", "`"$WorkDir`"",
    "-FixedVolume", "0.03",
    "-Once"
  )

  $preflightProcess = Start-Process `
    -FilePath $powershellExe `
    -ArgumentList $preflightArgs `
    -NoNewWindow `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $preflightStdoutPath `
    -RedirectStandardError $preflightStderrPath

  $preflightExit = $preflightProcess.ExitCode

  $preflightStdout = if (
    Test-Path -LiteralPath $preflightStdoutPath
  ) {
    [System.IO.File]::ReadAllText(
      $preflightStdoutPath
    )
  } else {
    ""
  }

  $preflightStderr = if (
    Test-Path -LiteralPath $preflightStderrPath
  ) {
    [System.IO.File]::ReadAllText(
      $preflightStderrPath
    )
  } else {
    ""
  }

  $preflightText =
    $preflightStdout +
    "`n" +
    $preflightStderr

  if ($preflightStdout) {
    Write-Host $preflightStdout
  }

  if ($preflightStderr) {
    Write-Host $preflightStderr
  }

  Write-Host "PHASE7B_FORWARD_PREFLIGHT_EXIT=$preflightExit"

  if ($preflightExit -eq 0) {
    if (-not $preflightText.Contains(
      "PHASE7B_DEMO_ORDER_SEND=DISABLED_NOT_ARMED"
    )) {
      throw "DEMO preflight exited 0 without proving order send disabled."
    }

    if (-not $preflightText.Contains(
      "PHASE7B_DEMO_ACCOUNT_MODE=demo"
    )) {
      throw "DEMO preflight exited 0 without proving DEMO account mode."
    }

    Write-Host "PHASE7B_FORWARD_RUNTIME_PREFLIGHT=DEMO_READ_ONLY_PASS"
  }
  elseif (
    $preflightText.Contains(
      "Phase 7B DEMO requires accountMode=demo, got real."
    )
  ) {
    if (-not $preflightText.Contains(
      "PHASE7B_DEMO_ARM_REQUESTED=False"
    )) {
      throw "LIVE refusal did not prove ArmDemoTrading=false."
    }

    Write-Host "PHASE7B_FORWARD_RUNTIME_PREFLIGHT=LIVE_EXPECTED_GUARD_PASS"
    Write-Host "PHASE7B_FORWARD_LIVE_ORDER_SEND=NOT_ATTEMPTED"
  }
  else {
    throw "DEMO read-only preflight failed unexpectedly: $preflightExit"
  }
}
finally {
  Pop-Location
}

Write-Host "PHASE7B_FORWARD_SYNC_TEST=PASS"
Write-Host "PHASE7B_FORWARD_ENTRY=THREE_PATTERNS_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE"
Write-Host "PHASE7B_FORWARD_M5_FLIP_AGE=REFERENCE_ONLY"
Write-Host "PHASE7B_FORWARD_FVG_ENTRY_GATE=False"
Write-Host "PHASE7B_FORWARD_PRE_CLOSE_ENTRY=ENABLED"
Write-Host "PHASE7B_FORWARD_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_FORWARD_ORDER_SEND=DISABLED_DURING_SELFTEST"
