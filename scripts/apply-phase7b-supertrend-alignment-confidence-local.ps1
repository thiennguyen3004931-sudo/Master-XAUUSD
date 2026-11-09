param(
  [string]$Remote = "origin",
  [string]$Branch = "phase4-risk-entry-compression",
  [int]$ApiPort = 3711
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ControllerPath = Join-Path $Root "scripts\run-phase7b-demo-controller.ts"
$RoutePath = Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts"
$DemoPagePath = Join-Path $Root "apps\web\src\pages\Phase7BDemoPage.tsx"
$GatePagePath = Join-Path $Root "apps\web\src\pages\Phase7BPatternCheckPage.tsx"
$TelegramPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-compact.mjs"
$TelegramWrapperPath = Join-Path $Root "scripts\run-phase7b-telegram-notifier-local.ps1"
$BridgeEnv = Join-Path $Root "packages\mt5-broker\bridge\.env.phase7b-demo"
$DemoDir = Join-Path $Root ".runtime\phase7b-demo-forward"

function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing file: $Path" }
  return [System.IO.File]::ReadAllText($Path)
}
function Write-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}
function Replace-IfPresent([string]$Text, [string]$Old, [string]$New) {
  if ($Text.Contains($Old)) { return $Text.Replace($Old, $New) }
  return $Text
}
function Sync-RemoteFile([string]$Relative, [string]$Destination) {
  $lines = @(& git show "${Remote}/${Branch}:$Relative")
  if ($LASTEXITCODE -ne 0) { throw "git show failed for $Relative" }
  Write-Text $Destination (($lines -join "`n") + "`n")
}

Push-Location $Root
try {
  & git fetch $Remote $Branch
  if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $LASTEXITCODE" }

  # ---------------------------------------------------------------------------
  # 1) DEMO controller: M15 + M5 Supertrend alignment is sufficient.
  #    Flip age remains informational only and is never an entry blocker.
  # ---------------------------------------------------------------------------
  $controller = Read-Text $ControllerPath
  $oldGate = "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"
  $newGate = "PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT"
  if (-not $controller.Contains($oldGate) -and -not $controller.Contains($newGate)) {
    throw "Controller does not contain the expected Phase 7B Supertrend gate. Apply phase7b forward sync v2 first."
  }

  $controller = $controller.Replace($oldGate, $newGate)
  $controller = $controller.Replace("M15_DUAL_PATTERN_SUPERTREND_M5_FLIP2_CANONICAL_RIDER", "M15_DUAL_PATTERN_M15_M5_SUPERTREND_ALIGNMENT_CANONICAL_RIDER")
  $controller = $controller.Replace("m5FlipAgeBars: number;", "m5FlipAgeBars: number | null;")
  $controller = [regex]::Replace(
    $controller,
    '(?m)^\s*if \(flipAge === null \|\| flipAge > 1\) return null;\s*$',
    '  // Flip age is informational only. M5 Supertrend direction alignment is sufficient for entry.'
  )
  $controller = $controller.Replace("M5_FLIP_2", "M5_ALIGNMENT")
  if ($controller -match 'if \(flipAge === null \|\| flipAge > 1\) return null') {
    throw "Controller still blocks entry by flip age."
  }
  Write-Text $ControllerPath $controller

  # ---------------------------------------------------------------------------
  # 2) API diagnostics: same gate semantics + Supertrend-line reaction quality.
  # ---------------------------------------------------------------------------
  $route = Read-Text $RoutePath
  if (-not $route.Contains($oldGate) -and -not $route.Contains($newGate)) {
    throw "Phase7B demo API route does not contain the expected synced Supertrend diagnostics."
  }
  $route = $route.Replace($oldGate, $newGate)
  $route = $route.Replace("M15_DUAL_PATTERN_SUPERTREND_M5_FLIP2_CANONICAL_RIDER", "M15_DUAL_PATTERN_M15_M5_SUPERTREND_ALIGNMENT_CANONICAL_RIDER")
  $route = $route.Replace("M15_SUPERTREND_10_3_PLUS_ALIGNED_FRESH_M5_FLIP_WITHIN_2_CLOSED_BARS", "M15_SUPERTREND_10_3_PLUS_M5_SUPERTREND_10_3_SAME_DIRECTION")

  $oldAlignment = @'
  const flipAge = wanted !== null && m5Index >= 1 ? phase7bFreshFlipAge(st5, m5Index, wanted) : null;
  const m5FreshAligned = Boolean(wanted !== null && d5 === wanted && flipAge !== null && flipAge <= 1);
  const matchedPatternSide = Boolean(wanted !== null && d15 === wanted && m5FreshAligned);
'@
  $newAlignment = @'
  const flipAge = wanted !== null && m5Index >= 1 ? phase7bFreshFlipAge(st5, m5Index, wanted) : null;
  const m5DirectionAligned = Boolean(wanted !== null && d5 === wanted);
  // Compatibility field retained for older UI clients. It now means M5 direction aligned;
  // flip age is informational only and does not affect entry eligibility.
  const m5FreshAligned = m5DirectionAligned;
  const matchedPatternSide = Boolean(wanted !== null && d15 === wanted && m5DirectionAligned);
  const m15Reaction = wanted === null ? null : phase7bTrendlineReaction(bars, index, wanted, 10, 3);
  const m5Reaction = wanted === null || m5Index < 0 ? null : phase7bTrendlineReaction(m5, m5Index, wanted, 10, 3);
  const reactionCount = Number(Boolean(m15Reaction?.reaction)) + Number(Boolean(m5Reaction?.reaction));
  const confidenceLevel = wanted === null
    ? "CHƯA_ĐÁNH_GIÁ"
    : reactionCount >= 2
      ? "RẤT_CAO"
      : reactionCount === 1
        ? "CAO"
        : "TIÊU_CHUẨN";
'@
  if ($route.Contains($oldAlignment)) {
    $route = $route.Replace($oldAlignment, $newAlignment)
  } elseif (-not $route.Contains("const m5DirectionAligned = Boolean")) {
    throw "API alignment block not found."
  }

  $route = $route.Replace(
    'reason = `${pattern.side} pattern + Supertrend M15 đạt nhưng M5 chưa cùng hướng với fresh flip trong 2 nến đóng gần nhất.`;',
    'reason = `${pattern.side} pattern + Supertrend M15 đạt nhưng Supertrend M5 chưa cùng hướng.`;'
  )
  $route = $route.Replace(
    '${pattern!.side} đủ Pattern + Supertrend M15 + M5_FLIP_2; FVG context hiện diện.',
    '${pattern!.side} đủ Pattern + Supertrend M15 + Supertrend M5 cùng hướng; FVG context hiện diện.'
  )
  $route = $route.Replace(
    '${pattern!.side} đủ Pattern + Supertrend M15 + M5_FLIP_2; FVG không hiện diện nhưng không chặn entry.',
    '${pattern!.side} đủ Pattern + Supertrend M15 + Supertrend M5 cùng hướng; FVG không hiện diện nhưng không chặn entry.'
  )

  if (-not $route.Contains("confidenceLevel:")) {
    $route = $route.Replace(
      "    m5FreshAligned: boolean;",
@'
    m5FreshAligned: boolean;
    m15SupertrendLine: number | null;
    m5SupertrendLine: number | null;
    m15TrendlineDistance: number | null;
    m5TrendlineDistance: number | null;
    m15TrendlineReaction: boolean;
    m5TrendlineReaction: boolean;
    confidenceLevel: "CHƯA_ĐÁNH_GIÁ" | "TIÊU_CHUẨN" | "CAO" | "RẤT_CAO";
'@
    )
  }

  $oldTrendReturn = @'
      m5FlipAgeBars: flipAge,
      m5FreshAligned,
'@
  $newTrendReturn = @'
      m5FlipAgeBars: flipAge,
      m5FreshAligned,
      m15SupertrendLine: m15Reaction?.line ?? null,
      m5SupertrendLine: m5Reaction?.line ?? null,
      m15TrendlineDistance: m15Reaction?.distance ?? null,
      m5TrendlineDistance: m5Reaction?.distance ?? null,
      m15TrendlineReaction: Boolean(m15Reaction?.reaction),
      m5TrendlineReaction: Boolean(m5Reaction?.reaction),
      confidenceLevel,
'@
  if ($route.Contains($oldTrendReturn)) {
    $route = $route.Replace($oldTrendReturn, $newTrendReturn)
  } elseif (-not $route.Contains("m15TrendlineReaction:")) {
    throw "API trend return block not found."
  }

  if (-not $route.Contains("function phase7bTrendlineReaction(")) {
    $marker = "function detectEntryPattern("
    $position = $route.IndexOf($marker)
    if ($position -lt 0) { throw "API detectEntryPattern marker not found." }
    $reactionHelpers = @'
function phase7bTrendlineReaction(
  bars: M15Bar[],
  index: number,
  wanted: 1 | -1,
  period: number,
  multiplier: number,
): { line: number | null; distance: number | null; threshold: number | null; reaction: boolean } {
  const detail = phase7bSupertrendDetail(bars, period, multiplier);
  const line = detail.line[index] ?? null;
  const atr = detail.atr[index] ?? null;
  if (line === null || atr === null || detail.direction[index] !== wanted) {
    return { line: null, distance: null, threshold: null, reaction: false };
  }
  const bar = bars[index]!;
  const probe = wanted === 1 ? bar.low : bar.high;
  const distance = Math.abs(probe - line);
  // "Gần sát" is confidence-only: within 20% ATR, bounded to 0.50–2.00 XAUUSD price.
  const threshold = Math.min(2, Math.max(0.5, atr * 0.2));
  const near = distance <= threshold + 1e-9;
  const reaction = wanted === 1
    ? near && bar.close > line && bar.close > bar.open
    : near && bar.close < line && bar.close < bar.open;
  return {
    line: round(line, 5),
    distance: round(distance, 5),
    threshold: round(threshold, 5),
    reaction,
  };
}

function phase7bSupertrendDetail(
  bars: M15Bar[],
  period: number,
  multiplier: number,
): { direction: Array<1 | -1 | null>; line: Array<number | null>; atr: Array<number | null> } {
  const tr = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - bars[index - 1]!.close),
        Math.abs(bar.low - bars[index - 1]!.close),
      ));
  const atr: Array<number | null> = Array(bars.length).fill(null);
  if (bars.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i += 1) sum += tr[i]!;
    atr[period - 1] = sum / period;
    for (let i = period; i < bars.length; i += 1) {
      atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
    }
  }
  const upper: Array<number | null> = Array(bars.length).fill(null);
  const lower: Array<number | null> = Array(bars.length).fill(null);
  const direction: Array<1 | -1 | null> = Array(bars.length).fill(null);
  const line: Array<number | null> = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const a = atr[i];
    if (a === null) continue;
    const hl2 = (bar.high + bar.low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null || direction[i - 1] === null) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      direction[i] = bar.close >= hl2 ? 1 : -1;
      line[i] = direction[i] === 1 ? lower[i] : upper[i];
      continue;
    }
    const previous = bars[i - 1]!;
    const prevUpper = upper[i - 1]!;
    const prevLower = lower[i - 1]!;
    upper[i] = basicUpper < prevUpper || previous.close > prevUpper ? basicUpper : prevUpper;
    lower[i] = basicLower > prevLower || previous.close < prevLower ? basicLower : prevLower;
    let d = direction[i - 1]!;
    if (d === 1 && bar.close < lower[i]!) d = -1;
    else if (d === -1 && bar.close > upper[i]!) d = 1;
    direction[i] = d;
    line[i] = d === 1 ? lower[i] : upper[i];
  }
  return { direction, line, atr };
}

'@
    $route = $route.Substring(0, $position) + $reactionHelpers + $route.Substring($position)
  }

  if ($route.Contains("fresh flip trong 2 nến đóng gần nhất")) {
    throw "API still contains fresh-flip entry blocking reason."
  }
  Write-Text $RoutePath $route

  # ---------------------------------------------------------------------------
  # 3) Sync the latest Vietnamese gate UI and compact Telegram format.
  # ---------------------------------------------------------------------------
  Sync-RemoteFile "apps/web/src/pages/Phase7BPatternCheckPage.tsx" $GatePagePath
  Sync-RemoteFile "scripts/run-phase7b-telegram-notifier-compact.mjs" $TelegramPath

  # Forward monitor: remove fresh-flip gate wording without replacing local file.
  $demoPage = Read-Text $DemoPagePath
  $demoPage = $demoPage.Replace(
    'const currentM5Aligned = Boolean(managed && diagnostics?.trend.m5Supertrend === managed.side && diagnostics?.trend.m5FreshAligned);',
    'const currentM5Aligned = Boolean(managed && diagnostics?.trend.m5Supertrend === managed.side);'
  )
  $demoPage = $demoPage.Replace('label="Fresh flip M5"', 'label="Flip age M5 (tham khảo)"')
  $demoPage = $demoPage.Replace(
    'Được phép vào ${tenHuong(diagnostics.entry.side)} vì 2 mô hình nến + Supertrend M15 cùng hướng + M5 fresh flip ≤ 2 đều đạt. FVG chỉ là bối cảnh.',
    'Được phép vào ${tenHuong(diagnostics.entry.side)} vì mô hình nến + Supertrend M15 và Supertrend M5 cùng hướng + SL hợp lệ. Flip age và FVG chỉ là thông tin/bối cảnh.'
  )
  $demoPage = $demoPage.Replace(
    'Rule bắt buộc M5 cùng hướng và fresh flip không quá 2 nến đóng.',
    'Rule bắt buộc Supertrend M5 cùng hướng. Flip age chỉ để tham khảo.'
  )
  $demoPage = $demoPage.Replace(
    'M5 hiện tại {currentM5Aligned ? `vẫn cùng hướng ${tenHuong(managed.side)} và fresh` : "không còn đồng thuận fresh với hướng lệnh"}.',
    'Supertrend M5 hiện tại {currentM5Aligned ? `vẫn cùng hướng ${tenHuong(managed.side)}` : "không còn cùng hướng với lệnh"}.'
  )
  $demoPage = $demoPage.Replace(
    'DEMO sẵn sàng · Entry: 2 mô hình nến + Supertrend M15 + M5 fresh flip ≤ 2 · FVG chỉ là bối cảnh · +6 → hòa vốn · +10 → chốt 1/3.',
    'DEMO sẵn sàng · Entry: 2 mô hình nến + Supertrend M15/M5 đồng thuận + SL 6–10 giá · flip age/FVG chỉ là bối cảnh · +6 → hòa vốn · +10 → chốt 1/3.'
  )
  Write-Text $DemoPagePath $demoPage

  # Keep wrapper pointed to compact notifier; network retry is already built into remote compact notifier.
  $wrapper = Read-Text $TelegramWrapperPath
  foreach ($oldNotifier in @("run-phase7b-telegram-notifier.mjs", "run-phase7b-telegram-notifier-network.mjs")) {
    if ($wrapper.Contains($oldNotifier)) { $wrapper = $wrapper.Replace($oldNotifier, "run-phase7b-telegram-notifier-compact.mjs") }
  }
  Write-Text $TelegramWrapperPath $wrapper

  & node --check $TelegramPath
  if ($LASTEXITCODE -ne 0) { throw "Telegram syntax check failed: $LASTEXITCODE" }
  & node --check $ControllerPath
  if ($LASTEXITCODE -ne 0) { throw "Controller syntax check failed: $LASTEXITCODE" }

  & pnpm --filter @xauusd/api build
  if ($LASTEXITCODE -ne 0) { throw "API build failed: $LASTEXITCODE" }
  & pnpm --filter @xauusd/web build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed: $LASTEXITCODE" }

  Write-Host "PHASE7B_ALIGNMENT_PATCH=PASS"
  Write-Host "PHASE7B_ENTRY_GATE=PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT"
  Write-Host "PHASE7B_M5_FLIP_AGE=INFO_ONLY_NOT_GATE"
  Write-Host "PHASE7B_TRENDLINE_REACTION=CONFIDENCE_ONLY"
  Write-Host "PHASE7B_CONFIDENCE_LEVELS=TIÊU_CHUẨN,CAO,RẤT_CAO"
  Write-Host "PHASE7B_TRENDLINE_NEAR=20_PERCENT_ATR_CLAMP_0.50_TO_2.00_PRICE"
  Write-Host "PHASE7B_FVG_ENTRY_GATE=False"
  Write-Host "PHASE7B_REAL_ACCOUNT_ALLOWED=False"
  Write-Host "PHASE7B_BUILD=PASS"

  # ---------------------------------------------------------------------------
  # 4) Restart only API 3711 so web diagnostics use the new rule.
  # ---------------------------------------------------------------------------
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
  if ([string]::IsNullOrWhiteSpace($ApiKey)) { throw "Missing MT5_API_KEY." }
  if ([string]$values["MT5_ALLOW_REAL_ACCOUNT"] -match '^(?i:true|1|yes|on)$') { throw "Helper refuses real account opt-in." }
  $BridgeHost = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_HOST"])) { "127.0.0.1" } else { [string]$values["MT5_BRIDGE_HOST"] }
  $BridgePort = if ([string]::IsNullOrWhiteSpace([string]$values["MT5_BRIDGE_PORT"])) { "8765" } else { [string]$values["MT5_BRIDGE_PORT"] }
  $BridgeBase = "http://${BridgeHost}:${BridgePort}"
  $health = Invoke-RestMethod -Uri "$BridgeBase/health" -Headers @{ "x-mt5-api-key" = $ApiKey } -TimeoutSec 8
  if (-not $health.connected -or $health.accountMode -ne "demo") { throw "Bridge is not connected to DEMO." }

  $listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
  $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($processId in $pids) { taskkill /PID $processId /T /F | Out-Null }
  Start-Sleep -Seconds 1

  $ApiLauncher = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$Root'
`$env:PORT = '$ApiPort'
`$env:HOST = '127.0.0.1'
`$env:MT5_BRIDGE_ENABLED = 'true'
`$env:MT5_BRIDGE_BASE_URL = '$BridgeBase'
`$env:MT5_BRIDGE_API_KEY = '$ApiKey'
`$env:EXECUTION_WORKER_EXECUTION_ENABLED = 'false'
`$env:PHASE7B_DEMO_WORK_DIR = '$DemoDir'
`$env:PHASE7B_LOCAL_CONTROL_ENABLED = 'true'
`$env:PHASE7B_FIXED_VOLUME = '0.03'
`$env:WEB_ORIGIN = 'http://127.0.0.1:5717'
pnpm --filter @xauusd/api dev
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ApiLauncher))
  $apiProcess = Start-Process powershell.exe -PassThru -ArgumentList @("-NoExit", "-EncodedCommand", $encoded)

  $ready = $false
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/v1/phase7b-demo" -TimeoutSec 3
      if ($snapshot.entryDiagnostics.entry.rule -eq $newGate) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { throw "Updated API did not expose the new alignment gate." }

  Write-Host "PHASE7B_API_RESTART=PASS"
  Write-Host "PHASE7B_API_RULE=$($snapshot.entryDiagnostics.entry.rule)"
  Write-Host "PHASE7B_BOT_RESTARTED=False"
  Write-Host "PHASE7B_TELEGRAM_RESTARTED=False"
  Write-Host "PHASE7B_WEB_RESTARTED=False"
  Write-Host "PHASE7B_BOT_RESTART_REQUIRED_IF_ALREADY_RUNNING=True"
}
finally {
  Pop-Location
}
