param(
  [int]$ApiPort = 3711,
  [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ControllerPath = Join-Path $Root "scripts\run-phase7b-demo-controller.ts"
$RoutePath = Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts"
$GatePagePath = Join-Path $Root "apps\web\src\pages\Phase7BPatternCheckPage.tsx"
$DemoPagePath = Join-Path $Root "apps\web\src\pages\Phase7BDemoPage.tsx"
$TelegramPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-compact.mjs"
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$DemoDir = Join-Path $Root ".runtime\phase7b-demo-forward"

function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing file: $Path" }
  return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Insert-ThreeCandleDetector(
  [string]$Text,
  [string]$FunctionMarker,
  [string]$NextFunctionMarker,
  [bool]$ControllerShape
) {
  $start = $Text.IndexOf($FunctionMarker)
  if ($start -lt 0) { throw "Missing detector function: $FunctionMarker" }
  $next = $Text.IndexOf($NextFunctionMarker, $start)
  if ($next -lt 0) { throw "Missing function after detector: $NextFunctionMarker" }

  $detector = $Text.Substring($start, $next - $start)
  if ($detector.Contains("THREE_CANDLE_BODY_DOMINANCE")) { return $Text }

  $returnIndex = $Text.LastIndexOf("return null;", $next)
  if ($returnIndex -lt $start -or $returnIndex -ge $next) {
    throw "Could not locate detector final return null."
  }
  $lineStart = $Text.LastIndexOf("`n", $returnIndex)
  if ($lineStart -ge 0) { $returnIndex = $lineStart + 1 }

  if ($ControllerShape) {
    $block = @'
  // Three-candle body dominance: one opposite-colour candle, then three
  // consecutive same-colour candles. The first response body remains smaller
  // than the opposite body, while the sum of all three response bodies exceeds it.
  if (index >= 3) {
    const priorOpposite3 = bars[index - 3]!;
    const first3 = bars[index - 2]!;
    const second3 = bars[index - 1]!;
    const priorBody3 = bodySize(priorOpposite3);
    const firstBody3 = bodySize(first3);
    const combinedBody3 = firstBody3 + bodySize(second3) + bodySize(current);
    const firstBodyStillSmaller3 = firstBody3 < priorBody3;

    if (
      isBearish(priorOpposite3) &&
      isBullish(first3) &&
      isBullish(second3) &&
      isBullish(current) &&
      firstBodyStillSmaller3 &&
      combinedBody3 > priorBody3
    ) {
      return {
        side: "BUY",
        pattern: "THREE_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.min(priorOpposite3.low, first3.low, second3.low, current.low),
      };
    }

    if (
      isBullish(priorOpposite3) &&
      isBearish(first3) &&
      isBearish(second3) &&
      isBearish(current) &&
      firstBodyStillSmaller3 &&
      combinedBody3 > priorBody3
    ) {
      return {
        side: "SELL",
        pattern: "THREE_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.max(priorOpposite3.high, first3.high, second3.high, current.high),
      };
    }
  }

'@
  } else {
    $block = @'
  // Three-candle body dominance: same trigger semantics as the DEMO controller.
  if (index >= 3) {
    const priorOpposite3 = bars[index - 3]!;
    const first3 = bars[index - 2]!;
    const second3 = bars[index - 1]!;
    const priorBody3 = bodySize(priorOpposite3);
    const firstBody3 = bodySize(first3);
    const combinedBody3 = firstBody3 + bodySize(second3) + bodySize(current);
    const firstBodyStillSmaller3 = firstBody3 < priorBody3;

    if (
      isBearish(priorOpposite3) &&
      isBullish(first3) &&
      isBullish(second3) &&
      isBullish(current) &&
      firstBodyStillSmaller3 &&
      combinedBody3 > priorBody3
    ) {
      return {
        side: "BUY",
        name: "THREE_CANDLE_BODY_DOMINANCE",
        extreme: Math.min(priorOpposite3.low, first3.low, second3.low, current.low),
      };
    }

    if (
      isBullish(priorOpposite3) &&
      isBearish(first3) &&
      isBearish(second3) &&
      isBearish(current) &&
      firstBodyStillSmaller3 &&
      combinedBody3 > priorBody3
    ) {
      return {
        side: "SELL",
        name: "THREE_CANDLE_BODY_DOMINANCE",
        extreme: Math.max(priorOpposite3.high, first3.high, second3.high, current.high),
      };
    }
  }

'@
  }

  return $Text.Substring(0, $returnIndex) + $block + $Text.Substring($returnIndex)
}

Push-Location $Root
try {
  # -------------------------------------------------------------------------
  # A. DEMO controller: add a third trigger. Do not change M15/M5 ST alignment.
  # -------------------------------------------------------------------------
  $controller = Read-Text $ControllerPath
  if (-not $controller.Contains("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")) {
    throw "Controller is not on PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT."
  }

  if (-not $controller.Contains('type DemoPattern =')) {
    $oldDemoSignal = 'type DemoSignal = Phase7BSignal & {'
    if (-not $controller.Contains($oldDemoSignal)) {
      throw "DemoSignal type marker not found."
    }
    $controller = $controller.Replace(
      $oldDemoSignal,
@'
type DemoPattern = Phase7BSignal["pattern"] | "THREE_CANDLE_BODY_DOMINANCE";
type DemoSignal = Omit<Phase7BSignal, "pattern"> & {
  pattern: DemoPattern;
'@
    )
  }
  $controller = $controller.Replace('pattern: Phase7BSignal["pattern"];', 'pattern: DemoPattern;')
  $controller = Insert-ThreeCandleDetector $controller "function detectEntryPattern(" "async function managePosition(" $true

  if (-not $controller.Contains('pattern: "THREE_CANDLE_BODY_DOMINANCE"')) {
    throw "Controller did not receive THREE_CANDLE_BODY_DOMINANCE."
  }

  # Persist exact trigger fields in ENTRY_FILLED for Telegram reason reporting.
  if (-not $controller.Contains("entryPattern: signal.pattern")) {
    $filledRegex = New-Object System.Text.RegularExpressions.Regex('(?m)^(\s*journal\("ENTRY_FILLED", \{\s*\r?\n\s*signalId: signal\.id,\s*)$')
    $m = $filledRegex.Match($controller)
    if ($m.Success) {
      $indentMatch = [regex]::Match($m.Value, '(?m)^(\s*)signalId:')
      $indent = if ($indentMatch.Success) { $indentMatch.Groups[1].Value } else { "    " }
      $extra = "`r`n${indent}side: signal.side,`r`n${indent}pattern: signal.pattern,`r`n${indent}entryPattern: signal.pattern,`r`n${indent}stopDistance: signal.stopDistance,`r`n${indent}m15SupertrendDirection: signal.m15SupertrendDirection,`r`n${indent}m5SupertrendDirection: signal.m5SupertrendDirection,`r`n${indent}m5FlipAgeBars: signal.m5FlipAgeBars,"
      $controller = $controller.Substring(0, $m.Index + $m.Length) + $extra + $controller.Substring($m.Index + $m.Length)
    }
  }
  Write-Text $ControllerPath $controller
  Write-Host "PHASE7B_THREE_CANDLE_CONTROLLER=PASS"

  # -------------------------------------------------------------------------
  # B. API: first repair pending V2 runtime fields, then add third detector.
  # -------------------------------------------------------------------------
  $route = Read-Text $RoutePath
  if (-not $route.Contains("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")) {
    throw "API is not on PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT."
  }

  if ($route.Contains('confidenceLevel: "CHƯA_ĐÁNH_GIÁ"') -and -not $route.Contains("m15SupertrendLine: m15Reaction?.line ?? null")) {
    $payloadRegex = New-Object System.Text.RegularExpressions.Regex('(?m)^(?<indent>[ \t]*)m5FreshAligned,[ \t]*\r?$')
    $payloadMatch = $payloadRegex.Match($route)
    if (-not $payloadMatch.Success) {
      throw "Pending V2 payload repair marker m5FreshAligned was not found."
    }
    $indent = $payloadMatch.Groups["indent"].Value
    $fields = @(
      "${indent}m15SupertrendLine: m15Reaction?.line ?? null,",
      "${indent}m5SupertrendLine: m5Reaction?.line ?? null,",
      "${indent}m15TrendlineDistance: m15Reaction?.distance ?? null,",
      "${indent}m5TrendlineDistance: m5Reaction?.distance ?? null,",
      "${indent}m15TrendlineReaction: Boolean(m15Reaction?.reaction),",
      "${indent}m5TrendlineReaction: Boolean(m5Reaction?.reaction),",
      "${indent}confidenceLevel,"
    ) -join "`r`n"
    $insertAt = $payloadMatch.Index + $payloadMatch.Length
    $route = $route.Substring(0, $insertAt) + "`r`n" + $fields + $route.Substring($insertAt)
    Write-Host "PHASE7B_THREE_CANDLE_V2_PAYLOAD_REPAIR=PASS"
  }

  if ($route.Contains('type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";')) {
    $route = $route.Replace(
      'type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";',
      'type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE";'
    )
  } elseif (-not $route.Contains('type Phase7BPattern =') -or -not $route.Contains('"THREE_CANDLE_BODY_DOMINANCE"')) {
    throw "Phase7BPattern type could not be widened."
  }

  $route = $route.Replace("ENGULFING_OR_TWO_SAME_COLOR_BODY_DOMINANCE", "ENGULFING_OR_TWO_OR_THREE_CANDLE_BODY_DOMINANCE")
  $route = Insert-ThreeCandleDetector $route "function detectEntryPattern(" "function hasRelevantFvg(" $false

  $reasonRegex = New-Object System.Text.RegularExpressions.Regex('(?m)^\s*let reason = .*;\r?$')
  if ($reasonRegex.IsMatch($route)) {
    $route = $reasonRegex.Replace(
      $route,
      '  let reason = `Chưa có 1 trong 3 mô hình: Nến nhấn chìm, Hai nến thân chiếm ưu thế, hoặc Ba nến thân chiếm ưu thế.`;',
      1
    )
  }

  if (-not $route.Contains('name: "THREE_CANDLE_BODY_DOMINANCE"')) {
    throw "API did not receive THREE_CANDLE_BODY_DOMINANCE."
  }
  if ($route -match 'flipAge\s*>\s*1\s*\)\s*return\s+null') {
    throw "Flip age is still an entry blocker."
  }
  Write-Text $RoutePath $route
  Write-Host "PHASE7B_THREE_CANDLE_API_SOURCE=PASS"

  # -------------------------------------------------------------------------
  # C. Vietnamese UI.
  # -------------------------------------------------------------------------
  $gate = Read-Text $GatePagePath
  if (-not $gate.Contains('name === "THREE_CANDLE_BODY_DOMINANCE"')) {
    $anchor = '  if (name === "TWO_CANDLE_BODY_DOMINANCE") return "Hai nến thân chiếm ưu thế";'
    if (-not $gate.Contains($anchor)) { throw "Gate UI pattern label anchor not found." }
    $gate = $gate.Replace($anchor, $anchor + "`r`n" + '  if (name === "THREE_CANDLE_BODY_DOMINANCE") return "Ba nến thân chiếm ưu thế";')
  }
  $gate = $gate.Replace("một trong 2 mô hình nến", "một trong 3 mô hình nến")
  $gate = $gate.Replace("1 trong 2 mô hình nến", "1 trong 3 mô hình nến")
  $gate = $gate.Replace("Chờ nến nhấn chìm hoặc hai nến thân chiếm ưu thế", "Chờ nến nhấn chìm, hai nến hoặc ba nến thân chiếm ưu thế")
  Write-Text $GatePagePath $gate

  $demo = Read-Text $DemoPagePath
  if (-not $demo.Contains('name === "THREE_CANDLE_BODY_DOMINANCE"')) {
    $anchor = '  if (name === "TWO_CANDLE_BODY_DOMINANCE") return "Hai nến thân chiếm ưu thế";'
    if ($demo.Contains($anchor)) {
      $demo = $demo.Replace($anchor, $anchor + "`r`n" + '  if (name === "THREE_CANDLE_BODY_DOMINANCE") return "Ba nến thân chiếm ưu thế";')
    }
  }
  $demo = $demo.Replace("2 mô hình nến", "1 trong 3 mô hình nến")
  $demo = $demo.Replace("một trong 2 mô hình nến", "một trong 3 mô hình nến")
  Write-Text $DemoPagePath $demo
  Write-Host "PHASE7B_THREE_CANDLE_VI_UI=PASS"

  # -------------------------------------------------------------------------
  # D. Telegram. Patch local file only; preserve native HTTPS IPv4/retry fix.
  # -------------------------------------------------------------------------
  $telegram = Read-Text $TelegramPath
  if (-not $telegram.Contains('v === "THREE_CANDLE_BODY_DOMINANCE"')) {
    $anchor = '  if (v === "TWO_CANDLE_BODY_DOMINANCE" || v === "TWO_CANDLE") return "Hai nến thân chiếm ưu thế";'
    if (-not $telegram.Contains($anchor)) { throw "Telegram pattern label anchor not found." }
    $telegram = $telegram.Replace($anchor, $anchor + "`r`n" + '  if (v === "THREE_CANDLE_BODY_DOMINANCE" || v === "THREE_CANDLE") return "Ba nến thân chiếm ưu thế";')
  }
  $telegram = $telegram.Replace("1 trong 2 mô hình nến", "1 trong 3 mô hình nến")
  $telegram = $telegram.Replace("Chờ: 1 trong 3 mô hình nến + Supertrend M15 cùng hướng + M5 cùng hướng/fresh flip ≤ 2 nến đóng.", "Chờ: 1 trong 3 mô hình nến + Supertrend M15 và Supertrend M5 cùng hướng.")
  $telegram = $telegram.Replace("• M5 = MUA, fresh flip 1 nến đóng (≤ 2).", "• Supertrend M5 = MUA.")

  $reasonStart = $telegram.IndexOf("function entryReasonLines(")
  $reasonEnd = if ($reasonStart -ge 0) { $telegram.IndexOf("function applyEventState(", $reasonStart) } else { -1 }
  if ($reasonStart -lt 0 -or $reasonEnd -le $reasonStart) {
    throw "Telegram entryReasonLines block not found."
  }
  $newReason = @'
function entryReasonLines(event, live, side) {
  const d = live?.entryDiagnostics ?? null;
  const pattern = event.entryPattern ?? event.pattern ?? d?.pattern?.name ?? "Mô hình hợp lệ";
  const m15 = d?.trend?.m15Supertrend ?? (Number(event.m15SupertrendDirection) === -1 ? "SELL" : side);
  const m5 = d?.trend?.m5Supertrend ?? (Number(event.m5SupertrendDirection) === -1 ? "SELL" : side);
  const flipAge = numberOrNull(event.m5FlipAgeBars ?? d?.trend?.m5FlipAgeBars);
  const stopDistance = numberOrNull(event.stopDistance ?? d?.entry?.stopDistance);
  const confidence = d?.trend?.confidenceLevel ?? null;
  const lines = [
    `• ${patternLabel(pattern)} hướng ${side === "BUY" ? "MUA" : "BÁN"}.`,
    `• Supertrend M15 = ${m15 === "SELL" ? "BÁN" : "MUA"}.`,
    `• Supertrend M5 = ${m5 === "SELL" ? "BÁN" : "MUA"}.`,
    stopDistance === null ? "• Khoảng SL cấu trúc đã được controller chấp nhận." : `• SL cấu trúc hợp lệ ${stopDistance.toFixed(2)} giá.`,
    `• FVG: ${d?.fvg?.sameDirectionConfirmed || event.fvgConfirmedAtEntry ? "CÓ" : "KHÔNG"} · chỉ là bối cảnh.`,
  ];
  if (flipAge !== null) lines.push(`ℹ️ Flip age M5: ${flipAge} nến · chỉ tham khảo, không chặn lệnh.`);
  if (confidence && confidence !== "CHƯA_ĐÁNH_GIÁ") lines.push(`⭐ Độ tin cậy: ${String(confidence).replaceAll("_", " ")}.`);
  return lines;
}

'@
  $telegram = $telegram.Substring(0, $reasonStart) + $newReason + $telegram.Substring($reasonEnd)
  Write-Text $TelegramPath $telegram

  & node --check $TelegramPath
  if ($LASTEXITCODE -ne 0) { throw "Telegram syntax check failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_THREE_CANDLE_TELEGRAM=PASS"

  # -------------------------------------------------------------------------
  # E. Build API + Web. This proves the pending TS2740 repair is complete.
  # -------------------------------------------------------------------------
  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_THREE_CANDLE_API_BUILD=PASS"

  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }
  Write-Host "PHASE7B_THREE_CANDLE_WEB_BUILD=PASS"

  # -------------------------------------------------------------------------
  # F. DEMO bridge guard and API-only restart.
  # -------------------------------------------------------------------------
  if (-not (Test-Path $BridgeEnv)) { throw "Missing DEMO bridge env: $BridgeEnv" }
  $values = @{}
  foreach ($raw in Get-Content $BridgeEnv) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { continue }
    $i = $line.IndexOf("=")
    $name = $line.Substring(0, $i).Trim().TrimStart([char]0xFEFF)
    $value = $line.Substring($i + 1).Trim().Trim('"').Trim("'")
    $values[$name] = $value
  }

  $ApiKey = [string]$values["MT5_API_KEY"]
  if ([string]::IsNullOrWhiteSpace($ApiKey) -or $ApiKey.Length -lt 16) { throw "Invalid DEMO MT5_API_KEY." }
  if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "V6 refuses MT5_ALLOW_REAL_ACCOUNT=true." }
  $BridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
  $BridgeConfiguredPort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { [string]$BridgePort } else { [string]$values["MT5_BRIDGE_PORT"] }
  $BridgeBase = "http://${BridgeHost}:${BridgeConfiguredPort}"

  $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers @{ "x-mt5-api-key" = $ApiKey } -Method Get -TimeoutSec 8
  if (-not $health.connected -or $health.accountMode -ne "demo") { throw "Bridge is not connected to DEMO." }
  Write-Host "PHASE7B_THREE_CANDLE_BRIDGE=PASS"
  Write-Host "PHASE7B_THREE_CANDLE_ACCOUNT_LOGIN=$($health.accountLogin)"

  $listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($processId in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($processId -and $processId -ne $PID) {
      Write-Host "PHASE7B_THREE_CANDLE_STOP_API_PID=$processId"
      & taskkill /PID $processId /T /F | Out-Null
    }
  }
  Start-Sleep -Seconds 1

  $ApiLauncher = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$Root'
`$env:PORT = '$ApiPort'
`$env:HOST = '127.0.0.1'
`$env:MT5_BRIDGE_ENABLED = 'true'
`$env:MT5_BRIDGE_BASE_URL = '$BridgeBase'
`$env:MT5_BRIDGE_API_KEY = '$ApiKey'
`$env:MT5_BRIDGE_REQUEST_TIMEOUT_MS = '3000'
`$env:MT5_BRIDGE_HEALTH_TIMEOUT_MS = '1500'
`$env:EXECUTION_WORKER_EXECUTION_ENABLED = 'false'
`$env:PHASE7B_DEMO_WORK_DIR = '$DemoDir'
`$env:PHASE7B_LOCAL_CONTROL_ENABLED = 'true'
`$env:PHASE7B_FIXED_VOLUME = '0.03'
`$env:WEB_ORIGIN = 'http://127.0.0.1:5717'
pnpm --filter @xauusd/api dev
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ApiLauncher))
  $ApiProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $encoded)

  $snapshot = $null
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -Method Get -TimeoutSec 3
      if ($null -ne $snapshot) { break }
    } catch {}
  }
  if ($null -eq $snapshot) { throw "Updated API did not become ready on port $ApiPort." }

  Write-Host "PHASE7B_THREE_CANDLE_API=PASS"
  Write-Host "PHASE7B_THREE_CANDLE_PATTERN=THREE_CANDLE_BODY_DOMINANCE"
  Write-Host "PHASE7B_THREE_CANDLE_RULE=FIRST_BODY_LT_PRIOR_OPPOSITE_AND_THREE_BODY_SUM_GT_PRIOR_OPPOSITE"
  Write-Host "PHASE7B_ENTRY_PATTERNS=ENGULFING,TWO_CANDLE_BODY_DOMINANCE,THREE_CANDLE_BODY_DOMINANCE"
  Write-Host "PHASE7B_ENTRY_GATE=PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT_PLUS_SL_6_TO_10"
  Write-Host "PHASE7B_M5_FLIP_AGE=INFO_ONLY_NOT_GATE"
  Write-Host "PHASE7B_TRENDLINE_REACTION=CONFIDENCE_ONLY"
  Write-Host "PHASE7B_FVG_ENTRY_GATE=False"
  Write-Host "PHASE7B_THREE_CANDLE_BOT_RESTARTED=False"
  Write-Host "PHASE7B_THREE_CANDLE_TELEGRAM_RESTARTED=False"
  Write-Host "PHASE7B_THREE_CANDLE_WEB_RESTARTED=False"
  Write-Host "PHASE7B_REAL_ACCOUNT_ALLOWED=False"
  Write-Host "PHASE7B_THREE_CANDLE_V6=PASS"
}
finally {
  Pop-Location
}
