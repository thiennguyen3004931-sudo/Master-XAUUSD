$ErrorActionPreference = "Stop"

$Wrapper = Join-Path $PSScriptRoot "run-phase7b-telegram-notifier-local.ps1"
if (-not (Test-Path -LiteralPath $Wrapper -PathType Leaf)) { throw "Missing wrapper: $Wrapper" }

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-PathEndsWith([string]$Actual, [string]$ExpectedSuffix, [string]$Message) {
  $normalizedActual = $Actual.Replace('\', '/').TrimEnd('/')
  $normalizedExpected = $ExpectedSuffix.Replace('\', '/').TrimStart('/')
  Assert-True ($normalizedActual.EndsWith($normalizedExpected, [System.StringComparison]::OrdinalIgnoreCase)) "$Message`nExpected suffix: $normalizedExpected`nActual: $normalizedActual"
}

function Test-Mode([ValidateSet("DEMO", "LIVE")] [string]$Mode) {
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("phase7c-wrapper-{0}-{1}" -f $Mode.ToLowerInvariant(), [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $envFile = Join-Path $root "telegram.env"
  $runtimeFile = Join-Path $root "trade-notifier-runtime.json"
  $sinkFile = Join-Path $root "dry-run.jsonl"

  @(
    "ZIQ_TELEGRAM_BOT_TOKEN=synthetic-token-not-used",
    "ZIQ_TELEGRAM_CHAT_ID=synthetic-chat-not-used",
    "ZIQ_TELEGRAM_DRY_RUN=true",
    "ZIQ_TELEGRAM_DRY_RUN_SINK=$sinkFile",
    "ZIQ_TELEGRAM_SEND_STARTUP=false",
    "ZIQ_TELEGRAM_REPLAY_EXISTING=true",
    "ZIQ_TELEGRAM_MONITOR_API_URL=http://127.0.0.1:9"
  ) | Set-Content -LiteralPath $envFile -Encoding utf8

  try {
    # Write-Host uses the information stream in PowerShell Core, so capture all
    # streams to verify the wrapper's explicit PASS and safety markers.
    $output = & $Wrapper -WorkDir $root -EnvFile $envFile -AccountMode $Mode -RuntimeFile $runtimeFile -IntervalSeconds 1 -Once *>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE) "$Mode wrapper returned a non-zero native exit code: $LASTEXITCODE`n$output"
    Assert-True ($output.Contains('PHASE7B_TELEGRAM_WRAPPER_TEST_EXIT=PASS')) "$Mode wrapper did not complete one-shot successfully.`n$output"
    Assert-True (Test-Path -LiteralPath $runtimeFile -PathType Leaf) "$Mode wrapper runtime file was not created"

    $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    Assert-True ([string]$runtime.status -eq 'STOPPED') "$Mode wrapper runtime must end STOPPED after -Once"
    Assert-True ([string]$runtime.accountMode -eq $Mode) "$Mode wrapper runtime accountMode mismatch"
    Assert-True ([string]$runtime.orderPermission -eq 'NONE') "$Mode wrapper must remain orderPermission=NONE"

    if ($Mode -eq 'LIVE') {
      Assert-PathEndsWith ([string]$runtime.trendJournal) 'phase7b-live-forward/phase7b-demo-events.jsonl' 'LIVE Trend journal mapping is incorrect'
      Assert-PathEndsWith ([string]$runtime.sidewayJournal) 'phase7c-sideway-live-forward/phase7c-sideway-events.jsonl' 'LIVE Sideway journal mapping is incorrect'
    } else {
      Assert-PathEndsWith ([string]$runtime.trendJournal) 'phase7b-demo-forward/phase7b-demo-events.jsonl' 'DEMO Trend journal mapping is incorrect'
      Assert-PathEndsWith ([string]$runtime.sidewayJournal) 'phase7c-sideway-forward/phase7c-sideway-events.jsonl' 'DEMO Sideway journal mapping is incorrect'
    }

    Assert-True (Test-Path -LiteralPath ([string]$runtime.trendJournal) -PathType Leaf) "$Mode Trend journal should be registered even before the first controller event"
    Assert-True (Test-Path -LiteralPath ([string]$runtime.sidewayJournal) -PathType Leaf) "$Mode Sideway journal should be registered even before the first controller event"
    Assert-True (-not $output.Contains('/v1/orders')) "$Mode wrapper output must not contain an order endpoint"
    Write-Host "PHASE7C_TRADE_NOTIFIER_WRAPPER_${Mode}=PASS"
  }
  finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Test-Mode LIVE
Test-Mode DEMO
Write-Host "PHASE7C_TRADE_NOTIFIER_WRAPPER_TEST=PASS"
